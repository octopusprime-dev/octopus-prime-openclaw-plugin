/**
 * Outbound WebSocket transport to the Octopus Prime backend.
 *
 * Inbound events are acknowledged only after the SQLite ingress monitor has
 * committed them. Model-turn dispatch intentionally remains fail-closed until
 * the exact OpenClaw 2026.9.7 route and reply binding is proven.
 *
 * Each connector account (1.5.0, src/accounts.ts) runs its own transport: its
 * own socket, heartbeat, backoff, ingress queue and pending frames, pinned to
 * its own connector and organization. A reply, status query, reaction, log
 * book request, project folder call or auditor's read goes out on the
 * transport of the account that names it, never on another account's; so does
 * a channel history read (1.15.0) and a session title call (1.21.0).
 */
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createIngressOrigin } from "./ingress-origin.js";
import { accountAgentIds, accountEnabled, accountSection, DEFAULT_ACCOUNT_ID, listConnectorAccountIds, logPrefix, normalizeAccountId, } from "./accounts.js";
import { resolvePinnedRuntimeConfig, sameRuntimeBinding, } from "./runtime-config.js";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { REJECTED_FRAME as HISTORY_REJECTED, RESULT_FRAME as HISTORY_RESULT, } from "./channel-history.js";
import { FLUSH_WAIT_MS, REJECTED_FRAME as RESET_REJECTED, RESET_FRAME, RESULT_FRAME as RESET_RESULT, ALLOW_COMMAND, requestGatewayRestart, resetRequestId, takeReset, } from "./gateway-reset.js";
import { dispatchOctopusInbound, octopusSessionKey } from "./host-dispatch.js";
import { createOctopusIngress } from "./ingress.js";
import { logBookAnswer, READ_FRAME } from "./log-book.js";
import { MESSAGE_EDITED_FRAME, noteMessageEdited, parseMessageEdited } from "./message-edited.js";
import { hostCommandRunner, machineSampler, machineStatsShared } from "./machine-stats.js";
import { folderBody, REJECTED_FRAME as FOLDER_REJECTED, RESULT_FRAME as FOLDER_RESULT } from "./project-folder.js";
import { assertProtocolWelcome, CHANNEL_HISTORY_CAPABILITY, LOG_BOOK_CAPABILITY, MACHINE_STATS_CAPABILITY, negotiationFrame, PROJECT_FOLDER_CAPABILITY, SESSION_STATS_CAPABILITY, SESSION_TITLE_CAPABILITY, SLASH_COMMANDS_CAPABILITY, TURN_SILENCE_CAPABILITY, welcomeOffers, } from "./protocol.js";
import { readSessionEntry, readSessionStats, sessionStatsFrame } from "./session-stats.js";
import { commandsReport } from "./slash-commands.js";
import { REJECTED_FRAME as TITLE_REJECTED, RESULT_FRAME as TITLE_RESULT, } from "./session-title.js";
import { loadReplyFile, MAX_REPLY_FILE_BYTES, MAX_REPLY_FILES, } from "./reply-media.js";
import { OUTBOUND_FRAME_MAX_BYTES, OUTBOUND_ID_MAX_LENGTH, REPLY_PART_MAX_CHARS, replyPartOutboundId, splitReply, splitReplyFrom, wholeReplySave, } from "./reply-parts.js";
import { TURN_FAILED_NOTICE, turnSilentFrame } from "./turn-failure.js";
// A reply or status query that finds the connector starting or reconnecting
// waits for it instead of failing at once, which would spend one of core's
// queue retries and its backoff. The window runs from when the connector
// stopped being ready, so one outage holds callers for at most this long;
// later attempts fail fast and core's queue retries them.
const OUTBOUND_READY_WAIT_MS = 30_000;
const OUTBOUND_RECEIPT_TIMEOUT_MS = 20_000;
// Resending a frame after its socket closed is safe (the backend keeps at most
// one message per outbound_id) but must not loop on a flapping connection.
const MAX_OUTBOUND_WRITES = 3;
// The backend answers every heartbeat ping with a pong. A socket that delivers
// no frame for two heartbeat intervals is dead even if it still looks open (after
// a network change it can for minutes), so it is replaced like a closed one.
// Only application frames count, not WebSocket-level pings, so this checks that
// the backend answers, not only that the TCP path is up.
const HEARTBEAT_INTERVAL_MS = 25_000;
const CONNECTOR_SILENCE_LIMIT_MS = 2 * HEARTBEAT_INTERVAL_MS;
// How often the agents' OpenClaw commands are checked for a change (1.25.0):
// every fourth heartbeat, about every 100 seconds; reading the skills' commands
// reads the agents' workspaces, so not on every heartbeat.
const COMMANDS_CHECK_HEARTBEATS = 4;
// The backend fails a Received/Working turn after 10 minutes without progress
// (DELIVERY_REPLY_TIMEOUT), which frees its conversation for the next message.
// A turn that is still running repeats Working well inside that window, also
// on a replacement socket after a reconnect.
const WORKING_KEEPALIVE_MS = 60_000;
// Reconciliation reads a reply's parts back one by one until the first one the
// backend does not hold; this bounds it, far beyond any real reply.
const MAX_RECONCILED_PARTS = 1_000;
// A new session in a project's channel waits this long at most for the
// project's log book (src/log-book.ts); then its turn goes on without it.
const SESSION_LOG_BOOK_WAIT_MS = 10_000;
// One file of a reply (1.11.0) is given up after this long; the reply then
// goes out without it, its note counting it.
const REPLY_FILE_UPLOAD_TIMEOUT_MS = 30_000;
// A call of the project folder tool (1.14.0) is given up after this long.
const FOLDER_REQUEST_TIMEOUT_MS = 30_000;
// The backend's answers to a file upload that refuse that one file (its type,
// its size, an image it cannot read, R2 refusing to store it, an upload id
// taken by another file). Any other answer, and no answer at all, says no
// file of this reply can be uploaded now (the credential, the delivery or the
// agent's place, file uploads off, an older backend without the route, the
// rate limit, the storage full), so the rest are not tried.
const ONE_FILE_REFUSALS = new Set([400, 413, 415, 422, 502]);
const ONE_FILE_CODES = new Set(["upload_conflict"]);
// The most a reply's file index may be (UPLOAD_INDEX_MAX in backend/chat_attachments.py).
const UPLOAD_INDEX_MAX = 999;
// A file id as the backend gives it and takes it in a frame.
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The reasons the backend refuses a reply or post for the files it names
// (backend/chat_attachments.py): it is then sent without them, its note
// counting them all.
const FILE_REFUSALS = new Set(["too_many_attachments", "invalid_attachments", "attachments_unavailable"]);
// How many uploads an account remembers, so that a reply core sends again
// (the same queue id) uploads none of its files twice. After a Gateway
// restart the backend answers the same upload with the file it kept.
const REMEMBERED_UPLOADS = 1_000;
class ConnectorSocketClosedError extends Error {
}
/** The backend's refusal of one file of a reply, with its status and code. */
class ReplyFileRefusedError extends Error {
    status;
    code;
    stopsReply;
    constructor(status, code) {
        super(status ? `the backend refused it (${status}${code ? ` ${code}` : ""})` : "the backend could not be reached");
        this.status = status;
        this.code = code;
        this.stopsReply = !(ONE_FILE_REFUSALS.has(status) || ONE_FILE_CODES.has(code));
    }
}
/** The backend refused a log book request, with its reason (src/log-book.ts refusalMessage). */
export class LogBookRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`Backend refused the log book request: ${reason}`);
        this.reason = reason;
    }
}
/** The backend refused a project folder call, with its reason and its answer (src/project-folder.ts refusalMessage). */
export class FolderRefusedError extends Error {
    reason;
    frame;
    constructor(reason, frame) {
        super(`Backend refused the project folder request: ${reason}`);
        this.reason = reason;
        this.frame = frame;
    }
}
/** The backend refused a channel history read, with its reason (src/channel-history.ts refusalMessage). */
export class ChannelHistoryRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`Backend refused the channel history request: ${reason}`);
        this.reason = reason;
    }
}
/** The backend refused a session title call, with its reason (src/session-title.ts refusalMessage). */
export class SessionTitleRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`Backend refused the session title request: ${reason}`);
        this.reason = reason;
    }
}
/** The backend refused an auditor's read, with its reason (src/audited-workspace.ts refusalMessage). */
export class AuditRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`Backend refused the audit request: ${reason}`);
        this.reason = reason;
    }
}
// The backend's refusal of a reply frame, with its reason (identity_conflict,
// source_expired, ...).
class OutboundRejectedError extends Error {
    reason;
    constructor(reason) {
        super(`Backend rejected outbound intent: ${reason}`);
        this.reason = reason;
    }
}
// What each reason of `message.post.refused` (backend POST_REFUSALS) means.
const POST_REFUSALS = {
    invalid_post: "the message was empty or malformed",
    organization_unavailable: "the organization is closed",
    channel_unavailable: "that conversation is closed, in another organization, or not open to this agent",
    unknown_agent: "that agent is not one of this connector's agents",
    not_participant: "this agent is not in that conversation",
    ambiguous_agent: "more than one agent of this connector is in that conversation",
    agent_posting_closed: "agents do not post in that conversation",
    conversation_blocked: "the person blocked this agent",
    identity_conflict: "another message was already posted under this id",
    too_many_attachments: "it named more files than a message holds",
    invalid_attachments: "its files were not named as file ids",
    attachments_unavailable: "a file it named was not uploaded for it or is no longer kept",
};
/** The backend refused a post with no message to answer (1.10.0), with its reason. */
export class PostRefusedError extends Error {
    reason;
    constructor(reason) {
        super(`Octopus Prime did not post the message: ${POST_REFUSALS[reason] ?? "the backend refused it"} (${reason})`);
        this.reason = reason;
    }
}
// Sockets whose backend offered session-stats in its welcome.
const sessionStatsSockets = new WeakSet();
// Sockets whose backend offered the project log book in its welcome.
const logBookSockets = new WeakSet();
// Sockets whose backend offered the project folder in its welcome (1.14.0).
const folderSockets = new WeakSet();
// Sockets whose backend offered channel history in its welcome (1.15.0).
const historySockets = new WeakSet();
// Sockets whose backend offered turn-silence in its welcome (1.17.0).
const silenceSockets = new WeakSet();
// Sockets whose backend offered session titles in its welcome (1.21.0).
const titleSockets = new WeakSet();
// Sockets whose backend offered machine-stats in its welcome (1.27.0).
const machineSockets = new WeakSet();
// How many messages whose turn ended in silence an account remembers, to settle
// them again when the backend offers one again.
const REMEMBERED_SILENT_TURNS = 1_000;
function httpBase(url) {
    return url.replace(/\/+$/, "");
}
function wsBase(url) {
    return httpBase(url).replace(/^http/, "ws");
}
export function createTransportInboundHandler(options) {
    return async (data) => {
        if (!data || typeof data !== "object")
            throw new Error("Connector frame is not an object");
        const frame = data;
        if (frame.type === "pong")
            return;
        if (frame.type === "welcome") {
            assertProtocolWelcome(frame);
            await options.onWelcome(frame);
            return;
        }
        if (!options.isNegotiated())
            throw new Error("Backend sent application data before protocol negotiation completed");
        if (await options.onControlFrame?.(frame))
            return;
        if (frame.type !== "message.inbound")
            return;
        const agentId = typeof frame.agent_id === "string" ? frame.agent_id : "";
        if (!agentId || !options.isAgentAllowed(agentId)) {
            options.send({
                type: "message.rejected",
                event_id: typeof frame.event_id === "string" ? frame.event_id : "",
                reason: "Agent is not currently announced by this connector",
            });
            return;
        }
        if (typeof frame.event_id === "string")
            options.onOffered?.(frame.event_id);
        const result = await options.admission.receive(frame);
        if (result.kind === "invalid") {
            options.send({
                type: "message.rejected",
                event_id: typeof frame.event_id === "string" ? frame.event_id : "",
                reason: result.message,
            });
            return;
        }
        if (result.kind !== "durable")
            return;
        options.send({ type: "ack", event_id: frame.event_id });
    };
}
// The running transports, by account id.
const transports = new Map();
// The files uploaded from this Gateway process (1.11.0), by backend,
// connector, conversation, delivery, reply and place: the id the backend gave
// each (uploadReplyFiles). Kept across a transport's restart, since core's
// queue replays a reply after one.
const uploadedFiles = new Map();
// An account that is not running gets a transport that never started, which
// answers as a stopped one does: nothing is written anywhere.
function transportFor(accountId) {
    const id = normalizeAccountId(accountId);
    return transports.get(id) ?? createAccountTransport(id);
}
// How often a restart's wait for the frames in flight looks again.
const SETTLE_CHECK_MS = 100;
/**
 * Resolves once no running account's connector waits on an answer to a frame
 * it sent (a reply's receipt, say), or after `ms` (src/gateway-reset.ts):
 * what is still unanswered then stays in core's durable queue, which outlives
 * the restart.
 */
async function outboundSettled(ms) {
    const deadline = Date.now() + ms;
    const waiting = () => [...transports.values()].reduce((count, transport) => count + transport.pendingCount(), 0);
    while (waiting() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_CHECK_MS));
    }
}
export async function startTransport(api, cfg, deps = {}) {
    const accountId = normalizeAccountId(cfg.accountId);
    if (transports.has(accountId))
        throw new Error("Octopus Prime transport is already started");
    const transport = createAccountTransport(accountId);
    transports.set(accountId, transport);
    try {
        transport.start(api, cfg, deps);
    }
    catch (error) {
        if (transports.get(accountId) === transport)
            transports.delete(accountId);
        throw error;
    }
}
/** Stops one account's transport, or every running one when no account is named. */
export async function stopTransport(accountId) {
    const ids = accountId === undefined ? [...transports.keys()] : [normalizeAccountId(accountId)];
    await Promise.all(ids.map(async (id) => {
        const transport = transports.get(id);
        if (!transport)
            return;
        transports.delete(id);
        await transport.stop();
    }));
}
export function getTransportLifecycleStatus(cfg, accountId) {
    const transport = transports.get(normalizeAccountId(accountId));
    return transport ? transport.status(cfg) : { state: "stopped", restartPending: false };
}
export function admitOutboundDelivery(params) {
    const accountId = normalizeAccountId(params.accountId);
    if (params.channel !== "octopus-prime"
        || (accountId !== DEFAULT_ACCOUNT_ID && !listConnectorAccountIds(params.cfg).includes(accountId))) {
        return {
            status: "permanent_rejection",
            reason: "Octopus Prime outbound has no such connector account",
        };
    }
    if (!params.to.trim()) {
        return { status: "permanent_rejection", reason: "Build 10 pilot outbound requires a channel target" };
    }
    // A connector that is not ready yet must not reject permanently, which would
    // drop the reply. Admit it; the send then waits for the connector or fails
    // before anything reaches the wire.
    return { status: "allowed" };
}
/**
 * Sends an agent reply through the connector of its account (the default
 * account when none is named) and returns the ids of the messages it became,
 * in order (see the account transport's sendOutboundReply).
 */
export function sendOutboundReply(params) {
    return transportFor(params.accountId).sendOutboundReply(params);
}
/**
 * Posts an agent's message that answers no message (a sub-agent's announce, a
 * send from another session or a scheduled wake) through the connector of its
 * account, and returns the ids of the messages it became, in order.
 */
export function sendAgentPost(params) {
    return transportFor(params.accountId).sendAgentPost(params);
}
/**
 * Uploads a reply's files (1.11.0, src/reply-media.ts) through the connector
 * of its account, for that reply's delivery or post, and answers which were
 * kept and how many were not (see the account transport's uploadReplyFiles).
 */
export function uploadReplyFiles(params) {
    return transportFor(params.accountId).uploadReplyFiles(params);
}
/** Reads back the messages a reply became, from its account's backend. */
export function reconcileOutboundReply(outboundId, accountId) {
    return transportFor(accountId).reconcileOutboundReply(outboundId);
}
/** Adds or removes an agent's reaction through the connector of its account. */
export function sendReaction(params) {
    return transportFor(params.accountId).sendReaction(params);
}
/** Sends a log book request through the connector of its account. */
export function requestLogBook(request, options = {}) {
    return transportFor(options.accountId).requestLogBook(request, options);
}
/** Sends a project folder call through the connector of its account (see the account transport's requestFolder). */
export function requestFolder(request, options = {}) {
    return transportFor(options.accountId).requestFolder(request, options);
}
/** Whether an account's connection is to a backend that offered the project folder (1.14.0). */
export function projectFolderOffered(accountId) {
    return transportFor(accountId).folderOffered();
}
/** Sends a channel history read through the connector of its account (see the account transport's requestChannelHistory). */
export function requestChannelHistory(request, options = {}) {
    return transportFor(options.accountId).requestChannelHistory(request, options);
}
/** Whether an account's connection is to a backend that offered channel history (1.15.0). */
export function channelHistoryOffered(accountId) {
    return transportFor(accountId).historyOffered();
}
/** Sends a session title call through the connector of its account (see the account transport's requestSessionTitle). */
export function requestSessionTitle(request, options = {}) {
    return transportFor(options.accountId).requestSessionTitle(request, options);
}
/** Whether an account's connection is to a backend that offered session titles (1.21.0). */
export function sessionTitleOffered(accountId) {
    return transportFor(accountId).titleOffered();
}
/** Sends an auditor's read through the connector of its account. */
export function requestAudit(request, options = {}) {
    return transportFor(options.accountId).requestAudit(request, options);
}
function outboundKey(kind, outboundId) {
    return `${kind}:${outboundId}`;
}
function outboundFrame(target, body, place, notice, progress, attachments) {
    return {
        type: "message.outbound",
        outbound_id: target.outboundId,
        event_id: target.eventId,
        channel_id: target.channelId,
        body,
        ...(place ? { reply_id: place.replyId, part: place.part, parts: place.parts } : {}),
        // A failed turn's notice (src/turn-failure.ts); older backends ignore both.
        ...(notice ? { notice: TURN_FAILED_NOTICE, cause: notice } : {}),
        // Sent while its turn runs (1.10.0): the turn goes on. An older backend
        // ignores it and takes the message as the turn's reply.
        ...(progress ? { progress: true } : {}),
        // The reply's files the backend kept (1.11.0), on its last part only.
        ...(attachments?.length ? { attachments: [...attachments] } : {}),
    };
}
// A post with no message to answer (1.10.0), in the parts a reply has.
function postFrame(target, body, place, attachments) {
    return {
        type: "message.post",
        post_id: target.postId,
        channel_id: target.channelId,
        body,
        ...(place ? { reply_id: place.replyId, part: place.part, parts: place.parts } : {}),
        ...(attachments?.length ? { attachments: [...attachments] } : {}),
    };
}
// The longest `attachments` a frame may carry: as many file ids as a message
// holds, each as long as the backend takes. Room for it is left in every part
// of a reply that had files.
const LONGEST_ATTACHMENTS = Array.from({ length: MAX_REPLY_FILES }, () => "f".repeat(OUTBOUND_ID_MAX_LENGTH));
const longestAttachments = (files) => (files === undefined ? undefined : LONGEST_ATTACHMENTS);
// A reply's parts once the backend refused the files its part `index` named:
// its text with the note counting them all, cut as before, when the parts
// already sent stay exactly as they were; else the same parts.
function partsWithoutFiles(bodies, index, text, limits) {
    if (text === undefined)
        return bodies;
    const again = splitReply(text, limits);
    return again.length > index && bodies.slice(0, index).every((body, at) => body === again[at]) ? again : bodies;
}
function unwrittenFailure(kind, error, lastClose) {
    if (lastClose) {
        // An earlier write of this frame may have been delivered: keep the outcome
        // unresolved and leave the marker out of the error graph.
        return new Error(`${lastClose.message}; ${error instanceof Error ? error.message : String(error)}`, { cause: lastClose });
    }
    if (kind === "send" || kind === "post")
        return notDispatched(error);
    return error instanceof Error ? error : new Error(String(error));
}
// What one part's body may hold so that its frame stays within
// OUTBOUND_FRAME_MAX_BYTES. Sized with the longest outbound and reply ids a
// part can carry (the queue id padded to the backend's 128 characters) and the
// largest part count the backend takes (MAX_RECONCILED_PARTS, REPLY_PARTS_MAX in
// server.py).
function partLimits(id, frame) {
    const longest = id.padEnd(OUTBOUND_ID_MAX_LENGTH, "0");
    const empty = frame(longest, { replyId: longest, part: MAX_RECONCILED_PARTS, parts: MAX_RECONCILED_PARTS });
    return { maxChars: REPLY_PART_MAX_CHARS, maxBytes: OUTBOUND_FRAME_MAX_BYTES - Buffer.byteLength(JSON.stringify(empty)) };
}
function replyPartLimits(target, progress = false, files) {
    return partLimits(target.outboundId, (longest, place) => outboundFrame({ ...target, outboundId: longest }, "", place, undefined, progress, longestAttachments(files)));
}
function notDispatched(error) {
    if (error instanceof PlatformMessageNotDispatchedError)
        return error;
    const cause = error instanceof Error ? error : new Error(String(error));
    return new PlatformMessageNotDispatchedError(cause.message, { cause, retryable: true });
}
/**
 * One account's connector: its socket to the backend, the heartbeat, the
 * reconnect backoff, the origin-bound ingress queue and the frames waiting for
 * an answer. Everything it reads from the config is that account's
 * (src/accounts.ts), and it answers only for that account's connector.
 */
function createAccountTransport(accountId) {
    const log = logPrefix(accountId);
    let ws = null;
    let createSocket = (url, options) => new WebSocket(url, options);
    let hostApi = null;
    let backendUrl = "";
    let token = "";
    let heartbeat = null;
    let silenceTimer = null;
    let reconnectTimer = null;
    let retry = 0;
    let stopped = false;
    let negotiated = false;
    let ingress = null;
    let transportGeneration = null;
    let activeOrigin = null;
    let ingressStarted = false;
    let activeRuntimeBinding = null;
    let runtimeBindingRestartRequired = false;
    let fatalTransportError;
    let initializeIngress = null;
    let connectorUnavailableSince = null;
    let readEntry = readSessionEntry;
    // Read when called, so the global fetch in use then is the one used.
    let fetchFile = (input, init) => fetch(input, init);
    let loadFile = loadReplyFile;
    let restartGateway = requestGatewayRestart;
    let loadCommandRegistry;
    let sampler;
    const pendingOutbound = new Map();
    const activeOutboundRequests = new Map();
    const readinessWaiters = new Set();
    // The turns running now, by the event id of the message each answers.
    const activeTurns = new Map();
    // The turns that ended in silence by the agent's choice (1.17.0), by the event
    // id of the message each answered: settled again if the backend offers the
    // message again, e.g. when the frame was lost with a closing socket.
    const silentTurns = new Map();
    function start(api, cfg, deps) {
        if (ingress || ws || initializeIngress)
            throw new Error("Octopus Prime transport is already started");
        const pinned = resolvePinnedRuntimeConfig(cfg);
        createSocket = deps.createSocket ?? ((url, options) => new WebSocket(url, options));
        const createIngress = deps.createIngress ?? createOctopusIngress;
        readEntry = deps.readSessionEntry ?? readSessionEntry;
        fetchFile = deps.fetch ?? ((input, init) => fetch(input, init));
        loadFile = deps.loadReplyFile ?? loadReplyFile;
        restartGateway = deps.requestRestart ?? requestGatewayRestart;
        loadCommandRegistry = deps.loadCommandRegistry;
        const machine = deps.machineSampler ?? machineSampler(hostCommandRunner(api.runtime?.system));
        sampler = machine;
        hostApi = api;
        const generation = {};
        transportGeneration = generation;
        activeRuntimeBinding = pinned;
        runtimeBindingRestartRequired = false;
        backendUrl = pinned.backendUrl;
        fatalTransportError = undefined;
        activeOrigin = null;
        ingressStarted = false;
        token = pinned.connectorToken;
        stopped = false;
        negotiated = false;
        connectorUnavailableSince = Date.now();
        initializeIngress = (origin) => createIngress({
            api,
            accountId,
            origin,
            dispatch: async (frame, lifecycle) => {
                assertCurrentIngressScope(origin, generation);
                const working = workingStatus(frame.event_id, generation);
                let failed;
                let silent = false;
                const turn = { replying: false, replied: false };
                activeTurns.set(frame.event_id, turn);
                try {
                    await dispatchOctopusInbound({
                        api,
                        accountId,
                        frame,
                        lifecycle,
                        validateOrigin: (currentCfg) => assertCurrentIngressScope(origin, generation, false, currentCfg),
                        onWorking: working.start,
                        deliver: async () => {
                            throw new Error("Octopus Prime replies require durable core-managed delivery");
                        },
                        logBook: { readSessionEntry: (params) => readEntry(params), sessionContext: sessionLogBook },
                        onTurnFailed: (notice) => { failed = notice; },
                        onTurnSilent: () => { silent = true; },
                        onReply: (phase) => {
                            if (phase === "sending")
                                turn.replying = true;
                            else
                                turn.replied = true;
                        },
                        machineLoad: () => machine.heavy(),
                    });
                }
                finally {
                    if (activeTurns.get(frame.event_id) === turn)
                        activeTurns.delete(frame.event_id);
                    working.stop();
                    if (failed)
                        sendTurnFailedNotice(frame, failed, generation);
                    else if (!turn.replied && turn.lastProgress)
                        endTurnOnProgress(turn.lastProgress, generation);
                    else if (silent && !turn.replied)
                        sendTurnSilent(frame, generation);
                }
                reportSessionStats(frame, generation);
            },
            onError: (error) => api.logger.error(`${log} ingress error: ${String(error)}`),
        });
        connect();
    }
    async function stop() {
        stopped = true;
        transportGeneration = null;
        activeRuntimeBinding = null;
        runtimeBindingRestartRequired = false;
        initializeIngress = null;
        activeOrigin = null;
        ingressStarted = false;
        negotiated = false;
        fatalTransportError = undefined;
        if (heartbeat)
            clearInterval(heartbeat);
        heartbeat = null;
        if (silenceTimer)
            clearTimeout(silenceTimer);
        silenceTimer = null;
        if (reconnectTimer)
            clearTimeout(reconnectTimer);
        reconnectTimer = null;
        try {
            ws?.close();
        }
        catch { /* best-effort socket close */ }
        ws = null;
        rejectPendingOutbound(new ConnectorSocketClosedError("Connector transport stopped before backend receipt"));
        wakeReadinessWaiters();
        const activeIngress = ingress;
        ingress = null;
        if (activeIngress)
            await activeIngress.close();
        hostApi = null;
    }
    /**
     * Reports a turn as Working, then repeats it every WORKING_KEEPALIVE_MS until
     * its dispatch returns, on whichever socket is current. A beat that finds no
     * negotiated socket is skipped; a later one reaches the reconnected socket.
     */
    function workingStatus(eventId, generation) {
        let keepalive = null;
        let finished = false;
        const send = () => {
            const socket = ws;
            if (transportGeneration !== generation || stopped || !negotiated || !socket || socket.readyState !== WebSocket.OPEN)
                return;
            socket.send(JSON.stringify({ type: "status", event_id: eventId, state: "working" }));
        };
        return {
            start: () => {
                if (!finished && !keepalive) {
                    keepalive = setInterval(() => {
                        try {
                            send();
                        }
                        catch { /* a closing socket; the next beat retries */ }
                    }, WORKING_KEEPALIVE_MS);
                }
                send();
            },
            stop: () => {
                finished = true;
                if (keepalive)
                    clearInterval(keepalive);
                keepalive = null;
            },
        };
    }
    /**
     * Sends a failed turn's notice (src/turn-failure.ts) as a reply to its
     * message, on the transport that took the message. Best effort and never
     * awaited: the turn already ended, its Working repeats stopped, and a
     * stopping connector is not held up. A transport that stopped or restarted
     * since sends nothing. A notice that is not sent is logged once, by event id
     * alone, and nothing is thrown or retried here; a replay of the message
     * that fails again sends the identical frame.
     */
    function sendTurnFailedNotice(frame, notice, generation) {
        if (transportGeneration !== generation || stopped)
            return;
        sendOutbound({
            outboundId: notice.outboundId,
            eventId: frame.event_id,
            channelId: frame.channel_id,
            body: notice.body,
            notice: notice.cause,
        }).catch(() => {
            hostApi?.logger.warn(`${log} the failed-turn notice for event ${frame.event_id} was not sent`);
        });
    }
    /**
     * A turn that ended on its progress messages, with no reply and no failure
     * (the agent answered with its message tool, then chose silence), sends the
     * last frame of its last progress message again, without the progress flag.
     * The backend holds that message already, so it answers the frame with the
     * same receipt and takes it as the turn's answer: nothing new is shown or
     * pushed, and the conversation's next message goes to the agent. Best effort
     * and never awaited, as the failed-turn notice is; one that is not sent
     * leaves the backend's reply timeout to end the turn.
     */
    function endTurnOnProgress(last, generation) {
        if (transportGeneration !== generation || stopped)
            return;
        sendOutbound(last).catch(() => {
            hostApi?.logger.warn(`${log} the progress message ending the turn of event ${last.eventId} was not confirmed as its answer`);
        });
    }
    /**
     * A turn that ended in silence by the agent's own choice (core's NO_REPLY),
     * with no reply, no progress message and no failure, tells the backend with
     * a `turn.silent` frame for its message, which settles it: never offered
     * again, no no-reply timer, no "didn't respond". Sent on the current socket
     * only if that socket's backend offered turn-silence, best effort and never
     * awaited. A frame that is not sent (no socket just now, an older backend)
     * is sent again when the backend offers the message again (settleSilentTurn);
     * an older backend times the turn out as before.
     */
    function sendTurnSilent(frame, generation) {
        if (transportGeneration !== generation || stopped)
            return;
        const settled = { event_id: frame.event_id, channel_id: frame.channel_id, agent_id: frame.agent_id };
        silentTurns.delete(frame.event_id);
        silentTurns.set(frame.event_id, settled);
        while (silentTurns.size > REMEMBERED_SILENT_TURNS)
            silentTurns.delete(silentTurns.keys().next().value);
        writeTurnSilent(ws, settled);
    }
    // Writes the frame on this socket if it is open, negotiated and from a backend that offered turn-silence.
    function writeTurnSilent(socket, settled) {
        if (!socket || !negotiated || socket.readyState !== WebSocket.OPEN || !silenceSockets.has(socket))
            return;
        try {
            socket.send(JSON.stringify(turnSilentFrame(settled)));
        }
        catch {
            hostApi?.logger.warn(`${log} the silent turn of event ${settled.event_id} was not reported`);
        }
    }
    // The backend offers a message again: if its turn ended in silence, settle it again.
    function settleSilentTurn(socket, eventId) {
        const settled = silentTurns.get(eventId);
        if (settled && ws === socket && !stopped)
            writeTurnSilent(socket, settled);
    }
    /**
     * Once a turn completed, reports how full its session is now
     * (src/session-stats.ts) on the current socket, if that socket's backend
     * offered session-stats. Best effort: no receipt is awaited and nothing is
     * retried, since the next turn reports again, and a failure here never
     * touches the turn or its reply.
     */
    function reportSessionStats(frame, generation) {
        const socket = ws;
        if (transportGeneration !== generation || stopped || !negotiated || !socket
            || socket.readyState !== WebSocket.OPEN || !sessionStatsSockets.has(socket))
            return;
        try {
            const stats = readSessionStats(readEntry, frame.agent_id, octopusSessionKey(frame.agent_id, frame.channel_id, accountId));
            if (stats)
                socket.send(JSON.stringify(sessionStatsFrame(frame.event_id, frame.agent_id, stats)));
        }
        catch (error) {
            hostApi?.logger.warn(`${log} session stats were not reported: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    function scheduleReconnect(reason) {
        if (stopped)
            return;
        retry += 1;
        const delay = Math.min(1_000 * 2 ** retry, 15_000);
        // Never the token (or the handshake headers) in a log line.
        hostApi?.logger.warn(`${log} connector ${reason}; reconnecting in ${delay / 1_000} seconds`);
        reconnectTimer = setTimeout(connect, delay);
    }
    function connect() {
        if (!hostApi || stopped || !initializeIngress)
            return;
        // The credential goes in the handshake's Authorization header (1.20.0), so
        // no proxy that logs request lines can record it; the address has none.
        const url = `${wsBase(backendUrl)}/api/connector/ws`;
        let socket;
        try {
            socket = createSocket(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        catch {
            // A failed attempt must not end the reconnect loop.
            scheduleReconnect("socket could not be created");
            return;
        }
        ws = socket;
        negotiated = false;
        let announcedAgentIds = new Set();
        let announcedAgentSnapshot = "";
        // Each agent's OpenClaw commands (1.25.0, src/slash-commands.ts), reported
        // only to a backend whose welcome offered them: on connect, then whenever
        // they change (checked every COMMANDS_CHECK_HEARTBEATS heartbeats, and at
        // once when the agents change).
        let reportsCommands = false;
        let reportedCommands = "";
        let reportingCommands = false;
        let commandHeartbeats = 0;
        const reportCommands = async () => {
            if (!reportsCommands || reportingCommands)
                return;
            reportingCommands = true;
            try {
                const report = await commandsReport(currentAgentConfig(), currentAgentAnnouncement().map((agent) => agent.id), loadCommandRegistry);
                if (!report || ws !== socket || stopped)
                    return;
                const snapshot = JSON.stringify(report);
                if (snapshot === reportedCommands)
                    return;
                sendOnSocket({ type: "agent.commands", agents: report });
                reportedCommands = snapshot;
            }
            catch {
                // No list this time (the socket is closing, or the config cannot be
                // read): the apps keep the last one, and the next check tries again.
            }
            finally {
                reportingCommands = false;
            }
        };
        // Runs once per socket: on its close event, or when it is found silent.
        const releaseSocket = (reason) => {
            if (ws !== socket)
                return;
            announcedAgentIds.clear();
            negotiated = false;
            connectorUnavailableSince ??= Date.now();
            if (heartbeat)
                clearInterval(heartbeat);
            heartbeat = null;
            if (silenceTimer)
                clearTimeout(silenceTimer);
            silenceTimer = null;
            ws = null;
            rejectPendingOutbound(new ConnectorSocketClosedError("Connector socket closed before backend receipt"));
            wakeReadinessWaiters();
            // The backend re-offers every unanswered message once the agents are
            // announced on the next socket, so reconnecting is all this side does.
            scheduleReconnect(reason);
        };
        // Armed when the socket is created, so a connection attempt that hangs is
        // given up too, and re-armed whenever the backend is heard from.
        const watchSilence = () => {
            if (silenceTimer)
                clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                if (ws !== socket || stopped)
                    return;
                releaseSocket(`socket was silent for ${CONNECTOR_SILENCE_LIMIT_MS / 1_000} seconds`);
                // close() would wait for a closing handshake that a dead peer never answers.
                try {
                    socket.terminate();
                }
                catch { /* the socket is already released */ }
            }, CONNECTOR_SILENCE_LIMIT_MS);
        };
        watchSilence();
        const sendOnSocket = (frame) => {
            if (ws !== socket || stopped || socket.readyState !== WebSocket.OPEN)
                throw new Error("Connector socket is not active");
            socket.send(JSON.stringify(frame));
        };
        const handleInbound = createTransportInboundHandler({
            admission: {
                receive(frame) {
                    if (!ingress || !activeOrigin)
                        throw new Error("Ingress origin is not authenticated");
                    return ingress.receive(frame);
                },
            },
            send: sendOnSocket,
            isNegotiated: () => ws === socket && !stopped && negotiated,
            isAgentAllowed: (agentId) => announcedAgentIds.has(agentId) && currentAgentAnnouncement().some((agent) => agent.id === agentId),
            onWelcome: async (welcome) => {
                const generation = transportGeneration;
                if (!generation || ws !== socket || stopped)
                    return;
                const origin = createIngressOrigin({ backendUrl, connectorId: welcome.connector_id, accountId });
                if (activeRuntimeBinding?.connectorId !== origin.connectorId) {
                    fatalTransportError = "Authenticated connector does not match the configured connector identity pin";
                    stopped = true;
                    throw new Error(fatalTransportError);
                }
                if (activeOrigin && activeOrigin.key !== origin.key) {
                    throw new Error("Authenticated connector changed within an active ingress generation");
                }
                assertCurrentIngressScope(origin, generation, true);
                if (!ingress) {
                    if (!initializeIngress)
                        throw new Error("Ingress generation is no longer active");
                    ingress = initializeIngress(origin);
                    activeOrigin = origin;
                }
                const agents = currentAgentAnnouncement();
                const announced = await announceAgents(sendOnSocket, agents);
                if (ws !== socket || stopped)
                    return;
                announcedAgentIds = announced;
                announcedAgentSnapshot = JSON.stringify(agents);
                if (welcomeOffers(welcome, SESSION_STATS_CAPABILITY))
                    sessionStatsSockets.add(socket);
                if (welcomeOffers(welcome, LOG_BOOK_CAPABILITY))
                    logBookSockets.add(socket);
                if (welcomeOffers(welcome, PROJECT_FOLDER_CAPABILITY))
                    folderSockets.add(socket);
                if (welcomeOffers(welcome, CHANNEL_HISTORY_CAPABILITY))
                    historySockets.add(socket);
                if (welcomeOffers(welcome, TURN_SILENCE_CAPABILITY))
                    silenceSockets.add(socket);
                if (welcomeOffers(welcome, SESSION_TITLE_CAPABILITY))
                    titleSockets.add(socket);
                if (welcomeOffers(welcome, MACHINE_STATS_CAPABILITY))
                    machineSockets.add(socket);
                reportsCommands = welcomeOffers(welcome, SLASH_COMMANDS_CAPABILITY);
                // A first reading, so the first heartbeat has one (src/machine-stats.ts).
                void sampler?.refresh();
                negotiated = true;
                connectorUnavailableSince = null;
                retry = 0;
                if (!ingressStarted) {
                    ingress.start();
                    ingressStarted = true;
                }
                if (heartbeat)
                    clearInterval(heartbeat);
                heartbeat = setInterval(() => {
                    try {
                        const current = currentAgentAnnouncement();
                        const snapshot = JSON.stringify(current);
                        if (snapshot !== announcedAgentSnapshot) {
                            sendOnSocket({ type: "agents.announce", agents: current });
                            announcedAgentIds = new Set(current.map((agent) => agent.id));
                            announcedAgentSnapshot = snapshot;
                            commandHeartbeats = 0;
                        }
                        if (commandHeartbeats++ % COMMANDS_CHECK_HEARTBEATS === 0)
                            void reportCommands();
                        const version = hostOpenClawVersion();
                        const machine = machineSockets.has(socket) ? sharedMachineStats() : undefined;
                        sendOnSocket({
                            type: "ping",
                            ...(version ? { openclaw_version: version } : {}),
                            ...(machine ? { machine } : {}),
                        });
                        // The next heartbeat's reading; also what tells an agent the computer is under heavy load.
                        void sampler?.refresh();
                    }
                    catch {
                        socket.close();
                    }
                }, HEARTBEAT_INTERVAL_MS);
                if (reportsCommands) {
                    commandHeartbeats = 1;
                    void reportCommands();
                }
                wakeReadinessWaiters();
            },
            onControlFrame: (frame) => (frame.type === RESET_FRAME ? handleGatewayReset(frame, sendOnSocket)
                : frame.type === MESSAGE_EDITED_FRAME ? handleMessageEdited(frame, (agentId) => announcedAgentIds.has(agentId)
                    && currentAgentAnnouncement().some((agent) => agent.id === agentId))
                    : handleOutboundControlFrame(frame)),
            onOffered: (eventId) => settleSilentTurn(socket, eventId),
        });
        socket.on("open", () => {
            if (ws !== socket || stopped)
                return;
            watchSilence();
            sendOnSocket(negotiationFrame(hostOpenClawVersion()));
        });
        socket.on("message", (raw) => {
            if (ws !== socket || stopped)
                return;
            watchSilence();
            let data;
            try {
                data = JSON.parse(raw.toString());
            }
            catch {
                socket.close(1002, "invalid-json");
                return;
            }
            handleInbound(data).catch((error) => {
                hostApi?.logger.error(`${log} inbound error: ${String(error)}`);
                socket.close(1002, "protocol-error");
            });
        });
        // 1006 (dropped) and 1012 (backend restarting, as on every redeploy) are the
        // usual codes; any close is followed by the same reconnect with backoff.
        socket.on("close", (code) => releaseSocket(`socket closed (code ${code})`));
        socket.on("error", () => {
            if (ws !== socket)
                return;
            try {
                socket.close();
            }
            catch { /* close handler owns retry */ }
        });
    }
    function assertCurrentIngressScope(origin, generation, beforeOpen = false, currentCfg) {
        if (transportGeneration !== generation || stopped || (!beforeOpen && activeOrigin?.key !== origin.key)) {
            throw new Error("Ingress origin generation is no longer active");
        }
        const cfg = currentCfg ?? currentAgentConfig();
        const binding = activeRuntimeBinding;
        let current = null;
        try {
            current = resolvePinnedRuntimeConfig(accountSection(cfg, accountId));
        }
        catch { /* fail closed below */ }
        if (!accountEnabled(cfg, accountId) || !binding || !current
            || !sameRuntimeBinding(current, binding)
            || binding.backendUrl !== origin.backendUrl
            || binding.connectorId !== origin.connectorId) {
            runtimeBindingRestartRequired = true;
            throw new Error("Current configuration does not match the authenticated ingress origin");
        }
    }
    function status(cfg) {
        if (fatalTransportError)
            return { state: "error", restartPending: false, error: fatalTransportError };
        if (!transportGeneration)
            return { state: "stopped", restartPending: false };
        let current;
        try {
            current = resolvePinnedRuntimeConfig(accountSection(cfg, accountId));
        }
        catch (error) {
            return { state: "restart-required", restartPending: true, error: error instanceof Error ? error.message : String(error) };
        }
        if (!activeRuntimeBinding || !sameRuntimeBinding(current, activeRuntimeBinding)) {
            runtimeBindingRestartRequired = true;
        }
        if (runtimeBindingRestartRequired) {
            return {
                state: "restart-required",
                restartPending: true,
                error: "Connector pin changed; restart the Octopus Prime channel account to activate the new identity generation",
            };
        }
        return { state: negotiated ? "ready" : "starting", restartPending: false };
    }
    // The running OpenClaw version, reported with each heartbeat so the backend can
    // tell when gateways drop after an OpenClaw update. Left out when unavailable.
    function hostOpenClawVersion() {
        try {
            const version = hostApi?.runtime.version;
            return typeof version === "string" && version.length > 0 && version.length <= 64 ? version : undefined;
        }
        catch {
            return undefined;
        }
    }
    // The machine's latest reading, unless the Gateway's owner turned sharing it
    // off (1.27.0, src/machine-stats.ts); a config that cannot be read sends none.
    function sharedMachineStats() {
        try {
            return machineStatsShared(currentAgentConfig()) ? sampler?.latest() : undefined;
        }
        catch {
            return undefined;
        }
    }
    function currentAgentConfig() {
        if (!hostApi)
            throw new Error("Octopus Prime host runtime is unavailable");
        // The pinned SDK exposes the current read-only runtime snapshot. The roster
        // helpers only read it; no disk/config mutation or secret resolution occurs.
        return hostApi.runtime.config.current();
    }
    function configuredOutboundBinding(cfg) {
        if (!accountEnabled(cfg, accountId))
            return null;
        try {
            return resolvePinnedRuntimeConfig(accountSection(cfg, accountId));
        }
        catch {
            return null;
        }
    }
    function captureOutboundReadiness(cfg) {
        const generation = transportGeneration;
        const binding = activeRuntimeBinding;
        const origin = activeOrigin;
        const socket = ws;
        if (!generation || !binding || !origin || !socket || stopped || !negotiated || socket.readyState !== WebSocket.OPEN)
            return null;
        const supplied = configuredOutboundBinding(cfg);
        let current;
        try {
            current = configuredOutboundBinding(currentAgentConfig());
        }
        catch {
            return null;
        }
        if (runtimeBindingRestartRequired)
            return null;
        if (!current || !sameRuntimeBinding(current, binding)
            || binding.backendUrl !== origin.backendUrl
            || binding.connectorId !== origin.connectorId
            || accountId !== origin.accountId) {
            runtimeBindingRestartRequired = true;
            return null;
        }
        if (!supplied || !sameRuntimeBinding(supplied, binding))
            return null;
        return Object.freeze({ generation, binding, origin, socket });
    }
    function assertCurrentOutboundReadiness(snapshot) {
        if (transportGeneration !== snapshot.generation || activeRuntimeBinding !== snapshot.binding
            || activeOrigin?.key !== snapshot.origin.key
            || ws !== snapshot.socket || stopped || !negotiated || snapshot.socket.readyState !== WebSocket.OPEN) {
            throw new Error("Connector outbound readiness generation is no longer current");
        }
        const current = configuredOutboundBinding(currentAgentConfig());
        if (runtimeBindingRestartRequired || !current || !sameRuntimeBinding(current, snapshot.binding)
            || snapshot.binding.backendUrl !== snapshot.origin.backendUrl
            || snapshot.binding.connectorId !== snapshot.origin.connectorId
            || accountId !== snapshot.origin.accountId) {
            runtimeBindingRestartRequired = true;
            throw new Error("Current configuration no longer matches the authenticated outbound origin");
        }
    }
    // The agents this account offers its organization (src/accounts.ts).
    function currentAgentAnnouncement() {
        const cfg = currentAgentConfig();
        if (!accountEnabled(cfg, accountId))
            return [];
        // Keep the SDK distinction between absent and explicitly empty rosters.
        return accountAgentIds(cfg, accountId).map((id) => ({
            id,
            name: resolveAgentIdentity(cfg, id)?.name?.trim() || id,
        })).sort((a, b) => a.id.localeCompare(b.id));
    }
    async function announceAgents(sendFrame, agents = currentAgentAnnouncement()) {
        sendFrame({ type: "agents.announce", agents });
        return new Set(agents.map((agent) => agent.id));
    }
    function rejectPendingOutbound(error) {
        for (const pending of pendingOutbound.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        pendingOutbound.clear();
    }
    function wakeReadinessWaiters() {
        for (const wake of [...readinessWaiters])
            wake();
    }
    function waitForReadinessChange(ms, signal) {
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                readinessWaiters.delete(wake);
                signal?.removeEventListener("abort", wake);
                resolve();
            };
            const timer = setTimeout(wake, ms);
            readinessWaiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
        });
    }
    async function awaitOutboundReadiness(signal) {
        for (;;) {
            if (signal?.aborted)
                throw signal.reason instanceof Error ? signal.reason : new Error("Outbound delivery was cancelled");
            const readiness = captureOutboundReadiness(currentAgentConfig());
            if (readiness)
                return readiness;
            const now = Date.now();
            connectorUnavailableSince ??= now;
            const remaining = connectorUnavailableSince + OUTBOUND_READY_WAIT_MS - now;
            // Only a running transport can become ready; a stopped, fatal or
            // restart-required one fails fast, like a connector past the window.
            if (remaining <= 0 || !transportGeneration || stopped || fatalTransportError || runtimeBindingRestartRequired) {
                throw new Error("Connector is not ready with a current authenticated and explicitly pinned outbound origin");
            }
            await waitForReadinessChange(Math.min(remaining, OUTBOUND_READY_WAIT_MS), signal);
        }
    }
    function awaitReply(kind, key) {
        let pending;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingOutbound.delete(key);
                reject(new Error(`Timed out waiting for backend ${kind} receipt`));
            }, OUTBOUND_RECEIPT_TIMEOUT_MS);
            pending = { resolve, reject, timer };
        });
        pendingOutbound.set(key, pending);
        return {
            promise,
            cancel: () => {
                clearTimeout(pending.timer);
                if (pendingOutbound.get(key) === pending)
                    pendingOutbound.delete(key);
            },
        };
    }
    function requestOutbound(kind, outboundId, frame, options = {}) {
        const key = outboundKey(kind, outboundId);
        const active = activeOutboundRequests.get(key);
        if (active)
            return active;
        const request = writeOutboundFrame(kind, key, frame, options).finally(() => activeOutboundRequests.delete(key));
        activeOutboundRequests.set(key, request);
        return request;
    }
    async function writeOutboundFrame(kind, key, frame, options) {
        // Set once a written frame lost its socket. From then on the outcome is
        // unknown, so a send must never report the not-dispatched marker.
        let lastClose;
        for (let writes = 0;;) {
            let readiness;
            try {
                readiness = await awaitOutboundReadiness(options.signal);
                assertCurrentOutboundReadiness(readiness);
            }
            catch (error) {
                throw unwrittenFailure(kind, error, lastClose);
            }
            try {
                // Core's custody fence may have changed while the connector was awaited.
                // Nothing is written if it fails. Core re-applies the fence when its queue
                // retries, so waiting must not turn a custody change into a permanent drop.
                options.assertHandoff?.();
                options.assertSocket?.(readiness.socket);
            }
            catch (error) {
                throw unwrittenFailure(kind, new Error(error instanceof Error ? error.message : String(error)), lastClose);
            }
            const reply = awaitReply(kind, key);
            try {
                readiness.socket.send(JSON.stringify(frame));
            }
            catch (error) {
                // A synchronous ws.send throw means this frame never left the process.
                reply.cancel();
                throw unwrittenFailure(kind, error, lastClose);
            }
            writes += 1;
            try {
                return await reply.promise;
            }
            catch (error) {
                // The frame may have reached the backend before the socket closed.
                // Writing the identical frame again is safe: the backend stores at most
                // one message per outbound_id and answers with its receipt.
                if (!(error instanceof ConnectorSocketClosedError) || writes >= MAX_OUTBOUND_WRITES)
                    throw error;
                lastClose = error;
            }
        }
    }
    function settlePending(key, value) {
        const pending = pendingOutbound.get(key);
        if (!pending)
            return false;
        pendingOutbound.delete(key);
        clearTimeout(pending.timer);
        if (value instanceof Error)
            pending.reject(value);
        else
            pending.resolve(value);
        return true;
    }
    function handleOutboundControlFrame(frame) {
        if (frame.type === "message.post.receipt" || frame.type === "message.post.refused") {
            const postId = typeof frame.post_id === "string" ? frame.post_id : "";
            if (!postId)
                return false;
            if (frame.type === "message.post.refused") {
                const reason = typeof frame.reason === "string" ? frame.reason : "refused";
                return settlePending(outboundKey("post", postId), new PostRefusedError(reason));
            }
            const messageId = typeof frame.message_id === "string" ? frame.message_id : "";
            if (!messageId)
                throw new Error("Backend post receipt omitted message identity");
            return settlePending(outboundKey("post", postId), { status: "sent", messageId });
        }
        const outboundId = typeof frame.outbound_id === "string" ? frame.outbound_id : "";
        if (!outboundId)
            return false;
        if (frame.type === "message.outbound.receipt") {
            const messageId = typeof frame.message_id === "string" ? frame.message_id : "";
            if (!messageId)
                throw new Error("Backend outbound receipt omitted message identity");
            return settlePending(outboundKey("send", outboundId), { status: "sent", messageId });
        }
        if (frame.type === "message.outbound.rejected") {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("send", outboundId), new OutboundRejectedError(reason));
        }
        if (frame.type === "message.outbound.status.result") {
            if (frame.status === "not_sent") {
                return settlePending(outboundKey("status", outboundId), { status: "not_sent" });
            }
            const messageId = typeof frame.message_id === "string" ? frame.message_id : "";
            if (frame.status !== "sent" || !messageId)
                throw new Error("Backend returned an invalid outbound status receipt");
            return settlePending(outboundKey("status", outboundId), {
                status: "sent",
                messageId,
                ...(typeof frame.body_matches === "boolean" ? { bodyMatches: frame.body_matches } : {}),
            });
        }
        if (frame.type === "message.react.result") {
            const messageId = typeof frame.message_id === "string" ? frame.message_id : "";
            if (!messageId)
                throw new Error("Backend reaction receipt omitted message identity");
            return settlePending(outboundKey("react", outboundId), { status: "sent", messageId });
        }
        if (frame.type === "message.react.rejected") {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("react", outboundId), new Error(`Backend rejected reaction: ${reason}`));
        }
        if (frame.type === "log_book.result") {
            return settlePending(outboundKey("log", outboundId), { status: "log_book", frame });
        }
        if (frame.type === "log_book.rejected") {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("log", outboundId), new LogBookRefusedError(reason));
        }
        if (frame.type === "audit.result") {
            return settlePending(outboundKey("audit", outboundId), { status: "audit", frame });
        }
        if (frame.type === "audit.rejected") {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("audit", outboundId), new AuditRefusedError(reason));
        }
        if (frame.type === HISTORY_RESULT) {
            return settlePending(outboundKey("history", outboundId), { status: "channel_history", frame });
        }
        if (frame.type === HISTORY_REJECTED) {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("history", outboundId), new ChannelHistoryRefusedError(reason));
        }
        if (frame.type === TITLE_RESULT) {
            return settlePending(outboundKey("title", outboundId), { status: "session_title", frame });
        }
        if (frame.type === TITLE_REJECTED) {
            const reason = typeof frame.reason === "string" ? frame.reason : "rejected";
            return settlePending(outboundKey("title", outboundId), new SessionTitleRefusedError(reason));
        }
        return false;
    }
    async function sendOutbound(params) {
        if (!params.outboundId || !params.eventId || !params.channelId) {
            throw new Error("Stable outbound, parent event, and channel identities are required");
        }
        // Everything before the frame is written is pre-dispatch: a connector that is
        // not ready within the wait window (or a host runtime that is not up yet)
        // throws the SDK's retryable not-dispatched marker so core keeps the queued
        // reply and retries it.
        const result = await requestOutbound("send", params.outboundId, outboundFrame(params, params.body, params.place, params.notice, params.progress, params.attachments), { signal: params.signal, assertHandoff: params.assertHandoff });
        if (result.status !== "sent")
            throw new Error("Backend did not accept outbound intent");
        return result.messageId;
    }
    /**
     * Posts an agent's message that answers no message (1.10.0) and returns the
     * ids of the messages it became, in order. The backend posts it top-level in
     * the conversation, as this connector's one agent there, under the fences an
     * agent's reply has, and answers `message.post.receipt` or
     * `message.post.refused` (PostRefusedError, with its reason). A long post
     * goes in parts, as a reply does (sendOutboundReply): each part under
     * replyPartOutboundId of the post's id, the next one only after the receipt
     * for the one before. The backend keeps one message per connector and id, so
     * writing a part again after a lost socket posts nothing twice, and reading
     * a reply back by its queue id (reconcileOutboundReply) reads a post too.
     */
    async function sendAgentPost(params) {
        if (!params.postId || !params.channelId)
            throw new Error("Stable post and channel identities are required");
        const limits = partLimits(params.postId, (longest, place) => postFrame({ ...params, postId: longest }, "", place, longestAttachments(params.attachments)));
        let bodies = splitReply(params.text, limits);
        let files = params.attachments?.length ? params.attachments : undefined;
        const messageIds = [];
        for (let index = 0; index < bodies.length; index += 1) {
            const postId = replyPartOutboundId(params.postId, index);
            const place = bodies.length > 1 ? { replyId: params.postId, part: index + 1, parts: bodies.length } : undefined;
            const named = index === bodies.length - 1 ? files : undefined;
            try {
                const result = await requestOutbound("post", postId, postFrame({ postId, channelId: params.channelId }, bodies[index], place, named), { signal: params.signal, assertHandoff: params.assertHandoff });
                if (result.status !== "sent")
                    throw new Error("Backend did not accept the post");
                messageIds.push(result.messageId);
            }
            catch (error) {
                if (named && error instanceof PostRefusedError && FILE_REFUSALS.has(error.reason)) {
                    // The backend took none of the files: this part again without them.
                    files = undefined;
                    bodies = partsWithoutFiles(bodies, index, params.textWithoutFiles, limits);
                    index -= 1;
                    continue;
                }
                if (params.attachments !== undefined && error instanceof PostRefusedError && error.reason === "identity_conflict") {
                    const saved = await reconcileOutbound(postId);
                    if (saved.status === "sent") {
                        // Core sent this post again and a file's outcome changed since: the
                        // message saved the first time stands for this part.
                        messageIds.push(saved.messageId);
                        continue;
                    }
                }
                if (index === 0)
                    throw error;
                // Earlier parts were posted: the SDK's not-dispatched marker must not reach core.
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`Part ${index + 1} of ${bodies.length} of the post was not confirmed: ${reason}`);
            }
        }
        return messageIds;
    }
    /**
     * Sends an agent reply and returns the ids of the messages it became, in order.
     * A reply over the backend's limits goes out as several messages
     * (reply-parts.ts), each answering the same event, so the backend files every
     * part where it files a reply: in that event's thread, or top-level. A part is
     * written only once the one before it has its receipt, so the backend never
     * holds a later part without the earlier ones.
     *
     * OpenClaw 2026.9.8 can cut a reply itself for a channel that declares a
     * chunker, but core then records the first delivered part as an outcome it
     * cannot know (unknown_after_send), and its recovery replays no such reply
     * unless reconciliation proves it was sent whole: a failure between parts
     * would lose the rest. Cut here, the reply stays one send for core. Its
     * dispatch is reported once, after the last receipt (channel.ts), and a failure
     * before then leaves core to replay the whole reply. Each part keeps its
     * outbound id and its text, so the backend answers the parts it already holds
     * with their receipts and stores the rest: nothing is posted twice.
     *
     * Every part's frame names the reply, the part's place and how many parts
     * there are (reply_id, part, parts), so the backend counts and pushes the
     * reply once, wakes each agent it names once, and takes the delivery as
     * answered only at the last part. A reply that fits in one message goes out
     * exactly as before, with none of them.
     *
     * Sent while this connector's turn for that message runs and before core
     * hands the channel the turn's reply (the agent's message tool, 1.10.0), it
     * is the agent's progress: every frame says `progress: true`, the backend
     * shows it and the turn goes on, and the turn remembers its last frame
     * (endTurnOnProgress). Core hands the channel each reply of a turn through
     * the plan's preparePayload before sending it (src/host-dispatch.ts), in
     * OpenClaw 2026.9.8 and 2026.10.3 alike; a queue id tells nothing, since
     * core queues message tool sends too.
     */
    async function sendOutboundReply(params) {
        if (!params.outboundId || !params.eventId || !params.channelId) {
            throw new Error("Stable outbound, parent event, and channel identities are required");
        }
        const turn = activeTurns.get(params.eventId);
        const progress = turn !== undefined && !turn.replying;
        const limits = replyPartLimits(params, progress, params.attachments);
        let bodies = splitReply(params.text, limits);
        let files = params.attachments?.length ? params.attachments : undefined;
        const messageIds = [];
        let last;
        for (let index = 0; index < bodies.length; index += 1) {
            // The reply's files go with its last part (1.11.0).
            const named = index === bodies.length - 1 ? files : undefined;
            try {
                last = {
                    outboundId: replyPartOutboundId(params.outboundId, index),
                    eventId: params.eventId,
                    channelId: params.channelId,
                    body: bodies[index],
                    place: bodies.length > 1 ? { replyId: params.outboundId, part: index + 1, parts: bodies.length } : undefined,
                    ...(named ? { attachments: [...named] } : {}),
                };
                messageIds.push(await sendOutbound({ ...last, progress, signal: params.signal, assertHandoff: params.assertHandoff }));
            }
            catch (error) {
                if (named && error instanceof OutboundRejectedError && FILE_REFUSALS.has(error.reason)) {
                    // The backend took none of the files (one was deleted or passed its
                    // seven days meanwhile): this part again without them.
                    files = undefined;
                    bodies = partsWithoutFiles(bodies, index, params.textWithoutFiles, limits);
                    index -= 1;
                    continue;
                }
                if (params.attachments !== undefined && error instanceof OutboundRejectedError
                    && error.reason === "identity_conflict") {
                    const saved = await reconcileOutbound(replyPartOutboundId(params.outboundId, index));
                    if (saved.status === "sent") {
                        // Core sent this reply again and a file's outcome changed since
                        // (the file is gone from the Gateway, or the backend refused it
                        // this time): the message saved the first time stands for this part.
                        messageIds.push(saved.messageId);
                        continue;
                    }
                }
                if (index === 0) {
                    const saved = bodies.length > 1 && error instanceof OutboundRejectedError && error.reason === "identity_conflict"
                        ? await continueWholeSave(params, limits)
                        : undefined;
                    if (!saved)
                        throw error;
                    // The saved message stands for part 1; the rest follows it.
                    messageIds.push(saved.messageId);
                    bodies = [bodies[0], ...saved.rest];
                    continue;
                }
                // Earlier parts reached the backend, so the reply was dispatched: the
                // SDK's not-dispatched marker must not reach core, not even as a cause.
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`Part ${index + 1} of ${bodies.length} of the reply was not confirmed: ${reason}`);
            }
        }
        if (progress && turn && last)
            turn.lastProgress = last;
        return messageIds;
    }
    /**
     * Uploads a reply's files (1.11.0, src/reply-media.ts), in order, until five
     * are kept, and answers the ids the backend gave them and how many could not
     * be delivered. Each is read through core's media loader (with the send's
     * media access), then sent with this connector's credential to
     * POST /api/connector/files for the reply's delivery (its event id) or, for a
     * post, its conversation, named by the reply's outbound id and the file's
     * place in it. The backend keeps one file per connector, reply and place, and
     * this account remembers the ids it was given, so a reply core sends again
     * uploads nothing twice. A file that cannot be read, is over 5 MB or past
     * the five, or that the backend refuses, is counted, not sent; an answer that
     * says no file can be uploaded now (no file storage, an older backend
     * without the route, the credential, the rate limit) counts the rest too.
     * Never throws for a file: only a connector that is not ready fails, as a
     * reply would, before anything is uploaded.
     */
    async function uploadReplyFiles(params) {
        let readiness;
        try {
            readiness = await awaitOutboundReadiness(params.signal);
            assertCurrentOutboundReadiness(readiness);
        }
        catch (error) {
            throw notDispatched(error);
        }
        const fileIds = [];
        let failed = 0;
        let stop;
        for (let index = 0; index < params.mediaUrls.length; index += 1) {
            if (stop !== undefined || fileIds.length >= MAX_REPLY_FILES || index > UPLOAD_INDEX_MAX) {
                failed += 1;
                continue;
            }
            const mediaUrl = params.mediaUrls[index];
            const key = JSON.stringify([readiness.binding.backendUrl, readiness.binding.connectorId, params.channelId,
                params.eventId ?? null, params.outboundId, index]);
            const remembered = uploadedFiles.get(key);
            if (remembered) {
                fileIds.push(remembered);
                continue;
            }
            try {
                const file = await loadFile(mediaUrl, params.access);
                if (file.buffer.byteLength > MAX_REPLY_FILE_BYTES)
                    throw new Error("the file is larger than 5 MB");
                // Core's custody fence, before anything leaves for the backend.
                params.assertHandoff?.();
                const fileId = await uploadReplyFile(readiness.binding, params, index, file, params.signal);
                uploadedFiles.set(key, fileId);
                if (uploadedFiles.size > REMEMBERED_UPLOADS)
                    uploadedFiles.delete(uploadedFiles.keys().next().value);
                fileIds.push(fileId);
            }
            catch (error) {
                failed += 1;
                const reason = error instanceof Error ? error.message : String(error);
                if (error instanceof ReplyFileRefusedError && error.stopsReply)
                    stop = reason;
                hostApi?.logger.warn(`${log} file ${index + 1} of ${params.mediaUrls.length} of a reply couldn't be delivered: ${reason}`);
            }
        }
        return { fileIds, failed };
    }
    // One upload; the file's id, or ReplyFileRefusedError with the backend's answer.
    async function uploadReplyFile(binding, target, index, file, signal) {
        const query = new URLSearchParams({ channel_id: target.channelId, outbound_id: target.outboundId, index: String(index) });
        if (target.eventId)
            query.set("event_id", target.eventId);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.contentType || "application/octet-stream" }), file.fileName || `attachment-${index + 1}`);
        const timeout = AbortSignal.timeout(REPLY_FILE_UPLOAD_TIMEOUT_MS);
        let response;
        try {
            response = await fetchFile(`${httpBase(binding.backendUrl)}/api/connector/files?${query}`, {
                method: "POST",
                headers: { authorization: `Bearer ${binding.connectorToken}` },
                body: form,
                // The connector's credential goes to its own backend only.
                redirect: "error",
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
        }
        catch {
            throw new ReplyFileRefusedError(0, "");
        }
        let answer;
        try {
            answer = await response.json();
        }
        catch {
            answer = undefined;
        }
        const fields = answer && typeof answer === "object" ? answer : {};
        if (!response.ok)
            throw new ReplyFileRefusedError(response.status, typeof fields.code === "string" ? fields.code : "");
        if (typeof fields.file_id !== "string" || !FILE_ID.test(fields.file_id)) {
            throw new ReplyFileRefusedError(response.status, "unexpected_answer");
        }
        return fields.file_id;
    }
    /**
     * Plugins before 1.2.0 sent a reply whole, in one frame, under the queue id
     * that a reply's first part now uses. If such a frame was saved but its receipt
     * was lost (say the Gateway restarted onto this version), core's replay meets
     * that message, and the backend refuses part 1 (identity_conflict). If the
     * backend confirms that the message is exactly what that frame was saved as
     * (wholeReplySave), it stands for part 1, and the reply goes on after the
     * characters it kept, with nothing posted twice. Otherwise, as with any other
     * refusal, undefined.
     */
    async function continueWholeSave(params, limits) {
        const saved = wholeReplySave(params.text);
        const status = await reconcileOutbound(params.outboundId, createHash("sha256").update(saved.body, "utf8").digest("hex"));
        if (status.status !== "sent" || status.bodyMatches !== true)
            return undefined;
        return { messageId: status.messageId, rest: splitReplyFrom(params.text, limits, saved.kept) };
    }
    /**
     * Adds or removes the agent's reaction on a message the backend delivered to
     * it, named by that delivery's event id. The backend checks that the event went
     * to this agent, and a reaction wakes no agent and sends no push. Writing the
     * frame again after a closed socket is safe: adding or removing one reaction
     * twice changes nothing. Returns the reacted message's id.
     */
    async function sendReaction(params) {
        if (!params.eventId || !params.emoji)
            throw new Error("A reaction needs the message's event id and an emoji");
        const outboundId = randomUUID();
        const result = await requestOutbound("react", outboundId, {
            type: "message.react",
            outbound_id: outboundId,
            event_id: params.eventId,
            emoji: params.emoji,
            remove: params.remove,
            ...(params.agentId ? { agent_id: params.agentId } : {}),
        }, { assertHandoff: params.assertHandoff });
        if (result.status !== "sent")
            throw new Error("Backend did not apply the reaction");
        return result.messageId;
    }
    // With bodySha256, the backend also answers whether the message it holds under
    // this id is a whole reply with exactly that SHA-256 (body_matches).
    async function reconcileOutbound(outboundId, bodySha256) {
        if (!outboundId)
            throw new Error("Stable outbound identity is required for reconciliation");
        const result = await requestOutbound("status", outboundId, {
            type: "message.outbound.status",
            outbound_id: outboundId,
            ...(bodySha256 ? { body_sha256: bodySha256 } : {}),
        });
        // Only a status receipt settles a status query (handleOutboundControlFrame).
        if (result.status === "log_book" || result.status === "audit" || result.status === "channel_history"
            || result.status === "session_title") {
            throw new Error("Backend returned an invalid outbound status receipt");
        }
        return result;
    }
    /**
     * Reads back the messages a reply became, by the outbound ids
     * sendOutboundReply gave its parts. The parts were written in order, each
     * after the receipt for the one before, so the read stops at the first part
     * the backend does not hold. Without the first part, nothing of the reply was
     * stored: "not_sent".
     */
    async function reconcileOutboundReply(outboundId) {
        const messageIds = [];
        for (let index = 0; index < MAX_RECONCILED_PARTS; index += 1) {
            const result = await reconcileOutbound(replyPartOutboundId(outboundId, index));
            if (result.status === "not_sent")
                break;
            messageIds.push(result.messageId);
        }
        return messageIds.length > 0 ? { status: "sent", messageIds } : { status: "not_sent" };
    }
    /**
     * Sends a log book request (src/log-book.ts) with a fresh `outbound_id` and
     * returns the backend's `log_book.result` as it came; a `log_book.rejected`
     * throws LogBookRefusedError with its reason. It goes only on a socket whose
     * backend offered the log book, waits for the connector like a reply does,
     * and is written again after a closed socket: the backend adds an entry once
     * per connector and outbound_id, so an entry is never added twice.
     */
    async function requestLogBook(request, options = {}) {
        const outboundId = randomUUID();
        const result = await requestOutbound("log", outboundId, { ...request, outbound_id: outboundId }, {
            signal: options.signal,
            assertHandoff: options.assertHandoff,
            assertSocket: (socket) => {
                if (!logBookSockets.has(socket))
                    throw new Error("This Octopus Prime server does not offer the project log book");
            },
        });
        if (result.status !== "log_book")
            throw new Error("Backend did not answer the log book request");
        return result.frame;
    }
    /**
     * Sends an auditor's read (src/audited-workspace.ts) with a fresh
     * `outbound_id` and returns the backend's `audit.result` as it came; an
     * `audit.rejected` throws AuditRefusedError with its reason. It waits for
     * the connector like a reply does and is written again after a closed
     * socket: a read changes nothing, and the backend records each one it
     * answers. No welcome capability gates it; the tool is offered only where a
     * message frame said the workspace is audited, which only a backend that
     * answers these frames says.
     */
    async function requestAudit(request, options = {}) {
        const outboundId = randomUUID();
        const { type, ...fields } = request;
        const result = await requestOutbound("audit", outboundId, { type, outbound_id: outboundId, ...fields }, {
            signal: options.signal,
            assertHandoff: options.assertHandoff,
        });
        if (result.status !== "audit")
            throw new Error("Backend did not answer the audit request");
        return result.frame;
    }
    // Whether this account's current connection is to a backend that offered the project folder.
    function folderOffered() {
        return Boolean(ws && negotiated && folderSockets.has(ws));
    }
    // Whether this account's current connection is to a backend that offered channel history.
    function historyOffered() {
        return Boolean(ws && negotiated && historySockets.has(ws));
    }
    /**
     * Sends a channel history read (src/channel-history.ts) with a fresh
     * `outbound_id` and returns the backend's `channel_history.result` as it
     * came; a `channel_history.rejected` throws ChannelHistoryRefusedError with
     * its reason. It goes only on a socket whose backend offered channel
     * history, waits for the connector like a reply does, and is written again
     * after a closed socket: a read changes nothing.
     */
    async function requestChannelHistory(request, options = {}) {
        const outboundId = randomUUID();
        const result = await requestOutbound("history", outboundId, { ...request, outbound_id: outboundId }, {
            signal: options.signal,
            assertHandoff: options.assertHandoff,
            assertSocket: (socket) => {
                if (!historySockets.has(socket))
                    throw new Error("This Octopus Prime server does not offer channel history");
            },
        });
        if (result.status !== "channel_history")
            throw new Error("Backend did not answer the channel history request");
        return result.frame;
    }
    // Whether this account's current connection is to a backend that offered session titles.
    function titleOffered() {
        return Boolean(ws && negotiated && titleSockets.has(ws));
    }
    /**
     * Sends a session title call (src/session-title.ts) with a fresh
     * `outbound_id` and returns the backend's `session_title.result` as it came;
     * a `session_title.rejected` throws SessionTitleRefusedError with its
     * reason. It goes only on a socket whose backend offered session titles,
     * waits for the connector like a reply does, and is written again after a
     * closed socket: the backend counts no rename that leaves the title as it
     * is, so a name set twice is set once.
     */
    async function requestSessionTitle(request, options = {}) {
        const outboundId = randomUUID();
        const result = await requestOutbound("title", outboundId, { ...request, outbound_id: outboundId }, {
            signal: options.signal,
            assertHandoff: options.assertHandoff,
            assertSocket: (socket) => {
                if (!titleSockets.has(socket))
                    throw new Error("This Octopus Prime server does not offer session titles");
            },
        });
        if (result.status !== "session_title")
            throw new Error("Backend did not answer the session title request");
        return result.frame;
    }
    /**
     * Sends a project folder call (src/project-folder.ts) and returns the
     * backend's `folder.result` as it came; a `folder.rejected` throws
     * FolderRefusedError with its reason and answer. It waits for the connector
     * like a reply does and goes only to a backend whose welcome on the current
     * connection offered the project folder, then POSTs the frame to
     * /api/connector/folder with this connector's credential, once: a lost
     * answer to an edit is never written again, and the edit sent again from
     * the same version is refused as changed, so nothing is saved twice.
     */
    async function requestFolder(request, options = {}) {
        const body = folderBody(request);
        const readiness = await awaitOutboundReadiness(options.signal);
        assertCurrentOutboundReadiness(readiness);
        // Core's custody fence, before anything leaves for the backend.
        options.assertHandoff?.();
        if (!folderSockets.has(readiness.socket))
            throw new Error("This Octopus Prime server does not offer the project folder");
        const timeout = AbortSignal.timeout(FOLDER_REQUEST_TIMEOUT_MS);
        let response;
        try {
            response = await fetchFile(`${httpBase(readiness.binding.backendUrl)}/api/connector/folder`, {
                method: "POST",
                headers: { authorization: `Bearer ${readiness.binding.connectorToken}`, "content-type": "application/json" },
                body,
                // The connector's credential goes to its own backend only.
                redirect: "error",
                signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
            });
        }
        catch {
            throw new Error("The Octopus Prime server could not be reached for the project folder; try again in a moment");
        }
        let answer;
        try {
            answer = await response.json();
        }
        catch {
            answer = undefined;
        }
        const frame = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
        if (response.status === 429)
            throw new Error("Too many project folder calls just now; wait a moment and try again");
        if (!response.ok)
            throw new Error(`The Octopus Prime server refused the project folder call (${response.status})`);
        if (frame.type === FOLDER_REJECTED) {
            throw new FolderRefusedError(typeof frame.reason === "string" ? frame.reason : "rejected", frame);
        }
        if (frame.type !== FOLDER_RESULT)
            throw new Error("Backend did not answer the project folder request");
        return frame;
    }
    /**
     * The latest CONTEXT.md of a message's project, for a new session's start
     * (src/host-dispatch.ts), shortened by the backend to what a session starts
     * with. Best effort: no answer within SESSION_LOG_BOOK_WAIT_MS, a refusal, a
     * cancelled turn or a backend without the log book only logs a warning, and
     * the turn goes on without it.
     */
    async function sessionLogBook(frame, signal) {
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(new Error(`no answer within ${SESSION_LOG_BOOK_WAIT_MS / 1_000} seconds`)), SESSION_LOG_BOOK_WAIT_MS);
        const cancel = () => stop.abort(new Error("the turn was cancelled"));
        signal?.addEventListener("abort", cancel, { once: true });
        const stopped = new Promise((_resolve, reject) => {
            stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true });
        });
        try {
            if (signal?.aborted)
                cancel();
            const answer = await Promise.race([
                requestLogBook({
                    type: READ_FRAME, channel_id: frame.channel_id, agent_id: frame.agent_id, file: "CONTEXT.md", purpose: "session",
                }, { signal: stop.signal }),
                stopped,
            ]);
            return logBookAnswer(answer);
        }
        catch (error) {
            hostApi?.logger.warn(`${log} project log book was not added to the new session: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
        }
    }
    /**
     * The backend asks this Gateway to restart (`gateway.reset`, 1.22.0,
     * src/gateway-reset.ts), on this account's negotiated socket. Refused with
     * its reason unless the Gateway allows it and no restart was agreed within
     * RESET_EVERY_MS; otherwise answered "restarting", and once the frames this
     * Gateway's connectors still wait on are answered (FLUSH_WAIT_MS at most)
     * OpenClaw is asked to restart. The answer goes before anything restarts.
     */
    function handleGatewayReset(frame, sendFrame) {
        const requestId = resetRequestId(frame);
        if (!requestId)
            return true;
        const refusal = takeReset(currentAgentConfig());
        if (refusal) {
            sendFrame({ type: RESET_REJECTED, request_id: requestId, reason: refusal });
            hostApi?.logger.warn(`${log} a restart asked from Octopus Prime was refused (${refusal})`
                + (refusal === "not_allowed" ? `; to allow it, run: ${ALLOW_COMMAND}` : ""));
            return true;
        }
        sendFrame({ type: RESET_RESULT, request_id: requestId, status: "restarting" });
        hostApi?.logger.warn(`${log} a restart was asked from Octopus Prime; restarting this Gateway`);
        const restart = restartGateway;
        void outboundSettled(FLUSH_WAIT_MS).then(() => {
            try {
                restart();
            }
            catch (error) {
                hostApi?.logger.error(`${log} the Gateway could not be restarted: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        return true;
    }
    /**
     * A message an agent of this account already received was edited (1.26.0,
     * `message.edited`, src/message-edited.ts): its new text is queued as
     * context on that agent's session for the conversation, never as a turn.
     * Only for an agent this account announces and offers now (`allowed`, as
     * for a message.inbound frame); a frame that cannot be read is ignored.
     * Nothing is answered.
     */
    function handleMessageEdited(raw, allowed) {
        const frame = parseMessageEdited(raw);
        if (!frame || !hostApi || !allowed(frame.agent_id))
            return true;
        try {
            if (!noteMessageEdited(hostApi, accountId, frame)) {
                hostApi.logger.warn(`${log} an edited message could not be kept as the agent's context`);
            }
        }
        catch (error) {
            hostApi.logger.warn(`${log} an edited message could not be kept as the agent's context: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
    }
    return {
        start, stop, status, sendOutboundReply, sendAgentPost, uploadReplyFiles, reconcileOutboundReply, sendReaction,
        requestLogBook, requestAudit, requestFolder, folderOffered, requestChannelHistory, historyOffered,
        requestSessionTitle, titleOffered, handleGatewayReset, pendingCount: () => pendingOutbound.size,
    };
}
