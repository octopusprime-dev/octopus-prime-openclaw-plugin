import { createChannelApprovalNativeRuntimeAdapter, } from "openclaw/plugin-sdk/approval-handler-runtime";
import { normalizeAccountId } from "./accounts.js";
/**
 * Approve agent actions from Octopus Prime (1.31.0). OpenClaw asks before
 * risky actions: a command an agent wants to run (exec approvals) or a tool
 * call a plugin wants approved (plugin approvals). This plugin is one of
 * OpenClaw's native approval surfaces for its channel, through the plugin
 * SDK's approval capability (`approvalCapability`, built here, put on the
 * channel in src/channel.ts; its runtime is started per account by the
 * "approval.native" runtime context src/gateway.ts registers).
 *
 * Only an approval OpenClaw raised in a turn of one of this account's
 * Octopus Prime conversations is handled (its turn source names this channel
 * and account, or its session is one of this account's), and only while the
 * Gateway's owner turned "Approve agent actions in Octopus" on in the apps:
 * the backend says so on each connection (CONFIG_FRAME), and until it does
 * nothing is handled. Anything else stays wherever OpenClaw sends it today,
 * and OpenClaw's other surfaces (the Control UI, its apps, `/approve`) always
 * get every request too: the first answer wins.
 *
 * A handled approval goes to the backend as REQUEST_FRAME (`requestFrame`:
 * what the agent wants to run or do, where, and the decisions offered, with
 * its id and expiry; never the session or its messages). The backend shows a
 * card to the agent's owner and answers with DECIDE_FRAME. That decision is
 * handed to OpenClaw's approval service (`approval.resolve`, through the
 * SDK's resolveApprovalOverGateway with the approval's kind), never through
 * chat text, and only for an approval this account forwarded and OpenClaw
 * still waits for, with a decision that request offered: OpenClaw would
 * record any other decision as a deny, and resolves any id it is given.
 * When OpenClaw settles it (answered anywhere, or timed out) the backend is
 * told (RESOLVED_FRAME, EXPIRED_FRAME).
 */
export const CHANNEL = "octopus-prime";
export const HELLO_FRAME = "approvals.hello";
export const CONFIG_FRAME = "approvals.config";
export const REQUEST_FRAME = "approval.request";
export const REQUEST_RESULT = "approval.request.result";
export const REQUEST_REJECTED = "approval.request.rejected";
export const DECIDE_FRAME = "approval.decide";
export const DECIDE_RESULT = "approval.decide.result";
export const RESOLVED_FRAME = "approval.resolved";
export const EXPIRED_FRAME = "approval.expired";
export const DECISIONS = ["allow-once", "allow-always", "deny"];
const KINDS = ["exec", "plugin"];
// The backend's bounds (backend/agent_approvals.py). A command longer than
// COMMAND_MAX, or with characters the card could not show as they are, is
// not handled: the owner must see the exact command.
export const COMMAND_MAX = 4000;
const FOLDER_MAX = 1000;
const NAME_MAX = 128;
const TITLE_MAX = 80;
const TEXT_MAX = 512;
const ID_MAX = 128;
const UNSHOWABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Approvals one account remembers having forwarded.
const REMEMBERED = 500;
const accounts = new Map();
function stateOf(accountId) {
    const id = normalizeAccountId(accountId);
    let state = accounts.get(id);
    if (!state) {
        state = { enabled: false, forwarded: new Map(), resolvedHere: new Set() };
        accounts.set(id, state);
    }
    return state;
}
/** What the backend last said for this account (CONFIG_FRAME); off until it says. */
export function setApprovalsEnabled(accountId, enabled) {
    stateOf(accountId).enabled = enabled === true;
}
export function approvalsEnabled(accountId) {
    return stateOf(accountId).enabled;
}
/**
 * OpenClaw's approval service for this account, when its account task offers
 * one (src/gateway.ts); otherwise resolveApprovalOverGateway finds it itself.
 */
export function bindApprovalGateway(accountId, gatewayRuntime) {
    stateOf(accountId).gatewayRuntime = gatewayRuntime ?? undefined;
}
/** Test seam only: forgets every account. */
export function forgetApprovalAccounts() {
    accounts.clear();
}
function remember(state, approvalId, forwarded) {
    state.forwarded.delete(approvalId);
    state.forwarded.set(approvalId, forwarded);
    while (state.forwarded.size > REMEMBERED)
        state.forwarded.delete(state.forwarded.keys().next().value);
}
export function forwardedCount(accountId) {
    return stateOf(accountId).forwarded.size;
}
const text = (value) => (typeof value === "string" ? value : undefined);
/**
 * The Octopus Prime conversation an approval was raised in, when it is one of
 * this account's: its turn source names this channel and account, or, with no
 * turn source, its session is one of this account's (src/host-dispatch.ts
 * octopusSessionKey). Otherwise undefined: not this account's to handle.
 */
export function approvalConversation(request, accountId) {
    const payload = request?.request ?? {};
    const account = normalizeAccountId(accountId);
    const source = text(payload.turnSourceChannel)?.trim().toLowerCase();
    const to = text(payload.turnSourceTo)?.trim();
    if (source) {
        if (source !== CHANNEL || !to)
            return undefined;
        const sourceAccount = text(payload.turnSourceAccountId)?.trim();
        if (normalizeAccountId(sourceAccount || undefined) !== account)
            return undefined;
        return to;
    }
    const session = text(payload.sessionKey) ?? "";
    const prefix = account === "default" ? `:${CHANNEL}:channel:` : `:${CHANNEL}:${account}:channel:`;
    const at = session.indexOf(prefix);
    if (!session.startsWith("agent:") || at < 0)
        return undefined;
    const channelId = session.slice(at + prefix.length);
    return channelId && !channelId.includes(":") ? channelId : undefined;
}
/** The exact command an exec approval shows (OpenClaw's own text), else undefined. */
function commandOf(request, view) {
    return text(view?.commandText) ?? text(request.request.command);
}
/**
 * Whether this account handles the approval now: approvals are on for it,
 * it is an exec or plugin approval raised in one of its conversations, it
 * has not expired, and what it asks can be shown exactly.
 */
export function handlesApproval(request, approvalKind, accountId, now = Date.now()) {
    if (!approvalsEnabled(accountId) || !KINDS.includes(approvalKind))
        return false;
    if (!request || typeof request.id !== "string" || !request.id || request.id.length > ID_MAX)
        return false;
    if (typeof request.expiresAtMs !== "number" || request.expiresAtMs <= now)
        return false;
    if (!approvalConversation(request, accountId))
        return false;
    if (approvalKind === "exec") {
        const command = commandOf(request);
        if (!command || command.length > COMMAND_MAX || UNSHOWABLE.test(command))
            return false;
    }
    return true;
}
// -- the request frame ------------------------------------------------------------------------
function bounded(value, max) {
    if (typeof value !== "string")
        return null;
    const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    if (!cleaned.trim())
        return null;
    return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}
function oneOf(value, allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : null;
}
/** The decisions an approval offers, in order: its view's actions, else its request's list, else all three. */
export function offeredDecisions(request, view) {
    const fromView = Array.isArray(view?.actions)
        ? view.actions.map((action) => action?.decision)
        : undefined;
    const fromRequest = Array.isArray(request.request.allowedDecisions) ? request.request.allowedDecisions : undefined;
    const listed = fromView?.length ? fromView : fromRequest;
    if (!listed)
        return [...DECISIONS];
    return DECISIONS.filter((decision) => listed.includes(decision));
}
/**
 * The REQUEST_FRAME for an approval this account handles: what the backend
 * shows on the card. `view` is OpenClaw's own view of the pending approval.
 */
export function requestFrame(requestId, request, approvalKind, accountId, view = {}) {
    const payload = request.request;
    const frame = {
        type: REQUEST_FRAME,
        request_id: requestId,
        approval_id: request.id,
        kind: approvalKind,
        agent_id: bounded(text(view.agentId) ?? payload.agentId, ID_MAX),
        channel_id: approvalConversation(request, accountId) ?? null,
        allowed_decisions: offeredDecisions(request, view),
        created_at_ms: Math.floor(request.createdAtMs) || Date.now(),
        expires_at_ms: Math.floor(request.expiresAtMs),
    };
    if (approvalKind === "exec") {
        Object.assign(frame, {
            command: commandOf(request, view) ?? null,
            cwd: bounded(text(view.cwd) ?? payload.cwd, FOLDER_MAX),
            host: oneOf(text(view.host) ?? payload.host, ["gateway", "node", "sandbox"]),
            warning: bounded(text(view.warningText) ?? payload.warningText, TEXT_MAX),
        });
    }
    else {
        Object.assign(frame, {
            title: bounded(text(view.title) ?? payload.title, TITLE_MAX),
            description: bounded(text(view.description) ?? payload.description, TEXT_MAX),
            severity: oneOf(text(view.severity) ?? payload.severity, ["info", "warning", "critical"]),
            tool_name: bounded(text(view.toolName) ?? payload.toolName, NAME_MAX),
            plugin_id: bounded(text(view.pluginId) ?? payload.pluginId, NAME_MAX),
        });
    }
    return frame;
}
/**
 * The answer to the backend's DECIDE_FRAME. Refused unless approvals are on
 * here, the approval is one this account forwarded and OpenClaw still waits
 * for, and the decision is one it offered; then handed to OpenClaw's
 * approval service. "resolved": OpenClaw recorded this decision;
 * "answered": another surface answered first (its decision named);
 * "not_found": OpenClaw no longer waits for it; "failed": the service could
 * not be reached.
 */
export async function decideApproval(frame, accountId, deps) {
    const requestId = typeof frame.request_id === "string" && frame.request_id.length <= ID_MAX ? frame.request_id : "";
    const approvalId = typeof frame.approval_id === "string" ? frame.approval_id : "";
    const answer = (status, decision) => ({
        type: DECIDE_RESULT, request_id: requestId, approval_id: approvalId, status,
        ...(typeof decision === "string" && DECISIONS.includes(decision) ? { decision } : {}),
    });
    const state = stateOf(accountId);
    const decision = oneOf(frame.decision, DECISIONS);
    const forwarded = approvalId ? state.forwarded.get(approvalId) : undefined;
    if (!requestId || !decision || !forwarded || !state.enabled || !forwarded.allowed.includes(decision)) {
        return answer("refused");
    }
    if (forwarded.expiresAtMs <= (deps.now ?? Date.now)())
        return answer("not_found");
    let result;
    try {
        result = (await deps.resolve({
            approvalId, decision, approvalKind: forwarded.kind,
            ...(state.gatewayRuntime ? { gatewayRuntime: state.gatewayRuntime } : {}),
        }) ?? {});
    }
    catch (error) {
        return answer(deps.isNotFound(error) ? "not_found" : "failed");
    }
    const status = result.approval?.status;
    const recorded = result.approval?.decision;
    if ((status === "allowed" || status === "denied") && typeof recorded === "string") {
        if (result.applied === true && recorded === decision) {
            state.resolvedHere.add(approvalId);
            return answer("resolved", recorded);
        }
        return answer("answered", recorded);
    }
    return answer("not_found");
}
const entryOf = (params) => normalizeAccountId(params.accountId);
/** The native runtime: what OpenClaw's approval handler runs for this channel's accounts. */
export function approvalNativeRuntime(transport) {
    return createChannelApprovalNativeRuntimeAdapter({
        eventKinds: ["exec", "plugin"],
        availability: {
            isConfigured: (params) => Boolean(params.context),
            shouldHandle: (params) => handlesApproval(params.request, params.approvalKind, params.accountId),
        },
        presentation: {
            buildPendingPayload: (params) => requestFrame(transport.newRequestId(), params.request, params.approvalKind, params.accountId, params.view),
            buildResolvedResult: (params) => ({ kind: "update", payload: { decision: String(params.view.decision) } }),
            buildExpiredResult: () => ({ kind: "update", payload: { expired: true } }),
        },
        transport: {
            prepareTarget: (params) => {
                const channelId = params.plannedTarget.target.to;
                return channelId ? { dedupeKey: `${CHANNEL}:${entryOf(params)}:${channelId}`, target: { channelId } } : null;
            },
            deliverPending: async (params) => {
                const accountId = entryOf(params);
                const request = params.request;
                const shown = await transport.request(accountId, params.pendingPayload);
                if (!shown)
                    return null;
                remember(stateOf(accountId), request.id, {
                    kind: params.approvalKind,
                    allowed: params.pendingPayload.allowed_decisions ?? [],
                    expiresAtMs: request.expiresAtMs,
                });
                return { accountId, approvalId: request.id };
            },
            updateEntry: async (params) => {
                const state = stateOf(params.entry.accountId);
                const approvalId = params.entry.approvalId;
                state.forwarded.delete(approvalId);
                const here = state.resolvedHere.delete(approvalId);
                const payload = params.payload;
                transport.notify(params.entry.accountId, payload.expired || params.phase === "expired"
                    ? { type: EXPIRED_FRAME, approval_id: approvalId }
                    : { type: RESOLVED_FRAME, approval_id: approvalId, decision: payload.decision, by: here ? "octopus" : "openclaw" });
            },
        },
    });
}
/**
 * The channel's approval capability: native delivery to the conversation the
 * approval was raised in (its origin), and the runtime above. OpenClaw's
 * text forwarding to this channel is skipped while the native route is on,
 * so the conversation never gets the request twice.
 */
export function octopusApprovalCapability(transport) {
    return {
        native: {
            describeDeliveryCapabilities: (params) => ({
                enabled: approvalsEnabled(params.accountId),
                preferredSurface: "origin",
                supportsOriginSurface: true,
                supportsApproverDmSurface: false,
            }),
            resolveOriginTarget: (params) => {
                const to = approvalConversation(params.request, params.accountId);
                return to ? { to } : null;
            },
        },
        nativeRuntime: approvalNativeRuntime(transport),
        delivery: {
            shouldSuppressForwardingFallback: (params) => params.target.channel === CHANNEL
                && approvalsEnabled(params.target.accountId),
        },
    };
}
/** Whether a config frame says on (anything but exactly true is off). */
export function configEnabled(frame) {
    return frame.enabled === true;
}
