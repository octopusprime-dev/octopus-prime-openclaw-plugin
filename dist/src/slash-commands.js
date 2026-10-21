/**
 * OpenClaw's slash commands from Octopus Prime (1.25.0): /status, /model,
 * /think, /new, /reset, /stop, /compact, /help and the rest, typed in the
 * agent's conversation in the Octopus Prime apps.
 *
 * Who may run them is the backend's to say, per message, in the frame's
 * sender (`sender.command_access`, src/ingress.ts): "owner" for whoever
 * connected this Gateway to the organization, "manager" for the
 * organization's Owners and Admins, nothing for anyone else. A backend says
 * so only to a plugin that asked for SLASH_COMMANDS_CAPABILITY and only while
 * its own switch is on; nothing typed into a message can say it. Everyone
 * else's turn is as before: not authorized for commands, so OpenClaw runs
 * none of theirs.
 *
 * The commands in OWNER_ONLY_COMMANDS reach the host itself (a shell, the
 * Gateway's configuration, its plugins, restarts) and are the owner's alone:
 * a manager's message that names one anywhere, as a command or as an inline
 * directive, is not authorized for any command. OpenClaw's own `commands.*`
 * settings still decide everything else: a command they turn off stays off,
 * and owner-only checks of OpenClaw's own (`commands.ownerAllowFrom`) still
 * apply on top of this.
 *
 * `/approve` is among them since 1.31.0: answering an agent's approval is
 * its owner's alone (src/approvals.ts), in the apps or typed.
 */
export const OWNER_ONLY_COMMANDS = [
    "bash", "config", "exec", "elevated", "restart", "update", "plugins", "mcp", "debug", "approve",
];
/** Their other names in OpenClaw's registry; "!" at the start of a message is /bash. */
export const OWNER_ONLY_ALIASES = {
    elev: "elevated",
    plugin: "plugins",
};
const COMMAND_TOKEN = /(?:^|[^A-Za-z0-9_-])\/([A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g;
/** The owner-only command a message names anywhere in it, if any. */
export function ownerOnlyCommandIn(body) {
    if (body.trimStart().startsWith("!"))
        return "bash";
    for (const match of body.matchAll(COMMAND_TOKEN)) {
        const name = match[1].toLowerCase();
        const command = OWNER_ONLY_COMMANDS.includes(name)
            ? name
            : OWNER_ONLY_ALIASES[name];
        if (command)
            return command;
    }
    return undefined;
}
/**
 * Whether OpenClaw may treat this message's commands and directives as the
 * sender's: the agent's owner always, a manager unless the message names an
 * owner-only command, anyone else never.
 */
export function commandsAuthorized(frame) {
    const access = frame.sender.command_access;
    if (access === "owner")
        return true;
    if (access === "manager")
        return ownerOnlyCommandIn(frame.body) === undefined;
    return false;
}
// What a report may hold (the backend drops a larger one whole).
export const COMMANDS_PER_AGENT_MAX = 300;
export const AGENTS_PER_REPORT_MAX = 50;
const ALIASES_MAX = 8;
const NAME = /^[a-z0-9_-]{1,64}$/;
let registry = null;
function loadRegistry() {
    registry ??= import("openclaw/plugin-sdk/command-auth-native").then((sdk) => sdk, () => null);
    return registry;
}
/** Commands OpenClaw's `commands.*` settings turn off (its own isCommandEnabled and restart flag). */
function enabledByConfig(cfg, key) {
    const flags = cfg.commands;
    const flag = flags && typeof flags === "object" && Object.hasOwn(flags, key) ? flags[key] : undefined;
    if (["config", "mcp", "plugins", "debug", "bash"].includes(key))
        return flag === true;
    if (key === "restart" || key === "update") {
        const restart = flags && typeof flags === "object" && Object.hasOwn(flags, "restart") ? flags.restart : undefined;
        return restart !== false;
    }
    return true;
}
/**
 * The text commands one agent has on this Gateway, as OpenClaw's registry
 * lists them for its configuration: the built-in ones its `commands.*`
 * settings leave on, and its skills' commands. Each with its description,
 * whether it is owner-only here, and its other names. Sorted by name.
 */
export function agentCommandList(sdk, cfg, agentId) {
    let skills = [];
    try {
        skills = sdk.listSkillCommandsForAgents({ cfg, agentIds: [agentId] });
    }
    catch { /* the built-in commands still count */ }
    const listed = new Map();
    for (const command of sdk.listChatCommands({ skillCommands: skills })) {
        if (command.scope === "native" || !enabledByConfig(cfg, command.key))
            continue;
        const names = (command.textAliases ?? [])
            .map((alias) => (alias.startsWith("/") ? alias.slice(1).toLowerCase() : ""))
            .filter((name) => NAME.test(name));
        const [name, ...aliases] = names;
        if (!name || listed.has(name))
            continue;
        listed.set(name, {
            name,
            description: typeof command.description === "string" ? command.description : "",
            owner_only: OWNER_ONLY_COMMANDS.includes(command.key),
            aliases: aliases.filter((alias) => alias !== name).slice(0, ALIASES_MAX),
        });
    }
    return [...listed.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, COMMANDS_PER_AGENT_MAX);
}
/**
 * The report for these agents (the `agent.commands` frame's `agents`), or
 * undefined when OpenClaw's registry cannot be read here: then nothing is
 * sent, and the apps show no menu for this Gateway.
 */
export async function commandsReport(cfg, agentIds, load = loadRegistry) {
    const sdk = await load();
    if (!sdk)
        return undefined;
    try {
        return agentIds.slice(0, AGENTS_PER_REPORT_MAX).map((id) => ({ id, commands: agentCommandList(sdk, cfg, id) }));
    }
    catch {
        return undefined;
    }
}
