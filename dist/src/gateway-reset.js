import { channelSection } from "./runtime-config.js";
/**
 * Restart this Gateway from Octopus Prime (1.22.0). Someone the Gateway's
 * owner allowed presses Restart in the Octopus Prime apps; the backend sends
 * this Gateway's connector socket a `gateway.reset` frame. The plugin answers
 * `gateway.reset.result` (status "restarting"), lets the replies it is sending
 * get their receipts (FLUSH_WAIT_MS at most), then asks OpenClaw to restart
 * the way OpenClaw takes outside restart requests: a SIGUSR2 to its own
 * process, which OpenClaw handles with its usual drain while `commands.restart`
 * is on (the default). The plugin SDK has no restart call of its own.
 *
 * Off until the Gateway's owner turns it on, on the Gateway itself
 * (`channels.octopus-prime.allowRemoteReset: true`, ALLOW_COMMAND). Otherwise
 * the frame is answered `gateway.reset.rejected` with a reason the apps say in
 * their words: "not_allowed" (off here), "restart_disabled" (OpenClaw's
 * `commands.restart` is false) or "rate_limited" (one restart per
 * RESET_EVERY_MS). Only a frame from the account's authenticated, negotiated
 * socket gets here (src/transport.ts); it restarts the whole Gateway, every
 * account with it.
 */
export const RESET_FRAME = "gateway.reset";
export const RESULT_FRAME = "gateway.reset.result";
export const REJECTED_FRAME = "gateway.reset.rejected";
export const RESET_EVERY_MS = 5 * 60_000;
export const FLUSH_WAIT_MS = 10_000;
export const ALLOW_COMMAND = "openclaw config set channels.octopus-prime.allowRemoteReset true";
/** What the setup prints, so whoever sets the Gateway up knows the one command. */
export const ALLOW_NOTE = "Octopus Prime: to let people you choose in Octopus Prime restart this Gateway from the app, "
    + `run: ${ALLOW_COMMAND}`;
const REQUEST_ID_MAX = 128;
// When this process last agreed to restart, kept on the global object so a
// plugin module loaded again in the same process still sees it.
const LAST_RESET = Symbol.for("octopus-prime.gateway-reset.last");
/** Whether the Gateway's owner allowed restarts from Octopus Prime here. */
export function remoteResetAllowed(cfg) {
    return channelSection(cfg).allowRemoteReset === true;
}
/** Whether OpenClaw takes outside restart requests (`commands.restart`, on unless false). */
export function restartsEnabled(cfg) {
    const commands = cfg.commands;
    return !(commands && typeof commands === "object" && commands.restart === false);
}
/** The frame's request id, or "" for a frame that names none. */
export function resetRequestId(frame) {
    const id = frame.request_id;
    return typeof id === "string" && id.length > 0 && id.length <= REQUEST_ID_MAX ? id : "";
}
/**
 * Why this Gateway does not restart now, or undefined when it does; then
 * the time is taken, so a second request within RESET_EVERY_MS is refused.
 */
export function takeReset(cfg, now = Date.now()) {
    if (!remoteResetAllowed(cfg))
        return "not_allowed";
    if (!restartsEnabled(cfg))
        return "restart_disabled";
    const clock = globalThis;
    const last = clock[LAST_RESET];
    if (typeof last === "number" && now >= last && now - last < RESET_EVERY_MS)
        return "rate_limited";
    clock[LAST_RESET] = now;
    return undefined;
}
/** Test seam only: forgets the last restart. */
export function forgetLastReset() {
    delete globalThis[LAST_RESET];
}
/** Asks OpenClaw to restart, as `openclaw gateway restart` and `/restart` do from outside. */
export function requestGatewayRestart() {
    process.kill(process.pid, "SIGUSR2");
}
