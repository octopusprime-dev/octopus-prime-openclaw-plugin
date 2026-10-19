import { PLAIN_REFUSALS, refusalMessage, refusedToolResult, SESSION_TITLE_PARAMETERS, SESSION_TITLE_TOOL, SESSION_TITLE_TOOL_DESCRIPTION, titledSessionFor, titleRequest, titleToolResult, } from "./session-title.js";
import { requestSessionTitle, SessionTitleRefusedError, sessionTitleOffered } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
/**
 * The agent tool `octopus_session_title` (src/session-title.ts, 1.21.0),
 * offered only in a turn of a session the plugin last saw dispatch a message
 * the backend marked as a session's, only to that session's agent, and only
 * while that account's connection is to a backend whose welcome offered
 * session titles; anywhere else the factory offers nothing. Each call goes to
 * the backend through the connector of the session's account, naming the
 * conversation, the agent and the delivery from the session, never from the
 * model's arguments, and the backend checks that the agent is still in that
 * session. A person's name, or the hourly limit, comes back as a plain answer
 * the agent reads, not as a failed call.
 */
export function createSessionTitleTool(ctx) {
    const session = titledSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    if (!sessionTitleOffered(session.accountId))
        return null;
    return {
        name: SESSION_TITLE_TOOL,
        label: "Session title",
        description: SESSION_TITLE_TOOL_DESCRIPTION,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: SESSION_TITLE_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const request = titleRequest(session, params);
            let answer;
            try {
                answer = await requestSessionTitle(request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof SessionTitleRefusedError) {
                    if (PLAIN_REFUSALS.has(error.reason))
                        return refusedToolResult(request, error.reason);
                    throw new Error(refusalMessage(error.reason));
                }
                throw error;
            }
            return titleToolResult(request, answer);
        },
    };
}
