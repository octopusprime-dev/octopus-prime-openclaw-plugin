import { octopusSessionKey } from "./host-dispatch.js";
export const MESSAGE_EDITED_FRAME = "message.edited";
// The most of the new text the context carries; the rest is in the conversation.
export const EDITED_CONTEXT_MAX_CHARS = 4_000;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
/** The frame's facts, or undefined for a frame that lacks one (it is then ignored). */
export function parseMessageEdited(raw) {
    const sender = raw.sender;
    if (raw.type !== MESSAGE_EDITED_FRAME ||
        typeof raw.event_id !== "string" || !ID.test(raw.event_id) ||
        typeof raw.channel_id !== "string" || !ID.test(raw.channel_id) ||
        typeof raw.agent_id !== "string" || !raw.agent_id.trim() ||
        typeof raw.body !== "string" ||
        !sender || typeof sender !== "object" || typeof sender.id !== "string" || !sender.id)
        return undefined;
    if (raw.thread_id !== undefined && raw.thread_id !== null && typeof raw.thread_id !== "string")
        return undefined;
    const text = (value) => (typeof value === "string" ? value : undefined);
    return {
        type: MESSAGE_EDITED_FRAME,
        event_id: raw.event_id,
        channel_id: raw.channel_id,
        ...(raw.thread_id === undefined ? {} : { thread_id: raw.thread_id }),
        agent_id: raw.agent_id,
        sender: { id: sender.id, ...(text(sender.name) === undefined ? {} : { name: text(sender.name) }) },
        body: raw.body,
        ...(text(raw.ts) === undefined ? {} : { ts: text(raw.ts) }),
        ...(text(raw.edited_at) === undefined ? {} : { edited_at: text(raw.edited_at) }),
    };
}
/** What the agent is told: who edited which message, and how it reads now. */
export function editedContext(frame) {
    const who = frame.sender.name?.trim() || "The sender";
    const sent = frame.ts ? ` (sent ${frame.ts})` : "";
    const body = frame.body.length > EDITED_CONTEXT_MAX_CHARS
        ? `${frame.body.slice(0, EDITED_CONTEXT_MAX_CHARS)}\n[cut: the rest is in the conversation]`
        : frame.body;
    return `Octopus Prime: ${who} edited a message${sent} you already received in this conversation. `
        + `It now reads:\n${body}\n(Context only: it does not ask for a reply by itself.)`;
}
/**
 * Queues the edit as a system event on the agent's session for this
 * conversation (src/host-dispatch.ts octopusSessionKey), replacing one for the
 * same delivery that is still waiting. False when the host has no system
 * events or refused it.
 */
export function noteMessageEdited(api, accountId, frame) {
    const enqueue = api.runtime.system?.enqueueSystemEvent;
    if (typeof enqueue !== "function")
        return false;
    return enqueue(editedContext(frame), {
        sessionKey: octopusSessionKey(frame.agent_id, frame.channel_id, accountId),
        agentId: frame.agent_id,
        contextKey: `octopus-prime:edited:${frame.event_id}`,
        replace: true,
    });
}
