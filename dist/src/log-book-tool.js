import { LOG_BOOK_PARAMETERS, LOG_BOOK_TOOL, LOG_BOOK_TOOL_DESCRIPTION, logBookRequest, logBookToolResult, projectSessionFor, refusalMessage, } from "./log-book.js";
import { LogBookRefusedError, requestLogBook } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
/**
 * The agent tool `octopus_log_book` (src/log-book.ts), offered only in a turn
 * of a session that runs in a project's channel, as the plugin last saw it
 * dispatch one, and only to that session's agent; anywhere else the factory
 * offers nothing. Each call goes to the backend through the connector of the
 * session's account, naming the conversation and the agent from the session,
 * never from the model's arguments, and the backend checks that the agent is
 * still mapped there.
 */
export function createLogBookTool(ctx) {
    const session = projectSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    return {
        name: LOG_BOOK_TOOL,
        label: "Project log book",
        description: LOG_BOOK_TOOL_DESCRIPTION,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: LOG_BOOK_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const request = logBookRequest(session, params);
            let answer;
            try {
                answer = await requestLogBook(request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof LogBookRefusedError)
                    throw new Error(refusalMessage(error.reason));
                throw error;
            }
            return logBookToolResult(request, answer);
        },
    };
}
