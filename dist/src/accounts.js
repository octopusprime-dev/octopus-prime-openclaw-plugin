import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountKey, resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { channelSection, OCTOPUS_CHANNEL_ID } from "./runtime-config.js";
/**
 * Connector accounts (1.5.0): one Gateway in more than one Octopus
 * Prime organization. Each account is one connector, pinned to one
 * organization, with its own socket, ingress queue and OpenClaw sessions.
 * `channels.octopus-prime` keeps the "default" account in its own fields, as
 * before accounts existed; `channels.octopus-prime.accounts.<id>` holds each
 * other one. A named account reads only its own entry: it never takes the
 * default account's credential, connector or organization.
 */
export { DEFAULT_ACCOUNT_ID, normalizeAccountId };
// The fields that make a connector; on the channel itself they are the default account.
const CONNECTOR_FIELDS = ["backendUrl", "connectorToken", "connectorId", "orgId"];
const listing = createAccountListHelpers(OCTOPUS_CHANNEL_ID, {
    normalizeAccountId,
    implicitDefaultAccount: { channelKeys: CONNECTOR_FIELDS },
});
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** The channel's `accounts` map, if it has one. */
export function accountEntries(cfg) {
    return record(channelSection(cfg).accounts);
}
/**
 * The configured accounts, in OpenClaw's order: "default" while the channel's
 * own fields hold a connector (or nothing is configured yet), and each entry
 * of `accounts`, by its normalized id.
 */
export function listConnectorAccountIds(cfg) {
    return listing.listAccountIds(cfg);
}
/** "default" while it is configured, else the first account. */
export function defaultConnectorAccountId(cfg) {
    return listing.resolveDefaultAccountId(cfg);
}
/** How the plugin's log lines name an account: the default account's read as before. */
export function logPrefix(accountId) {
    const id = normalizeAccountId(accountId);
    return id === DEFAULT_ACCOUNT_ID ? OCTOPUS_CHANNEL_ID : `${OCTOPUS_CHANNEL_ID} account ${id}`;
}
/** The stored key of an account's entry in `accounts`, whatever its spelling there. */
export function accountEntryKey(cfg, accountId) {
    return resolveAccountKey(accountEntries(cfg), normalizeAccountId(accountId), normalizeAccountId);
}
/**
 * The fields one account reads. The default account reads the channel's own
 * fields, overridden by an `accounts.default` entry if there is one (OpenClaw
 * moves them there when it promotes a single account). Any other account reads
 * its own entry only, so an account with no entry has no connector.
 */
export function accountSection(cfg, accountId) {
    const id = normalizeAccountId(accountId);
    const entry = record(resolveNormalizedAccountEntry(accountEntries(cfg), id, normalizeAccountId));
    if (id !== DEFAULT_ACCOUNT_ID)
        return { ...entry };
    const { accounts: _accounts, ...root } = channelSection(cfg);
    return { ...root, ...entry };
}
/** An account runs only while both the channel and the account are enabled. */
export function accountEnabled(cfg, accountId) {
    return channelSection(cfg).enabled !== false && accountSection(cfg, accountId).enabled !== false;
}
/**
 * A copy of the config with `fields` set where the account reads them: the
 * channel's own fields for the default account (its `accounts.default` entry
 * if it has one), the account's entry in `accounts` for any other, under the
 * key it is stored with. Nothing else changes.
 */
export function withAccountConfig(cfg, accountId, fields) {
    const id = normalizeAccountId(accountId);
    const section = channelSection(cfg);
    const accounts = accountEntries(cfg);
    const key = accountEntryKey(cfg, id);
    if (id === DEFAULT_ACCOUNT_ID && key === undefined) {
        return { ...cfg, channels: { ...cfg.channels, [OCTOPUS_CHANNEL_ID]: { ...section, ...fields } } };
    }
    const entry = key === undefined ? undefined : record(accounts?.[key]);
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            [OCTOPUS_CHANNEL_ID]: { ...section, accounts: { ...accounts, [key ?? id]: { ...entry, ...fields } } },
        },
    };
}
/**
 * OpenClaw's route bindings (`bindings`) for this channel that name an
 * account (`match.accountId`: an account id, or "*" for every account). A
 * binding without an account chose nothing for this plugin before accounts
 * existed and still chooses nothing, so one written for a single account
 * never narrows the default account once a second is added; to bind the
 * default account, name it ("default"). A binding that names a conversation,
 * server, team or role would pick the agent for one conversation; on Octopus
 * Prime the backend names each message's agent, so it is not read either.
 */
function accountBindings(cfg) {
    const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
    const found = [];
    for (const raw of bindings) {
        const binding = record(raw);
        const match = record(binding?.match);
        if (!binding || !match || binding.type === "acp")
            continue;
        if (typeof match.channel !== "string" || match.channel.trim().toLowerCase() !== OCTOPUS_CHANNEL_ID)
            continue;
        if (match.peer !== undefined || match.guildId !== undefined || match.teamId !== undefined || match.roles !== undefined)
            continue;
        const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
        if (typeof binding.agentId !== "string" || !accountId)
            continue;
        found.push({ agentId: normalizeAgentId(binding.agentId), accountId: accountId === "*" ? "*" : normalizeAccountId(accountId) });
    }
    return found;
}
/**
 * The agents an account announces to its organization, which are the only
 * ones that organization can reach. With one account, or no binding for this
 * channel, every account offers every configured agent, as before accounts
 * existed: bindings never changed what a single connector offered, so a
 * binding already in a config changes nothing until a second account is
 * added. With several accounts and bindings, an account offers the agents
 * bound to it (`match.accountId` naming it, or "*" for every account); an
 * account that no binding names offers the agents that no binding names. So
 * an agent kept for one organization, say with its own workspace, is offered
 * to that organization only.
 */
export function accountAgentIds(cfg, accountId) {
    const agents = listAgentIds(cfg);
    const bindings = accountBindings(cfg);
    if (bindings.length === 0 || listConnectorAccountIds(cfg).length < 2)
        return agents;
    const id = normalizeAccountId(accountId);
    const named = bindings.some((binding) => binding.accountId === id);
    const bound = new Set(bindings.map((binding) => binding.agentId));
    const offered = new Set(bindings.filter((binding) => binding.accountId === id || binding.accountId === "*")
        .map((binding) => binding.agentId));
    return agents.filter((agent) => offered.has(agent) || (!named && !bound.has(agent)));
}
