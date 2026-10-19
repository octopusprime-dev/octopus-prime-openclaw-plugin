import { buildAgentSessionKey } from "openclaw/plugin-sdk/core";
import { buildChannelInboundEventContext, } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { accountAgentIds, accountEnabled, accountSection, DEFAULT_ACCOUNT_ID, normalizeAccountId, withAccountConfig, } from "./accounts.js";
import { AUDIT_NOTICE, forgetAuditedSession, rememberAuditedSession } from "./audited-workspace.js";
import { rememberConversationSession } from "./channel-history.js";
import { LOG_INSTRUCTION, rememberProjectSession, startsNewSession, withLogBookContext, } from "./log-book.js";
import { resolvePinnedRuntimeConfig, sameRuntimeBinding, } from "./runtime-config.js";
import { createTurnWatch, turnAnswered, turnFailedNotice, } from "./turn-failure.js";
import { machineLoadLine } from "./machine-stats.js";
import { forgetTitledSession, rememberTitledSession } from "./session-title.js";
import { commandsAuthorized } from "./slash-commands.js";
import { createWorkingStatusGate } from "./working-status.js";
const CHANNEL = "octopus-prime";
/**
 * A final reply can run in another plugin registry than the Gateway's current
 * one (the agent turn's own registry, or one replaced by a reload), so core
 * hands it to the current registry before sending; without this callback core
 * refuses and the reply is lost. The reply must leave through the connector
 * that admitted the inbound message, so any other binding of that account
 * refuses the handoff. Another account's connector is never this reply's.
 */
function pinAdmittedConnector(cfg, accountId, admitted) {
    let current;
    try {
        current = resolvePinnedRuntimeConfig(accountSection(cfg, accountId));
    }
    catch { /* refused below */ }
    if (!accountEnabled(cfg, accountId) || !current || !sameRuntimeBinding(current, admitted)) {
        const message = "The Octopus Prime reply connector changed during this turn; delivery was not started.";
        throw new PlatformMessageNotDispatchedError(message, { cause: new Error(message), retryable: false });
    }
    return withAccountConfig(cfg, accountId, { connectorToken: admitted.connectorToken });
}
function timestamp(value) {
    if (!value)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * What the agent is told about the sender's account (1.6.0): the message was
 * sent from an Octopus Prime account that has two-step login on. The backend
 * says so in the frame (`sender.two_factor: true`), by how the account was
 * protected when the message was sent, and says nothing otherwise: an account
 * without it, a message another agent wrote, or a backend from before this.
 * So there is an entry only for `true`, and no entry means "not known to be".
 * OpenClaw gives the entry to the agent as a context block of its own, beside
 * the sender's ID and name and apart from the message's text: nothing typed
 * into a message can add or change it.
 */
export function senderProtection(frame) {
    if (frame.sender.two_factor !== true)
        return undefined;
    return {
        label: "Octopus Prime sender",
        source: CHANNEL,
        type: "sender_account",
        payload: { sender_id: frame.sender.id, two_step_login: true },
    };
}
/**
 * What the agent is told about its workspace (1.7.0): the organization's
 * owner turned "Audited workspace" on, so the owner and the auditors the
 * owner picked can read this conversation and every other one. The backend
 * says so in each message frame of such an organization (`audited: true`) and
 * says nothing otherwise: an organization that is not audited, or a backend
 * from before this. Agents acknowledge nothing; this entry is their notice,
 * in the words people are shown. Like the sender's entry above, OpenClaw
 * gives it to the agent as a context block of its own, apart from the
 * message's text: nothing typed into a message can add or change it.
 */
export function workspaceAudit(frame) {
    if (frame.audited !== true)
        return undefined;
    return {
        label: "Octopus Prime workspace",
        source: CHANNEL,
        type: "audited_workspace",
        payload: { audited: true, notice: AUDIT_NOTICE },
    };
}
/**
 * What every turn in a project's channel asks of its agent (1.13.0):
 * keep the project log (src/log-book.ts LOG_INSTRUCTION). The backend names
 * the project of such a message (`project_id`) only to a plugin that asked for
 * the log book, so a turn anywhere else carries nothing. Like the entries
 * above, a context block of its own: nothing typed into a message adds it.
 */
export function projectLog(frame) {
    if (!frame.project_id)
        return undefined;
    return {
        label: "Octopus Prime project log",
        source: CHANNEL,
        type: "project_log",
        payload: { instruction: LOG_INSTRUCTION },
    };
}
/**
 * What a fresh session's first message asks of its agent (1.24.0): the app
 * or the backend started a new session to go on from a full one, and posted
 * the continuation prompt there (`session_continuation: true`). The agent's
 * first reply starts with one line confirming it read the Project Log (a
 * project's session, whose log OpenClaw's new session got first) or the
 * summary the message carries. Only for a frame that says so; like the
 * entries above, a context block of its own: nothing typed into a message
 * adds it.
 */
export const CONTINUATION_PROJECT_INSTRUCTION = "This message continues earlier work in a fresh session. Start your first reply with one line confirming you read the Project Log (CONTEXT.md and MILESTONES.md).";
export const CONTINUATION_SUMMARY_INSTRUCTION = "This message continues earlier work in a fresh session. Start your first reply with one line confirming you read the summary in this message.";
export function sessionContinuation(frame) {
    if (frame.session_continuation !== true)
        return undefined;
    return {
        label: "Octopus Prime session continuation",
        source: CHANNEL,
        type: "session_continuation",
        payload: { instruction: frame.project_id ? CONTINUATION_PROJECT_INSTRUCTION : CONTINUATION_SUMMARY_INSTRUCTION },
    };
}
/**
 * What a turn woken by an edit tells its agent (1.26.0): the person edited
 * this message after sending it, and the edit @mentions the agent, which the
 * message had not reached before (`edited: true`, src/message-edited.ts). The
 * message's text is the edited one. Only for a frame that says so; like the
 * entries above, a context block of its own: nothing typed into a message
 * adds it.
 */
export const EDITED_INSTRUCTION = "The sender edited this message after sending it, and the edit mentions you, so you are getting it now. Answer the message as it reads now.";
export function messageEdited(frame) {
    if (frame.edited !== true)
        return undefined;
    return {
        label: "Octopus Prime edited message",
        source: CHANNEL,
        type: "message_edited",
        payload: { instruction: EDITED_INSTRUCTION },
    };
}
/**
 * While the computer running the Gateway has been under heavy load for a
 * while (1.27.0, src/machine-stats.ts), each turn asks its agent to go easy,
 * naming the load. Read on the Gateway, never from the message or the
 * backend; like the entries above, a context block of its own.
 */
export function machineLoad(stats) {
    if (!stats)
        return undefined;
    return {
        label: "Octopus Prime computer load",
        source: CHANNEL,
        type: "machine_load",
        payload: { instruction: machineLoadLine(stats) },
    };
}
/**
 * Where agents read how the app works (1.19.0):
 * the AI reference on the website, which is kept current. People are
 * told to ask their agent to teach them Octopus Prime, so every turn in every
 * conversation carries this one line. A context block of its own, like the
 * entries above: nothing typed into a message adds or changes it.
 */
export const APP_HELP_URL = "https://octopusprimeai.com/ai/";
export const APP_HELP_INSTRUCTION = `Octopus Prime help for agents: ${APP_HELP_URL} (read it when people ask how the app works).`;
export function appHelp() {
    return {
        label: "Octopus Prime help",
        source: CHANNEL,
        type: "app_help",
        payload: { instruction: APP_HELP_INSTRUCTION },
    };
}
/**
 * The OpenClaw session a conversation's turns run in: one per agent and
 * conversation, `agent:<agent>:octopus-prime:channel:<channel_id>` (a channel
 * peer keeps its id), so each new conversation is a fresh session. OpenClaw
 * keys a channel peer by channel and peer alone, so a named account (1.5.0)
 * goes between them, as OpenClaw's own per-account keys for direct messages
 * put it (`<channel>:<account>:direct:<peer>`):
 * `agent:<agent>:octopus-prime:<account>:channel:<channel_id>`. One
 * organization's conversations never share a session with another's, and the
 * default account's keys stay as they were. Core reads no delivery route from
 * such a key; a reply always names its conversation, and setup refuses
 * account names that core would read as a peer kind or a thread.
 */
export function octopusSessionKey(agentId, channelId, accountId) {
    const account = normalizeAccountId(accountId);
    const channel = account === DEFAULT_ACCOUNT_ID ? CHANNEL : `${CHANNEL}:${account}`;
    return buildAgentSessionKey({ agentId, channel, accountId: account, peer: { kind: "channel", id: channelId } });
}
export async function dispatchOctopusInbound(options) {
    const { api, frame, lifecycle } = options;
    const accountId = normalizeAccountId(options.accountId);
    const watch = createTurnWatch();
    const working = createWorkingStatusGate({
        lifecycle,
        onWorking: options.onWorking,
        onStatusError: () => api.logger.error("octopus-prime Working status could not be sent"),
    });
    // The message as the agent gets it. In a project's channel the session may
    // use the log book tool, and a new session gets CONTEXT.md before the
    // message; a session row that cannot be read leaves the message as it is.
    const bodyForAgent = async (cfg, sessionKey) => {
        if (!frame.project_id)
            return frame.body;
        rememberProjectSession(sessionKey, {
            accountId, channelId: frame.channel_id, agentId: frame.agent_id, projectId: frame.project_id,
        });
        const logBook = options.logBook;
        if (!logBook)
            return frame.body;
        let entry;
        try {
            entry = logBook.readSessionEntry({ agentId: frame.agent_id, sessionKey });
        }
        catch (error) {
            api.logger.warn(`octopus-prime project log book was not added: ${error instanceof Error ? error.message : String(error)}`);
            return frame.body;
        }
        if (!startsNewSession(entry, cfg, sessionKey, frame.thread_id))
            return frame.body;
        const context = await logBook.sessionContext(frame, lifecycle.abortSignal);
        if (lifecycle.abortSignal?.aborted)
            throw new Error("Octopus dispatch was cancelled");
        return context ? withLogBookContext(frame.body, context) : frame.body;
    };
    const resolveTurn = async () => {
        if (lifecycle.abortSignal?.aborted)
            throw new Error("Octopus dispatch was cancelled");
        const cfg = api.runtime.config.current();
        options.validateOrigin?.(cfg);
        if (!accountEnabled(cfg, accountId))
            throw new Error("Octopus connector account is disabled");
        // Only an agent this account offers its organization (src/accounts.ts).
        if (!accountAgentIds(cfg, accountId).includes(frame.agent_id)) {
            throw new Error("Octopus target agent is not currently configured");
        }
        // validateOrigin proved this binding is the connector that admitted the frame.
        const admitted = resolvePinnedRuntimeConfig(accountSection(cfg, accountId));
        const peer = { kind: "channel", id: frame.channel_id };
        const sessionKey = octopusSessionKey(frame.agent_id, frame.channel_id, accountId);
        // In an audited workspace the session may use the audit tool (1.7.0,
        // src/audited-workspace.ts); a message without the flag ends that.
        if (frame.audited === true)
            rememberAuditedSession(sessionKey, { accountId, agentId: frame.agent_id });
        else
            forgetAuditedSession(sessionKey);
        // In every conversation the session may read that conversation's history
        // (1.15.0, src/channel-history.ts), named by this message's delivery.
        rememberConversationSession(sessionKey, {
            accountId, channelId: frame.channel_id, agentId: frame.agent_id, eventId: frame.event_id,
        });
        // In a session the agent may name it (1.21.0, src/session-title.ts); a
        // message without the mark ends that.
        if (frame.agent_session === true) {
            rememberTitledSession(sessionKey, {
                accountId, channelId: frame.channel_id, agentId: frame.agent_id, eventId: frame.event_id,
            });
        }
        else
            forgetTitledSession(sessionKey);
        const agentBody = await bodyForAgent(cfg, sessionKey);
        // Context blocks of their own, each only for a frame that says so: the
        // sender's two-step login (1.6.0), the audited workspace (1.7.0), then the
        // project log's instruction (1.13.0), a fresh session's first message
        // (1.24.0), a message edited to mention the agent (1.26.0), the computer
        // under heavy load (1.27.0); and, on every turn, last, where to read how
        // the app works (1.19.0).
        const structuredContext = [
            senderProtection(frame), workspaceAudit(frame), projectLog(frame), sessionContinuation(frame),
            messageEdited(frame), machineLoad(options.machineLoad?.()), appHelp(),
        ].filter((entry) => entry !== undefined);
        const ctxPayload = buildChannelInboundEventContext({
            channel: CHANNEL,
            accountId,
            provider: CHANNEL,
            surface: CHANNEL,
            messageId: frame.event_id,
            timestamp: timestamp(frame.ts),
            from: `${CHANNEL}:${frame.sender.id}`,
            sender: {
                id: frame.sender.id,
                name: frame.sender.name,
            },
            conversation: {
                kind: "channel",
                id: frame.channel_id,
                ...(frame.thread_id ? { threadId: frame.thread_id } : {}),
                routePeer: peer,
            },
            route: {
                agentId: frame.agent_id,
                accountId,
                routeSessionKey: sessionKey,
                dispatchSessionKey: sessionKey,
                createIfMissing: true,
            },
            reply: {
                to: frame.channel_id,
                originatingTo: frame.channel_id,
                replyToId: frame.event_id,
                ...(frame.thread_id ? { messageThreadId: frame.thread_id } : {}),
            },
            message: {
                body: frame.body,
                rawBody: frame.body,
                bodyForAgent: agentBody,
                commandBody: frame.body,
            },
            ...(structuredContext.length > 0 ? { supplemental: { channelStructuredContext: structuredContext } } : {}),
            // OpenClaw's commands (1.25.0, src/slash-commands.ts): only for the
            // agent's owner, and the managers the backend names, never an
            // owner-only one for a manager; everyone else's are not run, as before.
            access: { commands: { authorized: commandsAuthorized(frame) } },
            channelIngress: "unsupported",
            extra: {
                OctopusEventId: frame.event_id,
                OctopusAgentId: frame.agent_id,
                OctopusSenderId: frame.sender.id,
                OctopusChannelId: frame.channel_id,
            },
        });
        const durable = {
            to: frame.channel_id,
            replyToId: frame.event_id,
            // The backend files a reply under the event it answers: in that event's
            // thread, or top-level. The outbound frame has no thread field, so the send
            // names no thread. An explicit null also stops core from falling back to
            // the inbound thread and requiring a "thread" capability.
            threadId: null,
            requiredCapabilities: {
                text: true,
                replyTo: true,
                reconcileUnknownSend: true,
            },
            prepareRuntimeHandoff: (successor) => pinAdmittedConnector(successor, accountId, admitted),
        };
        const plan = {
            cfg,
            channel: CHANNEL,
            accountId,
            route: {
                agentId: frame.agent_id,
                sessionKey,
            },
            ctxPayload,
            record: { createIfMissing: true },
            dispatcherOptions: { onReplyStart: working.onReplyStart },
            // How the agent's run ended, for the failed-turn notice (1.9.0).
            replyOptions: { onAgentRunTerminalOutcome: watch.onAgentRunTerminalOutcome },
            delivery: {
                deliver: async (payload) => options.deliver(payload),
                durable,
                // Core's error finals stay with the Gateway; the notice says it instead.
                preparePayload: (payload, info) => {
                    const prepared = watch.preparePayload(payload, info);
                    if (prepared && info?.kind === "final")
                        options.onReply?.("sending");
                    return prepared;
                },
                onDelivered: (payload, info, delivered) => {
                    watch.onDelivered(payload, info, delivered);
                    if (info?.kind === "final" && delivered?.visibleReplySent !== false)
                        options.onReply?.("delivered");
                },
                onError: (error, info) => {
                    watch.onError(error, info);
                    api.logger.error(`octopus-prime outbound delivery failed: ${String(error)}`);
                },
            },
        };
        watch.planned();
        return plan;
    };
    // The turn's verdict (src/turn-failure.ts): a turn that answered ends its
    // conversation's failures in a row; one that failed gets its notice.
    const judge = (outcome) => {
        try {
            const verdict = watch.verdict({ ...outcome, cancelled: lifecycle.abortSignal?.aborted === true });
            if (verdict.kind === "ok" || verdict.kind === "silent")
                turnAnswered(accountId, frame.channel_id);
            if (verdict.kind === "silent")
                options.onTurnSilent?.();
            if (verdict.kind === "failed") {
                options.onTurnFailed?.(turnFailedNotice({ accountId, channelId: frame.channel_id, eventId: frame.event_id }, verdict.cause));
            }
        }
        catch {
            api.logger.warn(`octopus-prime the outcome of event ${frame.event_id} could not be judged`);
        }
    };
    let result;
    try {
        result = await api.runtime.channel.inbound.run({
            channel: CHANNEL,
            accountId,
            raw: frame,
            turnAdoptionLifecycle: working.lifecycle,
            adapter: {
                ingest: () => ({
                    id: frame.event_id,
                    timestamp: timestamp(frame.ts),
                    rawText: frame.body,
                    textForAgent: frame.body,
                    textForCommands: frame.body,
                    raw: frame,
                }),
                resolveTurn,
            },
        });
    }
    catch (error) {
        judge({ error });
        throw error;
    }
    judge({ dispatchResult: result.dispatched ? result.dispatchResult : undefined });
    if (!result.dispatched) {
        throw new Error(`OpenClaw did not dispatch admitted Octopus event ${frame.event_id}`);
    }
    return result;
}
