import { CALENDAR_PARAMETERS, CALENDAR_TOOL, CALENDAR_TOOL_DESCRIPTION, PROJECTS_PARAMETERS, PROJECTS_TOOL, PROJECTS_TOOL_DESCRIPTION, refusedToolResult, TASKS_PARAMETERS, TASKS_TOOL, TASKS_TOOL_DESCRIPTION, workRequest, workToolResult, } from "./agent-work.js";
import { conversationSessionFor } from "./channel-history.js";
import { MEETING_PARAMETERS, MEETING_TOOL, MEETING_TOOL_DESCRIPTION } from "./meetings.js";
import { AgentWorkRefusedError, agentWorkOffered, meetingsOffered, requestAgentWork } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
const TOOLS = {
    tasks: { name: TASKS_TOOL, label: "Tasks", description: TASKS_TOOL_DESCRIPTION, parameters: TASKS_PARAMETERS },
    calendar: { name: CALENDAR_TOOL, label: "Calendar", description: CALENDAR_TOOL_DESCRIPTION, parameters: CALENDAR_PARAMETERS },
    projects: { name: PROJECTS_TOOL, label: "Projects", description: PROJECTS_TOOL_DESCRIPTION, parameters: PROJECTS_PARAMETERS },
    meetings: { name: MEETING_TOOL, label: "Meeting", description: MEETING_TOOL_DESCRIPTION, parameters: MEETING_PARAMETERS },
};
/**
 * One of the agent tools `octopus_tasks`, `octopus_calendar` and
 * `octopus_projects` (src/agent-work.ts, 1.28.0), offered only in a turn of a
 * conversation the plugin last saw dispatch a message (any conversation, as
 * channel history), only to that conversation's agent, and only while that
 * account's connection is to a backend whose welcome offered `agent-work`;
 * anywhere else the factory offers nothing. Each call goes to the backend
 * through the connector of the session's account, naming the conversation,
 * the agent and the delivery from the session, never from the model's
 * arguments. The backend acts as the person who asked, only where the agent
 * is; its refusal comes back as a plain answer the agent passes on.
 * `octopus_meeting` (1.29.0) goes the same way, offered only where the
 * backend offered meetings too.
 */
export function createAgentWorkTool(tool, ctx) {
    const session = conversationSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    if (!agentWorkOffered(session.accountId))
        return null;
    if (tool === "meetings" && !meetingsOffered(session.accountId))
        return null;
    const { name, label, description, parameters } = TOOLS[tool];
    return {
        name,
        label,
        description,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: parameters,
        async execute(_toolCallId, params, signal) {
            const request = workRequest(session, tool, params);
            let answer;
            try {
                answer = await requestAgentWork(request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof AgentWorkRefusedError) {
                    return refusedToolResult(request, error.reason, error.detail, error.code);
                }
                throw error;
            }
            return workToolResult(request, answer);
        },
    };
}
