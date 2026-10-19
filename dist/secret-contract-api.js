/** Lightweight startup discovery; must not import transport or channel runtime. */
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { collectSecretInputAssignment, createChannelSecretTargetRegistryEntries, getChannelRecord, isRecord, } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
const CHANNEL = "octopus-prime";
const LABEL = "Octopus Prime";
const FIELD = "connectorToken";
// A config path segment as OpenClaw writes one (dot form, or quoted in brackets).
function pathSegment(path, segment) {
    return /^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}
/**
 * Each connector account's credential may be a SecretRef (1.5.0): the
 * channel's own `connectorToken` is the default account's, exactly as before
 * accounts, and `accounts.<id>.connectorToken` each other account's. Each is
 * resolved for its own account only, while that account is enabled; no
 * account takes another's credential.
 */
export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
    channelKey: CHANNEL,
    account: [FIELD],
    channel: [FIELD],
});
export function collectRuntimeConfigAssignments(params) {
    const channel = getChannelRecord(params.config, CHANNEL);
    if (!channel)
        return;
    const { accounts, ...root } = channel;
    collectSecretInputAssignment({
        value: channel[FIELD],
        path: `channels.${CHANNEL}.${FIELD}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: channel.enabled !== false,
        inactiveReason: `${LABEL} channel is disabled.`,
        // Other accounts are not part of the default account's settings.
        owner: { ownerKind: "account", ownerId: `${CHANNEL}:default`, requiredForGateway: false, disposition: "isolate", contract: root },
        apply: (value) => {
            channel[FIELD] = value;
        },
    });
    if (!isRecord(accounts))
        return;
    for (const [key, account] of Object.entries(accounts)) {
        if (!isRecord(account) || !Object.hasOwn(account, FIELD))
            continue;
        collectSecretInputAssignment({
            value: account[FIELD],
            path: `${pathSegment(`channels.${CHANNEL}.accounts`, key)}.${FIELD}`,
            expected: "string",
            defaults: params.defaults,
            context: params.context,
            active: channel.enabled !== false && account.enabled !== false,
            inactiveReason: `${LABEL} account is disabled.`,
            owner: {
                ownerKind: "account",
                ownerId: `${CHANNEL}:${normalizeAccountId(key)}`,
                requiredForGateway: false,
                disposition: "isolate",
                contract: { channel: root, account },
            },
            apply: (value) => {
                account[FIELD] = value;
            },
        });
    }
}
export const channelSecrets = { secretTargetRegistryEntries, collectRuntimeConfigAssignments };
