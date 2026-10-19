/**
 * Session titles (1.21.0). In Octopus Prime a person
 * can keep several sessions with one agent: separate direct messages with it,
 * each a fresh OpenClaw session with a title of its own in the person's list.
 * The agent in a session may name it. A backend with this task offers
 * `session-title` in its welcome (the plugin asks for it in
 * `protocol.negotiate`'s optional field) and marks each message sent in a
 * session (`agent_session: true`). Then, in a turn of that session, the agent
 * gets the `octopus_session_title` tool (src/session-title-tool.ts):
 *
 * - action "read" returns the session's title and who named it;
 * - action "set" names the session. The backend cleans the title as a
 *   person's rename (one line, single spaces), allows up to TITLE_MAX
 *   characters and a few renames per session an hour, and refuses once a
 *   person renamed the session: people win until a person clears their name.
 *
 * Every call names the conversation, the agent and the delivery (event id) of
 * the session the plugin last dispatched, never what the model passes; the
 * tool takes no conversation or agent argument at all. Without the welcome's
 * offer, or in any other conversation, nothing changes.
 */
export const SESSION_TITLE_TOOL = "octopus_session_title";
export const READ_FRAME = "session_title.read";
export const SET_FRAME = "session_title.set";
export const RESULT_FRAME = "session_title.result";
export const REJECTED_FRAME = "session_title.rejected";
// The backend's longest title (backend/agent_sessions.py TITLE_MAX), in code
// points as Python's len() counts them, after its spacing is made single.
export const TITLE_MAX = 80;
// The backend's renames per session an hour (AGENT_RENAMES_PER_HOUR).
export const RENAMES_PER_HOUR = 3;
// Kept while the Gateway runs, for the tool's factory; each turn renews its own.
const titledSessions = new Map();
const TITLED_SESSIONS_MAX = 1_000;
const sessionKeyOf = (key) => key.trim().toLowerCase();
export function rememberTitledSession(sessionKey, session) {
    const key = sessionKeyOf(sessionKey);
    titledSessions.delete(key);
    titledSessions.set(key, session);
    while (titledSessions.size > TITLED_SESSIONS_MAX) {
        titledSessions.delete(titledSessions.keys().next().value);
    }
}
/** A message without the mark (General, a channel, an older backend) ends it. */
export function forgetTitledSession(sessionKey) {
    titledSessions.delete(sessionKeyOf(sessionKey));
}
export function titledSessionFor(sessionKey) {
    return typeof sessionKey === "string" ? titledSessions.get(sessionKeyOf(sessionKey)) : undefined;
}
/** Test seam: the Gateway forgets nothing on its own until it restarts. */
export function forgetTitledSessions() {
    titledSessions.clear();
}
// -- the agent's tool --------------------------------------------------------------
export const SESSION_TITLE_TOOL_DESCRIPTION = [
    "Name this Octopus Prime session: a separate conversation a person started with you, listed under its title.",
    "Once its topic is clear, give it a short, specific name (2 to 6 words, for example \"Q4 launch pricing\") with",
    "action \"set\", and update it only if the topic clearly changes; don't rename it otherwise. action \"read\" returns",
    "the current title and who named it. If a person named the session, leave it: their name stays until they clear it.",
].join(" ");
export const SESSION_TITLE_PARAMETERS = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["read", "set"],
            description: "read: return the session's title. set: name the session.",
        },
        title: {
            type: "string",
            description: `For set: the session's new name, 2 to 6 words, up to ${TITLE_MAX} characters, on one line.`,
        },
    },
    required: ["action"],
    additionalProperties: false,
};
// Spacing made single, as the backend saves and counts a title.
const oneLine = (value) => value.replace(/\s+/gu, " ").trim();
/**
 * The frame a tool call sends, or the reason it is refused before anything is
 * sent. The conversation, the agent and the delivery come from the session
 * alone; any other argument the model passes is ignored.
 */
export function titleRequest(session, params) {
    const args = (params && typeof params === "object" ? params : {});
    const target = { channel_id: session.channelId, agent_id: session.agentId, event_id: session.eventId };
    if (args.action === "read")
        return { type: READ_FRAME, ...target };
    if (args.action !== "set")
        throw new Error("action must be read or set");
    const title = typeof args.title === "string" ? oneLine(args.title) : "";
    if (!title)
        throw new Error("set needs the session's new name");
    if ([...title].length > TITLE_MAX) {
        throw new Error(`A session's name can be up to ${TITLE_MAX} characters; pick a shorter one (2 to 6 words)`);
    }
    return { type: SET_FRAME, ...target, title };
}
const REFUSALS = {
    person_named: "A person named this session; leave it. Their name stays until they clear it.",
    not_session: "This conversation is not a session, so it has no title for you to set.",
    unavailable: "This session is not available to you: you must be its agent, shared with the person who uses you here.",
    rate_limited: `This session was renamed enough for now (${RENAMES_PER_HOUR} times an hour at most). Keep its name.`,
    invalid_title: `A session's name must be text of 1 to ${TITLE_MAX} characters.`,
    invalid_request: "The session title did not understand the request.",
    busy: "The session's title could not be read or saved just now. Try again in a moment.",
};
/** What the agent is told when the backend refuses its call. */
export function refusalMessage(reason) {
    return Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : "The session title refused the request.";
}
/**
 * A refusal the agent should take as the answer, not as a failed call: the
 * session keeps a person's name, or enough renames for now.
 */
export const PLAIN_REFUSALS = new Set(["person_named", "rate_limited"]);
const SOURCES = ["default", "person", "agent"];
/** A backend's `session_title.result`; anything else is no answer. */
export function titleAnswer(frame) {
    const { title, title_source: source, changed, renames_left: renamesLeft } = frame;
    if (typeof title !== "string" || !SOURCES.includes(source) || typeof changed !== "boolean"
        || typeof renamesLeft !== "number" || !Number.isInteger(renamesLeft) || renamesLeft < 0) {
        throw new Error("Backend sent a session title answer that could not be read");
    }
    return { title, source: source, changed, renamesLeft };
}
const NAMED_BY = {
    default: "named by default; name it once its topic is clear",
    person: "named by a person; leave it",
    agent: "named by you",
};
/** What the agent gets back from the backend's answer to its call. */
export function titleToolResult(request, frame) {
    const answer = titleAnswer(frame);
    const title = JSON.stringify(oneLine(answer.title));
    const text = request.type === READ_FRAME
        ? `This session's title is ${title} (${NAMED_BY[answer.source]}).`
        : answer.changed ? `Named this session ${title}.` : `This session is already named ${title}; nothing changed.`;
    return {
        content: [{ type: "text", text }],
        details: {
            ok: true,
            action: request.type === READ_FRAME ? "read" : "set",
            title: answer.title,
            title_source: answer.source,
            changed: answer.changed,
            renames_left: answer.renamesLeft,
        },
    };
}
/** The tool's answer to a plain refusal (PLAIN_REFUSALS): a result, not an error. */
export function refusedToolResult(request, reason) {
    return {
        content: [{ type: "text", text: refusalMessage(reason) }],
        details: { ok: false, action: request.type === READ_FRAME ? "read" : "set", reason },
    };
}
