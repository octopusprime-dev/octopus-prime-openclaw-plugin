/**
 * What each agent's turns cost (1.30.0). Once a turn completes, the transport
 * reads that turn's session row through the SDK's session store (the same
 * read-only lookup session stats use, src/session-stats.ts) and, to a backend
 * whose welcome offered `agent-usage`, sends one `agent.usage` frame naming
 * the event the turn answered: the model and provider that ran it, its input,
 * output and cache tokens, and its cost in US dollars as OpenClaw estimated it
 * from its price list (or null when OpenClaw has no price for the model).
 * OpenClaw keeps each run's usage on the session row, replacing the last
 * run's, so the row after a turn holds that turn's usage. Numbers and model
 * names only: never a message, a prompt, a reply or a tool call.
 *
 * Counted once: a row OpenClaw did not write during the turn (a slash command
 * answered without the model), or one whose usage is exactly what was last
 * reported for that session, is the last run's and is not sent again; the
 * backend counts each event once besides.
 */
export const USAGE_FRAME = "agent.usage";
// The backend's bounds (backend/agent_usage.py); beyond them a number is no measurement.
const TOKENS_MAX = 1_000_000_000;
const COST_MAX_USD = 10_000;
const NAME_MAX = 128;
// Sessions whose last report one account remembers.
const REMEMBERED_SESSIONS = 1_000;
function count(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return 0;
    const whole = Math.floor(value);
    return whole >= 0 && whole <= TOKENS_MAX ? whole : 0;
}
function name(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    // No control characters (the backend refuses them).
    return trimmed && trimmed.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}
function cost(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= COST_MAX_USD ? value : null;
}
/**
 * The usage a session row holds for its latest run, or null when it holds
 * none: no row, or no tokens and no cost.
 */
export function usageFromEntry(entry) {
    if (!entry)
        return null;
    const usage = {
        provider: name(entry.modelProvider),
        model: name(entry.model),
        input_tokens: count(entry.inputTokens),
        output_tokens: count(entry.outputTokens),
        cache_read_tokens: count(entry.cacheRead),
        cache_write_tokens: count(entry.cacheWrite),
        cost_usd: cost(entry.estimatedCostUsd),
        cost_source: null,
    };
    if (usage.cost_usd !== null)
        usage.cost_source = "estimate";
    const tokens = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    return tokens > 0 || usage.cost_usd !== null ? usage : null;
}
export function usageFrame(eventId, agentId, usage) {
    return { type: USAGE_FRAME, event_id: eventId, agent_id: agentId, ...usage };
}
/**
 * The usage of the turn that just ended, or null: none, or the row was not
 * written since `startedAt` (epoch ms), or it is what `memory` last reported
 * for this session. A usage returned is remembered as reported.
 */
export function turnUsage(entry, startedAt, sessionKey, memory) {
    const usage = usageFromEntry(entry);
    if (!usage || !entry)
        return null;
    if (typeof entry.updatedAt !== "number" || entry.updatedAt < startedAt)
        return null;
    const fingerprint = JSON.stringify([entry.sessionId ?? null, usage]);
    return memory.fresh(sessionKey, fingerprint) ? usage : null;
}
/** The last usage reported for each session, newest kept. */
export class UsageMemory {
    last = new Map();
    /** Whether `fingerprint` differs from the session's last; remembers it. */
    fresh(sessionKey, fingerprint) {
        if (this.last.get(sessionKey) === fingerprint)
            return false;
        this.last.delete(sessionKey);
        this.last.set(sessionKey, fingerprint);
        while (this.last.size > REMEMBERED_SESSIONS)
            this.last.delete(this.last.keys().next().value);
        return true;
    }
    get size() {
        return this.last.size;
    }
}
