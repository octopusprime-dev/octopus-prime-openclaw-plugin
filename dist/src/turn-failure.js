/**
 * A turn that ends without an answer (1.9.0).
 *
 * When an agent's turn for a person's message failed (the model stream stalled
 * and timed out, the provider refused the AI account, the run threw, or the
 * reply could not be delivered), OpenClaw sent nothing through this channel,
 * or a warning written for an operator (an error, a run id, "check the gateway
 * logs"). The person saw silence or internals. Now the channel sends one short
 * notice in that conversation, as a reply to the message, worded by what went
 * wrong and naming nothing of the Gateway, model or provider.
 *
 * The notice goes under `turn-failed:<event_id>`, so the backend keeps at most
 * one per message, and its frame says what it is (`notice: "turn_failed"` and
 * `cause`, the backend's agent-reply-timeout contract).
 * Such a backend saves the notice in the sentence for its cause, the same on
 * the web and the iPhone, counts the turn as failed and moves the
 * conversation on; an older one ignores both fields and shows the body.
 *
 * A turn the agent chose to leave unanswered (core's NO_REPLY) is no failure
 * and gets no notice. Since 1.17.0 the channel tells the backend so with a
 * `turn.silent` frame, so that the message is settled instead of timing out
 * (backend capability `turn-silence`).
 */
import { createHash } from "node:crypto";
import { OUTBOUND_ID_MAX_LENGTH } from "./reply-parts.js";
export const TURN_FAILED_NOTICE = "turn_failed";
/** The frame that settles a message whose turn ended in silence by the agent's choice (needs the `turn-silence` capability). */
export const TURN_SILENT_FRAME = "turn.silent";
export function turnSilentFrame(frame) {
    return { type: TURN_SILENT_FRAME, event_id: frame.event_id, channel_id: frame.channel_id, agent_id: frame.agent_id, reason: "no_reply" };
}
const TEMPORARY_TEXT = "Sorry, I hit a temporary problem and did not finish. Please send that again.";
export const TURN_FAILED_TEXT = {
    temporary: TEMPORARY_TEXT,
    ai_account: "This agent's AI account needs attention (billing or sign-in). The workspace owner needs to check their OpenClaw account.",
    unknown: TEMPORARY_TEXT,
};
// An unknown cause right after another failed turn of the same conversation.
export const TURN_FAILED_SETUP_TEXT = "The workspace owner needs to check the agent's OpenClaw setup.";
/** The notice's outbound id: `turn-failed:<event_id>`, hashed when that is too long for the backend. */
export function turnFailedOutboundId(eventId) {
    const id = `turn-failed:${eventId}`;
    if (id.length <= OUTBOUND_ID_MAX_LENGTH)
        return id;
    return `turn-failed:${createHash("sha256").update(eventId).digest("hex")}`;
}
// OpenClaw's FailoverError reasons (2026.9.8 and 2026.10.3).
const ACCOUNT_REASONS = new Set(["billing", "auth", "auth_permanent", "session_expired"]);
const TEMPORARY_REASONS = new Set(["rate_limit", "overloaded", "server_error", "timeout", "empty_response", "tls_certificate"]);
const ACCOUNT_STATUS = new Set([401, 402, 403]);
const TEMPORARY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
// What core and providers write about a refused account, and about a passing problem.
const ACCOUNT_WORDS = /billing|quota|insufficient (?:credit|balance|funds)|credit balance|out of credits|payment required|api[ _-]?key|unauthori[sz]ed|authenticat|oauth|re-?auth|sign[ -]?in|log[ -]?in|credentials? (?:expired|invalid|revoked)|token (?:expired|revoked)|\b40[12]\b/i;
const TEMPORARY_WORDS = /timed? ?out|timeout|no output for|stalled|stopped making progress|interrupted|overloaded|temporar|service unavailable|currently unavailable|rate[ -]?limit|too many requests|try again (?:later|shortly)|econnreset|econnrefused|etimedout|socket hang up|network|\b(?:429|50[0234]|529)\b/i;
function record(value) {
    return value && typeof value === "object" ? value : undefined;
}
// The error and what it wraps (cause, error, errors), at most a few levels deep.
function errorChain(error) {
    const chain = [];
    const queue = [error];
    const seen = new Set();
    while (queue.length > 0 && chain.length < 12) {
        const next = record(queue.shift());
        if (!next || seen.has(next))
            continue;
        seen.add(next);
        chain.push(next);
        queue.push(next.cause, next.error, ...(Array.isArray(next.errors) ? next.errors : []));
    }
    return chain;
}
function textCause(text) {
    if (ACCOUNT_WORDS.test(text))
        return "ai_account";
    if (TEMPORARY_WORDS.test(text))
        return "temporary";
    return undefined;
}
/**
 * The cause of a failed turn, from what failed: the error the turn threw or
 * its delivery reported, and the text of the error reply core wrote for it.
 * A FailoverError's reason or an HTTP status decides first; then the words.
 */
export function classifyTurnFailure(error, failureText) {
    const chain = errorChain(error);
    for (const entry of chain) {
        const reason = typeof entry.reason === "string" ? entry.reason : undefined;
        const status = typeof entry.status === "number" ? entry.status
            : typeof entry.statusCode === "number" ? entry.statusCode : undefined;
        const message = typeof entry.message === "string" ? entry.message : "";
        if (reason && ACCOUNT_REASONS.has(reason))
            return "ai_account";
        // A provider's "quota" is the account's, even when it comes as a rate limit.
        if ((reason === "rate_limit" || status === 429) && ACCOUNT_WORDS.test(message))
            return "ai_account";
        if (reason && TEMPORARY_REASONS.has(reason))
            return "temporary";
        if (status !== undefined && ACCOUNT_STATUS.has(status))
            return "ai_account";
        if (status !== undefined && TEMPORARY_STATUS.has(status))
            return "temporary";
        if (entry.name === "TimeoutError" || entry.code === "ETIMEDOUT")
            return "temporary";
    }
    for (const entry of chain) {
        const cause = typeof entry.message === "string" ? textCause(entry.message) : undefined;
        if (cause)
            return cause;
    }
    return (failureText ? textCause(failureText) : undefined) ?? "unknown";
}
// Core's own final when a turn delivered nothing visible (2026.9.8 and
// 2026.10.3); it names a run id and the Gateway's logs.
const CORE_NO_VISIBLE_REPLY = "⚠️ OpenClaw couldn't produce or deliver a reply.";
const REPLY_KINDS = ["final", "block"];
function delivered(counts) {
    let total = 0;
    for (const kind of REPLY_KINDS) {
        const entry = counts?.[kind];
        total += typeof entry === "number" ? entry : entry?.delivered ?? 0;
    }
    return total;
}
/**
 * Watches one turn through the hooks of its plan: each reply core hands the
 * channel (preparePayload), each one delivered (onDelivered), each delivery
 * that failed (onError) and how the agent's run ended
 * (onAgentRunTerminalOutcome). These hooks are the same in OpenClaw 2026.9.8
 * and 2026.10.3. Core's error finals are kept from the person: their text is
 * written for an operator, and the notice says it instead.
 */
export function createTurnWatch() {
    let planned = false;
    let visible = false;
    let runFailed = false;
    let failureText;
    let deliveryError;
    let deliveryFailed = false;
    return {
        /** The turn has its plan: a failure from here on is the turn's, not a refusal before it. */
        planned() { planned = true; },
        preparePayload(payload, info) {
            if (info?.kind !== "final")
                return payload;
            const text = typeof payload.text === "string" ? payload.text : "";
            if (payload.isError === true) {
                failureText ??= text;
                return null;
            }
            if (text.startsWith(CORE_NO_VISIBLE_REPLY))
                return null;
            return payload;
        },
        onDelivered(_payload, info, result) {
            if (REPLY_KINDS.includes(info?.kind ?? "") && result?.visibleReplySent !== false)
                visible = true;
        },
        onError(error, info) {
            if (!REPLY_KINDS.includes(info?.kind ?? ""))
                return;
            deliveryFailed = true;
            deliveryError ??= error;
        },
        onAgentRunTerminalOutcome(outcome) {
            if (outcome === "failed")
                runFailed = true;
        },
        /**
         * The verdict once the turn ended, from its dispatch result or the error
         * it threw. A turn with a visible reply, or one whose agent chose silence,
         * answered. One that threw, whose run failed, whose error final was kept
         * back, whose reply failed to deliver, or that core found ended with no
         * visible reply, failed.
         */
        verdict(outcome) {
            if (!planned || outcome.cancelled)
                return { kind: "none" };
            const result = outcome.dispatchResult;
            if (visible || delivered(result?.settledReceipt?.counts) > 0 || result?.observedReplyDelivery)
                return { kind: "ok" };
            // Merged into the turn already running in the conversation, which answers it.
            if (result?.deferredToActiveRun)
                return { kind: "none" };
            const failed = outcome.error !== undefined || runFailed || failureText !== undefined;
            const undelivered = deliveryFailed || delivered(result?.failedCounts) > 0;
            const unanswered = result?.noVisibleReplyFallbackEligible === true || result?.noVisibleReplyFallbackDelivered === true;
            if (!failed && result?.deliberateSilentTerminalReply)
                return { kind: "silent" };
            if (!failed && !undelivered && (!unanswered || result?.settledReceipt?.hasPendingDelivery))
                return { kind: "none" };
            return { kind: "failed", cause: classifyTurnFailure(outcome.error ?? deliveryError, failureText) };
        },
    };
}
// Bounds on what is remembered: conversations with failures in a row, and the
// notice decided for each failed message.
const MAX_REMEMBERED = 1_000;
const failuresInARow = new Map();
const decidedNotices = new Map();
function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_REMEMBERED)
        map.delete(map.keys().next().value);
}
/** A turn in this conversation answered: its failures are no longer in a row. */
export function turnAnswered(accountId, channelId) {
    failuresInARow.delete(JSON.stringify([accountId, channelId]));
}
/**
 * The notice for a failed turn. A message's notice is decided once: a replay
 * of the same message that fails again gets the identical notice (the backend
 * keeps one message per outbound id and refuses another body under it), and
 * counts once toward the failures in a row. An unknown cause right after
 * another failure in the same conversation asks the owner to check the
 * agent's setup. Its cause stays `unknown`: a backend with the agent-reply-timeout contract decides
 * that from its own record of the conversation and words the notice itself;
 * an older backend shows this body.
 */
export function turnFailedNotice(target, cause) {
    const eventKey = JSON.stringify([target.accountId, target.eventId]);
    const decided = decidedNotices.get(eventKey);
    if (decided)
        return decided;
    const conversation = JSON.stringify([target.accountId, target.channelId]);
    const before = failuresInARow.get(conversation) ?? 0;
    remember(failuresInARow, conversation, before + 1);
    const body = cause === "unknown" && before > 0 ? TURN_FAILED_SETUP_TEXT : TURN_FAILED_TEXT[cause];
    const notice = { outboundId: turnFailedOutboundId(target.eventId), cause, body };
    remember(decidedNotices, eventKey, notice);
    return notice;
}
