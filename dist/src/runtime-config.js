import { createIngressOrigin, normalizeIngressBackendUrl } from "./ingress-origin.js";
export const OCTOPUS_CHANNEL_ID = "octopus-prime";
export function optionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function channelSection(cfg) {
    const section = cfg.channels?.[OCTOPUS_CHANNEL_ID];
    return section && typeof section === "object" && !Array.isArray(section)
        ? section
        : {};
}
export function validatePinnedIdentity(value, label) {
    if (typeof value !== "string" || !value || value.length > 128
        || value.trim() !== value || /[\x00-\x20\x7f]/.test(value)) {
        throw new Error(`Octopus Prime requires a valid ${label}`);
    }
    return value;
}
export function resolvePinnedRuntimeConfig(input) {
    const connectorToken = optionalString(input.connectorToken);
    if (!connectorToken)
        throw new Error("Octopus Prime requires a resolved connector credential");
    const backendUrl = typeof input.backendUrl === "string"
        ? normalizeIngressBackendUrl(input.backendUrl)
        : (() => { throw new Error("Octopus Prime requires a canonical HTTPS backend URL"); })();
    const connectorId = validatePinnedIdentity(input.connectorId, "connector identity pin");
    const orgId = validatePinnedIdentity(input.orgId, "organization identity pin");
    // Reuse the ingress identity validator so startup and authenticated welcome
    // cannot disagree about the accepted connector-id grammar.
    createIngressOrigin({ backendUrl, connectorId, accountId: "default" });
    return Object.freeze({ backendUrl, connectorToken, connectorId, orgId });
}
export function sameRuntimeBinding(left, right) {
    return left.backendUrl === right.backendUrl
        && left.connectorToken === right.connectorToken
        && left.connectorId === right.connectorId
        && left.orgId === right.orgId;
}
export function pinnedRuntimeConfigIssue(input) {
    try {
        resolvePinnedRuntimeConfig(input);
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
