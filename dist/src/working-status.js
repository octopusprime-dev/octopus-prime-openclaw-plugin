/**
 * Durable adoption is necessary but not sufficient: wait for core's start of
 * the turn, which is the agent's run starting or core's reply-start, whichever
 * comes first (src/host-dispatch.ts). A message still queued behind another
 * turn has neither.
 */
export function createWorkingStatusGate(options) {
    const original = options.lifecycle;
    let adopted = false;
    let started = false;
    let terminal = false;
    let reported = false;
    async function report() {
        if (!adopted || !started || terminal || reported)
            return;
        reported = true;
        try {
            await options.onWorking?.();
        }
        catch {
            // Presentation failure must not abandon/replay an already adopted turn.
            try {
                options.onStatusError?.();
            }
            catch { /* diagnostics are also best-effort */ }
        }
    }
    const lifecycle = {
        ...original,
        abortSignal: original.abortSignal,
        onDeferred() {
            // A queued handoff must await a fresh busy signal, not reuse preflight.
            if (!adopted)
                started = false;
            original.onDeferred();
        },
        onAdoptionFinalizing: () => original.onAdoptionFinalizing(),
        ...(original.onDeferredHeartbeat ? { onDeferredHeartbeat: () => original.onDeferredHeartbeat() } : {}),
        ...(original.deferredHeartbeatIntervalMs !== undefined ? { deferredHeartbeatIntervalMs: original.deferredHeartbeatIntervalMs } : {}),
        async onAdopted() {
            await original.onAdopted();
            adopted = true;
            await report();
        },
        async onAbandoned() {
            terminal = true;
            await original.onAbandoned();
        },
        async onCancelled() {
            terminal = true;
            await original.onCancelled?.();
        },
        async onFailed(error) {
            terminal = true;
            await original.onFailed?.(error);
        },
    };
    return {
        lifecycle,
        async onReplyStart() {
            started = true;
            await report();
        },
    };
}
