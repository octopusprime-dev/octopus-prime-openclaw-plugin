import { AUDIT_PARAMETERS, AUDIT_TOOL, AUDIT_TOOL_DESCRIPTION, auditCall, auditedSessionFor, auditToolResult, refusalMessage, } from "./audited-workspace.js";
import { AuditRefusedError, requestAudit } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
/**
 * The agent tool `octopus_audit` (src/audited-workspace.ts), offered only in a
 * turn of a session whose last message frame said its workspace is audited,
 * and only to that session's agent; anywhere else the factory offers nothing.
 * Each call goes to the backend through the connector of the session's
 * account, naming the agent from the session, never from the model's
 * arguments. The backend answers only an agent that is on the owner's list of
 * auditors while the workspace is audited, and records the read. Which page of
 * the list of conversations the agent gets is settled here, from the backend's
 * whole list: the frame is the same for every page.
 */
export function createAuditTool(ctx) {
    const session = auditedSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    return {
        name: AUDIT_TOOL,
        label: "Audited workspace",
        description: AUDIT_TOOL_DESCRIPTION,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: AUDIT_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const call = auditCall(session, params);
            let answer;
            try {
                answer = await requestAudit(call.request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof AuditRefusedError)
                    throw new Error(refusalMessage(error.reason, call));
                throw error;
            }
            return auditToolResult(call, answer);
        },
    };
}
