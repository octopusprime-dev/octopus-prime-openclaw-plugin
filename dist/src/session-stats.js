import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
/**
 * How full an agent's session is (1.3.0). Once a
 * turn completes, the transport reads that turn's session row through the SDK's
 * session store (`getSessionEntry`: one read-only lookup by agent and session
 * key, no private files) and reports it in one small `session.stats` frame
 * naming the event the turn answered: the context the session uses and its
 * context window, in tokens, and how many times OpenClaw has compacted it. The
 * backend keeps the latest report on the conversation, where the apps show a
 * context meter. Nothing else goes in this frame: a turn's tokens, model and
 * cost go, only to a backend that offered agent-usage, in their own frame
 * (src/usage.ts, 1.30.0).
 */
export const SESSION_STATS_FRAME = "session.stats";
// The backend's bounds (backend/session_stats.py); beyond them a number is no measurement.
const TOKENS_MAX = 100_000_000;
const COMPACTIONS_MAX = 1_000_000;
function tokens(value, min) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    const whole = Math.floor(value);
    return whole >= min && whole <= TOKENS_MAX ? whole : null;
}
/**
 * The stats a session row holds, as OpenClaw's own /status reads them: the
 * context used is the latest run's fresh snapshot (`totalTokens`, version 1),
 * else the pre-prompt estimate OpenClaw recorded for this same session; the
 * window is the persisted `contextTokens`, else that estimate's budget. A
 * number not measured yet is null. No row, no stats.
 */
export function sessionStatsFromEntry(entry) {
    if (!entry)
        return null;
    const fresh = entry.totalTokensFresh === true && entry.totalTokensVersion === 1 ? tokens(entry.totalTokens, 1) : null;
    const budget = entry.contextBudgetStatus;
    const estimate = budget?.source === "pre-prompt-estimate" && budget.sessionId && budget.sessionId === entry.sessionId
        ? budget : undefined;
    const count = entry.compactionCount;
    return {
        context_used_tokens: fresh ?? tokens(estimate?.estimatedPromptTokens, 0),
        context_window_tokens: tokens(entry.contextTokens, 1) ?? tokens(estimate?.contextTokenBudget, 1),
        compactions: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= COMPACTIONS_MAX ? count : 0,
    };
}
export function sessionStatsFrame(eventId, agentId, stats) {
    return { type: SESSION_STATS_FRAME, event_id: eventId, agent_id: agentId, ...stats };
}
/** The SDK's read-only session row lookup. */
export const readSessionEntry = ({ agentId, sessionKey }) => getSessionEntry({ agentId, sessionKey });
export function readSessionStats(read, agentId, sessionKey) {
    return sessionStatsFromEntry(read({ agentId, sessionKey }));
}
