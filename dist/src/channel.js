import { randomUUID } from "node:crypto";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { accountEnabled, accountSection, defaultConnectorAccountId, listConnectorAccountIds, normalizeAccountId, } from "./accounts.js";
import { renderMessagePresentationFallbackText } from "openclaw/plugin-sdk/interactive-runtime";
import { CONVERSATION_ID, octopusMessageActions } from "./actions.js";
import { octopusApprovalCapability } from "./approvals.js";
import { admitOutboundDelivery, askOffered, notifyApproval, presentationOffered, reconcileOutboundReply, requestApproval, sendAgentPost, sendOutboundReply, uploadReplyFiles, watchQuestion, } from "./transport.js";
import { CHANNEL_DATA_KEY, channelDataPresentation, isObject, presentationReply, } from "./presentation.js";
import { askUserQuestionId, channelDataAsk, questionAsk, splitControls } from "./questions.js";
import { channelSecrets } from "../secret-contract-api.js";
import { octopusGateway } from "./gateway.js";
import { attachmentCount, withAttachmentsNote, withoutAttachments } from "./reply-attachments.js";
import { replyMediaUrls } from "./reply-media.js";
import { getTransportLifecycleStatus } from "./transport.js";
import { optionalString, pinnedRuntimeConfigIssue } from "./runtime-config.js";
import { octopusSetupContract } from "./setup.js";
const SECTION = "octopus-prime";
// What Octopus Prime draws of a reply's presentation (1.32.0).
const PRESENTATION_CAPABILITIES = Object.freeze({
    supported: true,
    context: true,
    divider: true,
    tables: true,
    charts: true,
    buttons: false,
    selects: false,
});
// A payload without core's presentation fields, which Octopus Prime gets in
// its own shape (channelData) instead.
function withoutPresentation(payload) {
    const { presentation: _presentation, presentationTextMode: _mode, ...rest } = payload;
    return rest;
}
// The payload with these fields added to its channelData for Octopus Prime.
function carrying(payload, fields) {
    const channelData = isObject(payload.channelData) ? payload.channelData : {};
    const own = isObject(channelData[CHANNEL_DATA_KEY]) ? channelData[CHANNEL_DATA_KEY] : {};
    return { ...payload, channelData: { ...channelData, [CHANNEL_DATA_KEY]: { ...own, ...fields } } };
}
/**
 * A reply rendered for Octopus Prime, or null for core's own plain text:
 * - an `ask_user` prompt (1.33.0), while the backend offers ask-user: its
 *   question as an `ask` (src/questions.ts), its words the prompt as core
 *   wrote it, which says the same;
 * - an agent's buttons and selects (1.33.0), likewise: an `ask` of kind
 *   buttons beside the rest of the card, or beside core's full plain text;
 * - a card (1.32.0), while the backend offers rich-presentation.
 */
function renderReply(params) {
    const { payload, presentation, sourcePresentation, accountId } = params;
    const rich = presentationOffered(accountId);
    const asks = askOffered(accountId);
    if (asks && askUserQuestionId(payload)) {
        const ask = questionAsk(payload, presentation);
        return ask ? carrying(withoutPresentation(payload), { ask }) : null;
    }
    const { ask, rest } = asks ? splitControls(presentation) : { ask: undefined, rest: presentation };
    // No control the apps act on (or none offered): the card as 1.32.0 sends
    // it, any approval and the like as its "Actions:" line.
    if (!ask)
        return rich ? presentationReply({ payload, presentation: rest, sourcePresentation }) : null;
    const card = rich && rest.blocks.length ? presentationReply({ payload, presentation: rest, sourcePresentation }) : null;
    if (card)
        return carrying(card, { ask });
    return carrying({
        ...withoutPresentation(payload),
        text: renderMessagePresentationFallbackText({ text: payload.text, presentation: sourcePresentation ?? presentation }),
    }, { ask });
}
// A reply's receipt: one message, or one per part of a long reply, in order.
function replyReceipt(messageIds, replyToId) {
    return {
        primaryPlatformMessageId: messageIds[0],
        platformMessageIds: messageIds,
        parts: messageIds.map((platformMessageId, index) => ({
            platformMessageId,
            kind: "text",
            index,
            ...(replyToId ? { replyToId } : {}),
        })),
        ...(replyToId ? { replyToId } : {}),
        sentAt: Date.now(),
    };
}
// How a send may read its files: core's validated media access, as given.
function mediaAccessOf(params) {
    return {
        ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}),
        ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
        ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    };
}
/**
 * Sends a reply, or a post, through the connector of the account core names
 * and returns core's result. A reply with files (1.11.0) first uploads them
 * (src/reply-media.ts), then names those the backend kept in its message, and
 * its text ends with the note of 1.8.0 counting the rest; it is never refused
 * or dropped for a file. A reply's card (1.32.0, src/presentation.ts) goes
 * with it to a backend that offers rich-presentation, when the reply is one
 * message (see the transport's sendOutboundReply), and so does its question
 * or buttons (1.33.0, src/questions.ts) to one that offers ask-user; an
 * `ask_user` question is then watched until it ends on the Gateway.
 */
async function sendReply(params, text, files, presentation, ask) {
    const channelId = params.to.trim();
    if (!channelId)
        throw new Error("An Octopus Prime conversation is required");
    // The plugin cuts a long reply into parts itself (sendOutboundReply), and
    // sends a reply's files with it, so core always hands it one durable part.
    if (params.deliveryPartCount !== undefined && params.deliveryPartCount !== 1) {
        throw new Error("Octopus Prime outbound currently supports one durable text part only");
    }
    // Core's queue id when the send is queued: core reconciles an unknown
    // outcome by it. A send outside the queue (a sub-agent's announce, or a
    // message tool send) gets a fresh id of its own (1.10.0).
    const outboundId = params.deliveryQueueId?.trim() || randomUUID();
    // The message it answers (a reply, or progress while its turn runs);
    // none for a send from another session, a sub-agent or a scheduled
    // wake, which the backend posts top-level as this connector's agent.
    const eventId = params.replyToId?.trim();
    let body = text;
    let kept;
    if (files && files.mediaUrls.length + files.unsent > 0) {
        const uploaded = await uploadReplyFiles({
            accountId: params.accountId,
            outboundId,
            channelId,
            ...(eventId ? { eventId } : {}),
            mediaUrls: files.mediaUrls,
            access: files.access,
            signal: params.signal,
            assertHandoff: params.assertDirectAdapterHandoff,
        });
        body = withAttachmentsNote(text, uploaded.failed + files.unsent);
        kept = {
            attachments: uploaded.fileIds,
            textWithoutFiles: withAttachmentsNote(text, files.mediaUrls.length + files.unsent),
        };
    }
    // Either leaves through the connector of the account core names, so it
    // reaches that account's organization only.
    const messageIds = eventId
        ? await sendOutboundReply({
            accountId: params.accountId,
            outboundId,
            eventId,
            channelId,
            text: body,
            ...kept,
            ...(presentation ? { presentation } : {}),
            ...(ask ? { ask } : {}),
            signal: params.signal,
            assertHandoff: params.assertDirectAdapterHandoff,
        })
        : await sendAgentPost({
            accountId: params.accountId,
            postId: outboundId,
            channelId,
            text: body,
            ...kept,
            ...(presentation ? { presentation } : {}),
            ...(ask ? { ask } : {}),
            signal: params.signal,
            assertHandoff: params.assertDirectAdapterHandoff,
        });
    if (ask?.kind === "question" && typeof ask.question_id === "string" && messageIds[0]) {
        watchQuestion({ accountId: params.accountId, questionId: ask.question_id, messageId: messageIds[0] });
    }
    // Core's queue settles a sent reply only after the @internal
    // onPlatformSendDispatch hook has recorded the send, so it is called
    // once the backend's receipts prove that every message of the reply
    // is stored. It is never called before then: with that evidence core
    // no longer replays an interrupted send (it retires one whose status
    // reads not_sent), so a reply cut off between its parts would stay
    // cut off. A replay is safe because the backend keeps at most one
    // message per outbound_id, and one file per reply and place.
    await params.onPlatformSendDispatch?.();
    return { messageId: messageIds[0], receipt: replyReceipt(messageIds, eventId) };
}
// The default account reads the channel's own fields; any other account its
// entry under `accounts` (src/accounts.ts).
export function resolveAccount(cfg, accountId) {
    const section = accountSection(cfg, accountId);
    const backendUrl = optionalString(section.backendUrl);
    const connectorToken = optionalString(section.connectorToken);
    return {
        accountId: normalizeAccountId(accountId),
        enabled: accountEnabled(cfg, accountId),
        ...(backendUrl ? { backendUrl } : {}),
        ...(connectorToken ? { connectorToken } : {}),
        ...(optionalString(section.connectorId) ? { connectorId: optionalString(section.connectorId) } : {}),
        ...(optionalString(section.orgId) ? { orgId: optionalString(section.orgId) } : {}),
    };
}
export const octopusPrimeChannel = createChatChannelPlugin({
    base: {
        id: SECTION,
        meta: {
            id: SECTION,
            label: "Octopus Prime",
            selectionLabel: "Octopus Prime",
            docsPath: "/channels/octopus-prime",
            blurb: "Durable outbound connector to Octopus Prime",
        },
        config: {
            listAccountIds: listConnectorAccountIds,
            defaultAccountId: defaultConnectorAccountId,
            resolveAccount,
            inspectAccount(cfg, accountId) {
                const account = resolveAccount(cfg, accountId);
                const issue = account.enabled ? pinnedRuntimeConfigIssue(account) : undefined;
                const lifecycle = getTransportLifecycleStatus(cfg, account.accountId);
                return {
                    enabled: account.enabled,
                    configured: !account.enabled || !issue,
                    tokenStatus: account.connectorToken ? "available" : "missing",
                    statusState: issue ? "unconfigured" : lifecycle.state,
                    restartPending: lifecycle.restartPending,
                    ...(issue ? { error: `${issue}. Run Octopus Prime setup, then restart this channel account.` } : {}),
                    ...(!issue && lifecycle.error ? { error: lifecycle.error } : {}),
                };
            },
            isConfigured(account) {
                return !account.enabled || !pinnedRuntimeConfigIssue(account);
            },
            unconfiguredReason(account) {
                const issue = pinnedRuntimeConfigIssue(account);
                return issue ? `${issue}. Run Octopus Prime setup, then restart this channel account.` : "";
            },
        },
        setupContract: octopusSetupContract,
        secrets: channelSecrets,
        gateway: octopusGateway,
        // Core resolves a message action's target before running it; a backend
        // conversation id is already one, so the current conversation resolves.
        messaging: {
            targetResolver: {
                looksLikeId: (raw) => CONVERSATION_ID.test(raw.trim()),
                hint: "<conversation id, ch_... or dm_...>",
            },
        },
        actions: octopusMessageActions,
        // Agents' approvals answered in the apps (1.31.0, src/approvals.ts): a
        // native approval surface for the conversation an approval was raised in,
        // started per account by src/gateway.ts, only while its owner turned it on.
        approvalCapability: octopusApprovalCapability({
            request: requestApproval,
            notify: notifyApproval,
            newRequestId: () => `apr-${randomUUID()}`,
        }),
        // Inline buttons in what agents are told of the message tool (1.33.0):
        // on while the account's backend offers ask-user, so OpenClaw stops
        // saying "Inline buttons OFF for octopus-prime" and shows agents how to
        // send them; their taps come back as the person's message.
        agentPrompt: {
            messageToolCapabilities: ({ accountId }) => (askOffered(accountId) ? ["inlineButtons"] : []),
        },
        message: {
            // Core sends a reply's files (1.11.0) in OpenClaw 2026.9.8 and 2026.10.3
            // alike: a reply with one file through `media` (its text as the
            // caption), one with several, or a voice note, whole through `payload`
            // (outbound.sendPayloadGroupsMedia), so a reply stays one message.
            send: {
                text: async (params) => sendReply(params, params.text),
                media: async (params) => sendReply(params, params.text, {
                    mediaUrls: replyMediaUrls({ mediaUrl: params.mediaUrl }),
                    unsent: 0,
                    access: mediaAccessOf(params),
                }),
                // A reply rendered with a card (1.32.0, renderPresentation below)
                // comes here too, the card in its channelData, checked again; and
                // with a question or buttons (1.33.0), or as an `ask_user` prompt
                // core sent as words, whose question is read here.
                payload: async (params) => {
                    const mediaUrls = replyMediaUrls(params.payload);
                    const text = typeof params.payload.text === "string" ? params.payload.text : params.text;
                    const ask = channelDataAsk(params.payload.channelData, CHANNEL_DATA_KEY) ?? questionAsk(params.payload);
                    return sendReply(params, text, {
                        mediaUrls,
                        // Attachments it names beyond its URLs, which core sends no file for.
                        unsent: Math.max(0, attachmentCount(params.payload) - mediaUrls.length),
                        access: mediaAccessOf(params),
                    }, channelDataPresentation(params.payload.channelData), ask);
                },
            },
            durableFinal: {
                capabilities: {
                    text: true,
                    media: true,
                    payload: true,
                    replyTo: true,
                    reconcileUnknownSend: true,
                },
                automaticUnknownSendReconciliation: true,
                admitDeferredDelivery: admitOutboundDelivery,
                // A reply with files is read back as one without: by the outbound ids
                // of its parts (reconcileOutboundReply).
                reconcileUnknownSendKinds: { text: true, media: true, payload: true },
                reconcileUnknownSend: async (ctx) => {
                    let result;
                    try {
                        result = await reconcileOutboundReply(ctx.queueId, ctx.accountId);
                    }
                    catch (error) {
                        // Still not ready after the wait window, socket closed or timed out:
                        // neither outcome is proven, so report unresolved (retryable) and
                        // never replay or drop.
                        return {
                            status: "unresolved",
                            error: error instanceof Error ? error.message : String(error),
                            retryable: true,
                        };
                    }
                    if (result.status === "not_sent")
                        return { status: "not_sent" };
                    return {
                        status: "sent",
                        messageId: result.messageIds[0],
                        receipt: replyReceipt(result.messageIds, ctx.effectiveReplyToId),
                    };
                },
            },
        },
    },
    // Every send to the conversation of the message a turn answers names that
    // message (its event id), whatever the config says: the final reply, and the
    // agent's message tool sends during the turn, which core then sends with it
    // as their parent (1.10.0). `topLevelReplyToMode` would name a config section
    // to read the mode from, and none exists, so core read "off".
    threading: { resolveReplyToMode: () => "all" },
    outbound: {
        base: {
            deliveryMode: "direct",
            // A reply's files go with it (1.11.0, message.send.media and payload). A
            // payload that names attachments with no URL core sends goes out as its
            // text and the note of 1.8.0, instead of core refusing it whole.
            normalizePayload: ({ payload }) => withoutAttachments(payload),
            // A reply with several files reaches message.send.payload whole, not
            // one message per file.
            sendPayloadGroupsMedia: true,
            // Rich replies (1.32.0): cards with a title and tone, text, context
            // lines, dividers, tables and charts. Buttons and selects only per
            // account (1.33.0, below); otherwise core turns them into context lines
            // ("Actions:") before rendering.
            presentationCapabilities: PRESENTATION_CAPABILITIES,
            // Tables and charts only while the account's backend offered
            // rich-presentation, buttons and selects (1.33.0) only while it offered
            // ask-user; otherwise core turns them into text first.
            resolvePresentationCapabilities: ({ accountId }) => {
                const offered = presentationOffered(accountId);
                const asks = askOffered(accountId);
                return { ...PRESENTATION_CAPABILITIES, tables: offered, charts: offered, buttons: asks, selects: asks };
            },
            // The card in the backend's shape, in channelData, with the full text
            // fallback as the reply's text (src/presentation.ts), and its question
            // or buttons (src/questions.ts); null, so core sends its own plain
            // text, for a backend that offered neither or a card it would refuse.
            renderPresentation: ({ payload, presentation, sourcePresentation, ctx }) => renderReply({ payload, presentation, sourcePresentation, accountId: ctx.accountId }),
        },
        attachedResults: {
            channel: SECTION,
            sendText: async () => {
                throw new Error("Octopus Prime outbound requires the durable message adapter");
            },
        },
    },
});
