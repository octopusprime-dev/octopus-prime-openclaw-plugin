import { join, resolve } from "node:path";
import { validateIngressOrigin } from "./ingress-origin.js";
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { SqliteIngressQueue } from "./sqlite-ingress-queue.js";
// The backend's ids: letters, digits, "_" and "-". Anything else is no project.
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export class InvalidInboundFrameError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidInboundFrameError";
    }
}
export function parseInboundFrame(raw) {
    if (!raw || typeof raw !== "object")
        throw new InvalidInboundFrameError("Inbound frame is not an object");
    const frame = raw;
    const sender = frame.sender;
    if (frame.type !== "message.inbound" ||
        typeof frame.event_id !== "string" || !frame.event_id.trim() ||
        typeof frame.channel_id !== "string" || !frame.channel_id.trim() ||
        typeof frame.agent_id !== "string" || !frame.agent_id.trim() ||
        typeof frame.body !== "string" ||
        !sender || typeof sender !== "object" ||
        typeof sender.id !== "string" ||
        !sender.id) {
        throw new InvalidInboundFrameError("Inbound message is missing stable event, channel, agent, sender, or body facts");
    }
    if (frame.thread_id !== undefined && frame.thread_id !== null && typeof frame.thread_id !== "string") {
        throw new InvalidInboundFrameError("Inbound thread id is invalid");
    }
    const senderName = sender.name;
    if (senderName !== undefined && typeof senderName !== "string")
        throw new InvalidInboundFrameError("Inbound sender name is invalid");
    if (frame.ts !== undefined && typeof frame.ts !== "string")
        throw new InvalidInboundFrameError("Inbound timestamp is invalid");
    // An optional field: one that is not a project id is left out, never a reason to refuse the message.
    const projectId = typeof frame.project_id === "string" && PROJECT_ID.test(frame.project_id) ? frame.project_id : undefined;
    // Optional too: only the backend's exact `true` counts; anything else is left out.
    const twoFactor = sender.two_factor === true;
    const access = sender.command_access;
    const commandAccess = access === "owner" || access === "manager" ? access : undefined;
    const audited = frame.audited === true;
    const agentSession = frame.agent_session === true;
    const continuation = frame.session_continuation === true;
    const edited = frame.edited === true;
    return {
        type: "message.inbound",
        event_id: frame.event_id,
        channel_id: frame.channel_id,
        ...(frame.thread_id === undefined ? {} : { thread_id: frame.thread_id }),
        agent_id: frame.agent_id,
        sender: {
            id: sender.id,
            ...(senderName === undefined ? {} : { name: senderName }),
            ...(twoFactor ? { two_factor: true } : {}),
            ...(commandAccess ? { command_access: commandAccess } : {}),
        },
        body: frame.body,
        ...(frame.ts === undefined ? {} : { ts: frame.ts }),
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(audited ? { audited: true } : {}),
        ...(agentSession ? { agent_session: true } : {}),
        ...(continuation ? { session_continuation: true } : {}),
        ...(edited ? { edited: true } : {}),
    };
}
export function createOctopusIngress(options) {
    const accountId = options.accountId?.trim() || "default";
    const origin = validateIngressOrigin(options.origin);
    if (origin.accountId !== accountId)
        throw new Error("Ingress origin account binding mismatch");
    const databasePath = join(options.api.runtime.state.resolveStateDir(), "plugins", "octopus-prime", accountId, "origins", "v1", origin.key, "ingress.sqlite");
    if (options.databasePath !== undefined && resolve(options.databasePath) !== resolve(databasePath)) {
        throw new Error("Ingress database path must match its authenticated origin binding");
    }
    const queue = new SqliteIngressQueue({
        path: databasePath,
        channelId: "octopus-prime",
        accountId,
    });
    const monitor = createStandardRawEventIngressMonitor({
        queue,
        inspect(raw) {
            const frame = parseInboundFrame(raw);
            return { eventId: frame.event_id, laneKey: frame.channel_id };
        },
        payload: {
            serialize(raw) {
                return JSON.stringify({ bindingVersion: 1, origin, frame: parseInboundFrame(raw) });
            },
            deserialize(body) {
                let stored;
                try {
                    stored = JSON.parse(body);
                    if (!stored || stored.bindingVersion !== 1 || validateIngressOrigin(stored.origin).key !== origin.key) {
                        throw new Error("mismatch");
                    }
                }
                catch {
                    throw new InvalidInboundFrameError("Stored inbound origin binding is missing or mismatched");
                }
                return parseInboundFrame(stored.frame);
            },
            createClaimError(kind, claim) {
                return new InvalidInboundFrameError(`${kind}: ${claim.id}`);
            },
        },
        classifyAdmissionError(error) {
            return error instanceof InvalidInboundFrameError ? error.message : undefined;
        },
        drain: {
            resolveNonRetryableFailure(error) {
                return error instanceof InvalidInboundFrameError
                    ? { reason: "invalid-inbound-frame", message: error.message }
                    : null;
            },
        },
        deliver: options.dispatch,
        onError: options.onError,
    });
    return {
        ...monitor,
        databasePath,
        queue,
        async close() {
            await monitor.stop();
            queue.close();
        },
    };
}
