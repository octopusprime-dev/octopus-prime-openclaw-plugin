import { normalizeAccountId } from "./accounts.js";
import { startTransport, stopTransport } from "./transport.js";
import { resolvePinnedRuntimeConfig } from "./runtime-config.js";
let hostApi;
let transportDeps = {};
// Each connector account runs its own transport (1.5.0): one per organization.
const active = new Map();
/** deps: test seam only (TransportDependencies in transport.ts); the Gateway passes none. */
export function bindGatewayHost(api, deps = {}) {
    hostApi = api;
    transportDeps = deps;
}
/** Stops every running account (the plugin's runtime lifecycle); each stops its own transport. */
export async function stopAccountTransport() {
    const running = [...active.values()];
    if (running.length === 0) {
        await stopTransport();
        return;
    }
    for (const current of running)
        current.requestStop();
    await Promise.all(running.map((current) => current.finished));
}
export const octopusGateway = {
    async startAccount(ctx) {
        if (ctx.abortSignal.aborted || !ctx.account.enabled)
            return;
        const accountId = normalizeAccountId(ctx.accountId);
        if (normalizeAccountId(ctx.account.accountId) !== accountId) {
            throw new Error("Octopus Prime connector account does not match the account being started");
        }
        const api = hostApi;
        if (!api)
            throw new Error("Octopus Prime host runtime is not bound");
        const pinned = resolvePinnedRuntimeConfig(ctx.account);
        if (active.has(accountId))
            throw new Error("Octopus Prime connector account is already running");
        let requestStop;
        let finish;
        const stopped = new Promise((resolve) => { requestStop = resolve; });
        const current = {
            accountId,
            abortSignal: ctx.abortSignal,
            requestStop,
            finished: new Promise((resolve) => { finish = resolve; }),
        };
        active.set(accountId, current);
        ctx.abortSignal.addEventListener("abort", requestStop, { once: true });
        if (ctx.abortSignal.aborted)
            requestStop();
        try {
            await startTransport(api, {
                backendUrl: pinned.backendUrl,
                connectorToken: pinned.connectorToken,
                accountId,
                connectorId: pinned.connectorId,
                orgId: pinned.orgId,
            }, transportDeps);
            await stopped;
        }
        finally {
            ctx.abortSignal.removeEventListener("abort", requestStop);
            try {
                await stopTransport(accountId);
            }
            finally {
                if (active.get(accountId) === current)
                    active.delete(accountId);
                finish();
            }
        }
    },
    async stopAccount(ctx) {
        const current = active.get(normalizeAccountId(ctx.accountId));
        if (!current || current.abortSignal !== ctx.abortSignal)
            return;
        current.requestStop();
        await current.finished;
    },
};
