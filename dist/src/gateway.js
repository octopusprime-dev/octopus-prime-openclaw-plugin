import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-runtime";
import { getChannelRuntimeContext, registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { normalizeAccountId } from "./accounts.js";
import { bindApprovalGateway, CHANNEL } from "./approvals.js";
import { startTransport, stopTransport } from "./transport.js";
import { resolvePinnedRuntimeConfig } from "./runtime-config.js";
let hostApi;
let transportDeps = {};
// The approval service core offers each account task (approval.resolve only),
// read through the runtime context it registers before startAccount.
const APPROVAL_SERVICE_CONTEXT = "approval.gateway";
/**
 * Agents' approvals for this account (1.31.0, src/approvals.ts): registers
 * the "approval.native" runtime context, which makes core start the channel's
 * native approval handler for it (and stop it when the lease is disposed or
 * the account stops), and keeps the account task's approval service for
 * decisions. Nothing when the host gives no channel runtime: then approvals
 * stay on OpenClaw's other surfaces.
 */
function startApprovals(ctx, accountId) {
    const channelRuntime = ctx
        .channelRuntime;
    if (!channelRuntime)
        return null;
    try {
        const service = getChannelRuntimeContext({
            channelRuntime, channelId: CHANNEL, accountId: ctx.accountId, capability: APPROVAL_SERVICE_CONTEXT,
        });
        bindApprovalGateway(accountId, service && typeof service.request === "function" ? service : undefined);
        return registerChannelRuntimeContext({
            channelRuntime, channelId: CHANNEL, accountId: ctx.accountId,
            capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, context: { accountId }, abortSignal: ctx.abortSignal,
        });
    }
    catch (error) {
        hostApi?.logger.warn(`Octopus Prime: approvals could not be started for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
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
        const approvals = startApprovals(ctx, accountId);
        try {
            await startTransport(api, {
                backendUrl: pinned.backendUrl,
                connectorToken: pinned.connectorToken,
                accountId,
                connectorId: pinned.connectorId,
                orgId: pinned.orgId,
                // What `openclaw channels status` says of this account (1.39.5).
                reportStatus: (status) => { ctx.setStatus?.(status); },
            }, transportDeps);
            await stopped;
        }
        finally {
            ctx.abortSignal.removeEventListener("abort", requestStop);
            approvals?.dispose();
            bindApprovalGateway(accountId, undefined);
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
