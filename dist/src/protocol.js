export const CONNECTOR_PROTOCOL = "octopus-immutable-intents-v1";
/**
 * Value of the v1 `host` (WebSocket) and `host_api_version` (bootstrap) wire
 * fields. Frozen with protocol v1: deployed backends compare it exactly. It is
 * NOT the running OpenClaw version and must not follow host upgrades; the
 * supported OpenClaw host range is declared in package.json.
 */
export const CONNECTOR_PROTOCOL_HOST = "2026.9.7";
export const CONNECTOR_CAPABILITIES = ["outbound-receipt", "durable-ingress"];
/**
 * Optional: a backend that keeps session stats (src/session-stats.ts) offers it
 * in its welcome, and only such a backend is sent them. Never required, so a
 * v1 backend without it is served exactly as before.
 */
export const SESSION_STATS_CAPABILITY = "session-stats";
/**
 * Optional, both ways (1.4.0): the plugin asks for the project log book in the
 * negotiation's own optional field, never in the v1 `capabilities`, so a
 * backend names a message's project only to a plugin that asked; a backend
 * whose project folders are on offers it in its welcome, and only to such a
 * backend does the plugin send log book requests (src/log-book.ts).
 */
export const LOG_BOOK_CAPABILITY = "log-book";
/**
 * Optional, both ways (1.14.0): the plugin asks for the project folder the
 * same way, and only on a connection whose backend offered it in its welcome
 * does it offer agents the `octopus_folder` tool (src/project-folder.ts).
 */
export const PROJECT_FOLDER_CAPABILITY = "project-folder";
/**
 * Optional, both ways (1.15.0): the plugin asks for channel history
 * the same way, and only on a connection whose backend offered it in its
 * welcome does it offer agents the `octopus_channel_history` tool
 * (src/channel-history.ts).
 */
export const CHANNEL_HISTORY_CAPABILITY = "channel-history";
/**
 * Optional, both ways (1.17.0): the plugin asks for it the same
 * way, and only on a connection whose backend offered it in its welcome does it
 * tell the backend that an agent's turn ended in silence by the agent's own
 * choice (`turn.silent`, src/turn-failure.ts). An older backend is served as
 * before: it times such a turn out.
 */
export const TURN_SILENCE_CAPABILITY = "turn-silence";
/**
 * Optional, both ways (1.21.0): the plugin asks for it the same way,
 * so a backend marks a message sent in a session (`agent_session: true`) only
 * to a plugin that asked; and only on a connection whose backend offered it in
 * its welcome does it offer agents the `octopus_session_title` tool
 * (src/session-title.ts).
 */
export const SESSION_TITLE_CAPABILITY = "session-title";
/**
 * Optional, one way (1.22.0): the plugin says it restarts its Gateway when
 * the backend asks (`gateway.reset`, src/gateway-reset.ts), so a backend
 * sends that frame only to a plugin that asked. Whether the Gateway allows it
 * is the Gateway's own setting, answered per request.
 */
export const GATEWAY_RESET_CAPABILITY = "gateway-reset";
/**
 * Optional, both ways (1.25.0): the plugin asks for it the same way, so a
 * backend says who may run OpenClaw's commands (`sender.command_access`) only
 * to a plugin that asked; and only on a connection whose backend offered it in
 * its welcome does the plugin report each agent's commands (`agent.commands`,
 * src/slash-commands.ts).
 */
export const SLASH_COMMANDS_CAPABILITY = "slash-commands";
/**
 * Optional, one way (1.26.0): the plugin says it keeps an edited message as
 * its agent's context (`message.edited`, src/message-edited.ts), so a backend
 * sends that frame only to a plugin that asked. An older plugin gets nothing.
 */
export const MESSAGE_EDITED_CAPABILITY = "message-edited";
/**
 * Optional, one way (1.27.0): a backend that keeps how busy each Gateway's
 * computer is offers it in its welcome, and only such a backend gets the
 * machine's load with each heartbeat ping (`machine`, src/machine-stats.ts).
 * An older backend is never sent it. Since 1.36.0 `machine` also says whether
 * the load is heavy (`heavy`) and which agents were warned in this run of it
 * (`warned_agents`), and a welcome or pong may say `load_protection: false`
 * (Computer load protection off for this Gateway: no agent is warned).
 */
export const MACHINE_STATS_CAPABILITY = "machine-stats";
/**
 * Optional, both ways (1.28.0): the plugin asks for it the same way, and only
 * on a connection whose backend offered it in its welcome does it offer agents
 * the `octopus_tasks`, `octopus_calendar` and `octopus_projects` tools
 * (src/agent-work.ts). An older backend is never sent their requests.
 */
export const AGENT_WORK_CAPABILITY = "agent-work";
/**
 * Optional, both ways (1.29.0): the plugin asks for it the same way, so a
 * backend says which meeting a message sends its agent to (`meeting`) only to
 * a plugin that asked; and only on a connection whose backend offered it in
 * its welcome does the plugin report this Gateway's meeting plugins, offer
 * agents the `octopus_meeting` tool and ask for the notes when a meeting is
 * over (src/meetings.ts).
 */
export const MEETINGS_CAPABILITY = "meetings";
/**
 * Optional, one way (1.30.0): a backend that keeps what each agent's turns
 * cost offers it in its welcome, and only such a backend is sent each turn's
 * tokens, model and cost (`agent.usage`, src/usage.ts). An older backend is
 * never sent them.
 */
export const AGENT_USAGE_CAPABILITY = "agent-usage";
/**
 * Optional, one way (1.31.0): a backend that shows agents' approvals to their
 * owners offers it in its welcome; only to such a backend does the plugin say
 * it can forward them (`approvals.hello`) and forward those its owner turned
 * on (src/approvals.ts). An older backend is never sent any.
 */
export const AGENT_APPROVALS_CAPABILITY = "agent-approvals";
/**
 * Optional, both ways (1.32.0): the plugin asks for it the same way, so a
 * backend keeps a reply's `presentation` (a card, table or chart,
 * src/presentation.ts) only from a plugin that asked; and only on a connection
 * whose backend offered it in its welcome does the plugin render one and send
 * it. An older backend gets the reply's words alone, as before.
 */
export const RICH_PRESENTATION_CAPABILITY = "rich-presentation";
/**
 * Optional, both ways (1.33.0): the plugin asks for it the same way, so a
 * backend keeps a reply's `ask` (an agent's question or buttons people answer
 * with a tap, src/questions.ts) only from a plugin that asked, and sends only
 * it `question.answer` frames; and only on a connection whose backend offered
 * it does the plugin draw buttons and send an `ask`. An older backend gets
 * the reply's words alone, as before.
 */
export const ASK_USER_CAPABILITY = "ask-user";
/**
 * Optional, both ways (1.35.0): the plugin asks for it the same way, so a
 * backend names a message's pictures (`files`: id, name, type, size) only to a
 * plugin that asked; and only on a connection whose backend offered it does
 * the plugin download them with the connector's credential and hand them to
 * the turn as images (src/inbound-media.ts). An older backend sends the
 * message's text with its links alone, as before.
 */
export const INBOUND_MEDIA_CAPABILITY = "inbound-media";
/**
 * Optional, both ways (1.38.0): the plugin asks for Agent Backup the same
 * way, so a backend sends `backup.run` ("Back up now") only to a plugin that
 * asked; and only on a connection whose backend offered it in its welcome
 * does the plugin ask whether a backup is due and make one (src/backup.ts).
 * An older backend is never sent a backup call.
 */
export const BACKUP_CAPABILITY = "agent-backup";
export const OPTIONAL_CAPABILITIES = [
    LOG_BOOK_CAPABILITY, PROJECT_FOLDER_CAPABILITY, CHANNEL_HISTORY_CAPABILITY, TURN_SILENCE_CAPABILITY,
    SESSION_TITLE_CAPABILITY, GATEWAY_RESET_CAPABILITY, SLASH_COMMANDS_CAPABILITY, MESSAGE_EDITED_CAPABILITY,
    AGENT_WORK_CAPABILITY, MEETINGS_CAPABILITY, RICH_PRESENTATION_CAPABILITY, ASK_USER_CAPABILITY,
    INBOUND_MEDIA_CAPABILITY, BACKUP_CAPABILITY,
];
/**
 * This package's version (package.json `version`), sent at setup and, since
 * 1.12.0, in each negotiation, so the backend can tell an Owner when the
 * plugin on a Gateway is too old.
 */
export const PLUGIN_VERSION = "1.38.4";
/**
 * The v1 negotiation, plus the plugin's version and, when the host gives one,
 * the running OpenClaw version (the transport's checked `api.runtime.version`).
 * Both are new optional fields: the v1 fields stay exactly as they were.
 */
export function negotiationFrame(openclawVersion) {
    return {
        type: "protocol.negotiate",
        protocol: CONNECTOR_PROTOCOL,
        host: CONNECTOR_PROTOCOL_HOST,
        capabilities: [...CONNECTOR_CAPABILITIES],
        optional_capabilities: [...OPTIONAL_CAPABILITIES],
        plugin_version: PLUGIN_VERSION,
        ...(openclawVersion ? { openclaw_version: openclawVersion } : {}),
    };
}
/** Whether a validated welcome offers a capability beyond the required ones. */
export function welcomeOffers(welcome, capability) {
    return welcome.capabilities.includes(capability);
}
export function assertProtocolWelcome(value) {
    if (!value || typeof value !== "object")
        throw new Error("Protocol welcome is not an object");
    const frame = value;
    const capabilities = Array.isArray(frame.capabilities) ? frame.capabilities : [];
    if (frame.type !== "welcome" ||
        frame.compatible !== true ||
        frame.protocol !== CONNECTOR_PROTOCOL ||
        frame.host !== CONNECTOR_PROTOCOL_HOST ||
        typeof frame.connector_id !== "string" ||
        !frame.connector_id ||
        !CONNECTOR_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
        throw new Error("Backend did not return the exact negotiated connector contract");
    }
}
