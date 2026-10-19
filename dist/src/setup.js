import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { accountSection, listConnectorAccountIds, normalizeAccountId, withAccountConfig, } from "./accounts.js";
import { ALLOW_NOTE, remoteResetAllowed } from "./gateway-reset.js";
import { normalizeIngressBackendUrl } from "./ingress-origin.js";
import { optionalString, validatePinnedIdentity } from "./runtime-config.js";
import { CONNECTOR_PROTOCOL_HOST, PLUGIN_VERSION } from "./protocol.js";
function preparedSetup(input) {
    const value = input;
    if (!value.connectorToken || !value.connectorId || !value.orgId) {
        throw new Error("Octopus Prime setup must complete authenticated connector exchange before configuration is written");
    }
    return value;
}
// Words OpenClaw reads in a session key (a peer kind, a thread), which a named
// account's sessions carry (octopusSessionKey in src/host-dispatch.ts).
const RESERVED_ACCOUNT_IDS = new Set(["channel", "group", "direct", "dm", "thread"]);
// Account ids as OpenClaw keeps them (normalizeAccountId): what a connector's
// ingress origin accepts too.
function accountIdIssue(accountId) {
    if (RESERVED_ACCOUNT_IDS.has(accountId)) {
        return `Octopus Prime cannot use "${accountId}" as an account name: choose another name`;
    }
    return normalizeAccountId(accountId) === accountId && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)
        ? undefined
        : `Octopus Prime cannot use "${accountId}" as an account name: use letters, digits, "-" and "_"`;
}
/**
 * Setup writes one account and leaves every other as it was (1.5.0). It
 * refuses, after the code was exchanged and before anything is written, an
 * account already connected to another organization (setup run again without
 * --account, with a code from a second organization, would otherwise
 * disconnect the first) and an organization another account already connects.
 * The connector the code was for stays in that organization's OpenClaw agents
 * list, where New setup code gives it a fresh code.
 */
function organizationIssue(cfg, accountId, orgId) {
    const pinned = optionalString(accountSection(cfg, accountId).orgId);
    if (pinned && pinned !== orgId) {
        return `This setup code is for organization ${orgId}, but the Octopus Prime account "${accountId}" is connected to `
            + `organization ${pinned}. To connect another organization, make a new setup code for this connector (New setup `
            + "code in OpenClaw agents) and run setup again with --account <name>.";
    }
    const other = listConnectorAccountIds(cfg)
        .find((id) => id !== accountId && optionalString(accountSection(cfg, id).orgId) === orgId);
    return other === undefined ? undefined
        : `Organization ${orgId} is already connected by the Octopus Prime account "${other}". Use that account, or `
            + "revoke this new connector in OpenClaw agents.";
}
export async function exchangeSetupCode(url, setupCode) {
    const backendUrl = normalizeIngressBackendUrl(url);
    if (typeof setupCode !== "string" || !setupCode.trim())
        throw new Error("Octopus Prime setup code is required");
    const res = await fetch(`${backendUrl}/api/connector/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            code: setupCode.trim(),
            plugin_version: PLUGIN_VERSION,
            host_api_version: CONNECTOR_PROTOCOL_HOST,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Octopus Prime bootstrap failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    const connectorToken = typeof data.connector_token === "string" && data.connector_token.trim()
        ? data.connector_token.trim()
        : undefined;
    if (!connectorToken)
        throw new Error("Octopus Prime bootstrap returned an incomplete connector credential");
    const connectorId = validatePinnedIdentity(data.connector_id, "authenticated connector identity");
    const orgId = validatePinnedIdentity(data.org_id, "authenticated organization identity");
    if (data.backend_url !== undefined) {
        if (typeof data.backend_url !== "string" || normalizeIngressBackendUrl(data.backend_url) !== backendUrl) {
            throw new Error("Octopus Prime bootstrap backend identity does not match the requested canonical backend");
        }
    }
    return Object.freeze({ backendUrl, connectorToken, connectorId, orgId });
}
export const octopusSetupContract = defineChannelSetupContract({
    fields: {
        backendUrl: {
            kind: "string",
            cli: { flags: "--backend-url <url>", description: "Canonical Octopus Prime HTTPS backend URL" },
        },
        setupCode: {
            kind: "string",
            sensitive: true,
            cli: { flags: "--setup-code <code>", description: "One-time Octopus Prime connector setup code" },
        },
        connectorToken: {
            kind: "string",
            sensitive: true,
            cli: { flags: "--connector-token <token>", description: "Authenticated connector credential returned by setup exchange" },
        },
        connectorId: {
            kind: "string",
            cli: { flags: "--connector-id <id>", description: "Authenticated connector identity returned by setup exchange" },
        },
        orgId: {
            kind: "string",
            cli: { flags: "--org-id <id>", description: "Authenticated organization identity returned by setup exchange" },
        },
    },
    adapter: {
        // The channel's own fields stay the default account when another account
        // is added: OpenClaw must not move them into `accounts` (src/accounts.ts).
        configPromotion: "preserve-root",
        // `openclaw channels add --account <name>` sets up that account; without
        // --account, the default account, as before.
        resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
        async prepareAccountConfigInput({ accountId, input }) {
            // Before the code is used: a refused account name must not spend it.
            const issue = accountIdIssue(accountId);
            if (issue)
                throw new Error(issue);
            const backendUrl = typeof input.backendUrl === "string" ? input.backendUrl : "";
            const setupCode = typeof input.setupCode === "string" ? input.setupCode : "";
            const exchanged = await exchangeSetupCode(backendUrl, setupCode);
            return { ...input, ...exchanged };
        },
        validateInput({ cfg, accountId, input }) {
            const issue = accountIdIssue(accountId);
            if (issue)
                return issue;
            let prepared;
            try {
                prepared = preparedSetup(input);
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            return organizationIssue(cfg, accountId, prepared.orgId) ?? null;
        },
        applyAccountConfig({ cfg, accountId, input }) {
            const issue = accountIdIssue(accountId);
            if (issue)
                throw new Error(issue);
            const prepared = preparedSetup(input);
            // The default account in the channel's own fields, as before; any other
            // in its entry under `accounts`. No other account's fields change.
            return withAccountConfig(cfg, accountId, {
                enabled: true,
                backendUrl: prepared.backendUrl,
                connectorToken: prepared.connectorToken,
                connectorId: prepared.connectorId,
                orgId: prepared.orgId,
            });
        },
        // Restarting this Gateway from Octopus Prime (1.22.0) stays off until its
        // owner turns it on here: the one command is said once setup is written.
        afterAccountConfigWritten({ cfg, runtime }) {
            if (!remoteResetAllowed(cfg))
                runtime.log(ALLOW_NOTE);
        },
    },
});
