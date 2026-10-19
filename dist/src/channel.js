import { randomUUID } from "node:crypto";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { accountEnabled, accountSection, defaultConnectorAccountId, listConnectorAccountIds, normalizeAccountId, } from "./accounts.js";
import { CONVERSATION_ID, octopusMessageActions } from "./actions.js";
import { admitOutboundDelivery, reconcileOutboundReply, sendAgentPost, sendOutboundReply, uploadReplyFiles, } from "./transport.js";
import { channelSecrets } from "../secret-contract-api.js";
import { octopusGateway } from "./gateway.js";
import { attachmentCount, withAttachmentsNote, withoutAttachments } from "./reply-attachments.js";
import { replyMediaUrls } from "./reply-media.js";
import { getTransportLifecycleStatus } from "./transport.js";
import { optionalString, pinnedRuntimeConfigIssue } from "./runtime-config.js";
import { octopusSetupContract } from "./setup.js";
const SECTION = "octopus-prime";
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
 * or dropped for a file.
 */
async function sendReply(params, text, files) {
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
            signal: params.signal,
            assertHandoff: params.assertDirectAdapterHandoff,
        })
        : await sendAgentPost({
            accountId: params.accountId,
            postId: outboundId,
            channelId,
            text: body,
            ...kept,
            signal: params.signal,
            assertHandoff: params.assertDirectAdapterHandoff,
        });
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
                payload: async (params) => {
                    const mediaUrls = replyMediaUrls(params.payload);
                    const text = typeof params.payload.text === "string" ? params.payload.text : params.text;
                    return sendReply(params, text, {
                        mediaUrls,
                        // Attachments it names beyond its URLs, which core sends no file for.
                        unsent: Math.max(0, attachmentCount(params.payload) - mediaUrls.length),
                        access: mediaAccessOf(params),
                    });
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
        },
        attachedResults: {
            channel: SECTION,
            sendText: async () => {
                throw new Error("Octopus Prime outbound requires the durable message adapter");
            },
        },
    },
});
