import { projectSessionFor } from "./log-book.js";
import { FOLDER_PARAMETERS, FOLDER_TOOL, FOLDER_TOOL_DESCRIPTION, folderRequest, folderToolResult, refusalMessage, } from "./project-folder.js";
import { FolderRefusedError, projectFolderOffered, requestFolder } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
/**
 * The agent tool `octopus_folder` (src/project-folder.ts), offered only in a
 * turn of a session that runs in a project's channel, as the plugin last saw
 * it dispatch one, only to that session's agent, and only while that
 * account's connection is to a backend that offered the project folder;
 * anywhere else the factory offers nothing. Each call goes to the backend
 * with the connector of the session's account, naming the conversation and
 * the agent from the session, never from the model's arguments, and the
 * backend checks that the agent is still mapped there.
 */
export function createFolderTool(ctx) {
    const session = projectSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    if (!projectFolderOffered(session.accountId))
        return null;
    return {
        name: FOLDER_TOOL,
        label: "Project folder",
        description: FOLDER_TOOL_DESCRIPTION,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: FOLDER_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const request = folderRequest(session, params);
            let answer;
            try {
                answer = await requestFolder(request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof FolderRefusedError)
                    throw new Error(refusalMessage(error.reason, error.frame));
                throw error;
            }
            return folderToolResult(request, answer);
        },
    };
}
