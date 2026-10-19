import { createHash } from "node:crypto";
export function normalizeIngressBackendUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("Invalid ingress origin URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || value.includes("?") || value.includes("#")) {
        throw new Error("Ingress origin requires a secure HTTPS URL without credentials, query or fragment");
    }
    return url.origin + url.pathname.replace(/\/+$/, "");
}
/** Structure/key construction only: caller must first validate the authenticated welcome. */
export function createIngressOrigin(input) {
    const backendUrl = normalizeIngressBackendUrl(input.backendUrl);
    if (typeof input.connectorId !== "string" || !input.connectorId || input.connectorId.length > 128
        || input.connectorId.trim() !== input.connectorId || /[\x00-\x20\x7f]/.test(input.connectorId)) {
        throw new Error("Invalid ingress origin connector identity");
    }
    if (typeof input.accountId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.accountId)) {
        throw new Error("Invalid ingress origin account identity");
    }
    const key = createHash("sha256").update(JSON.stringify([1, backendUrl, input.connectorId, input.accountId])).digest("hex");
    return Object.freeze({ version: 1, backendUrl, connectorId: input.connectorId, accountId: input.accountId, key });
}
export function validateIngressOrigin(value) {
    if (!value || typeof value !== "object")
        throw new Error("Ingress origin binding is required");
    const supplied = value;
    const canonical = createIngressOrigin(supplied);
    if (supplied.version !== 1 || supplied.key !== canonical.key || supplied.backendUrl !== canonical.backendUrl) {
        throw new Error("Invalid ingress origin binding");
    }
    return canonical;
}
