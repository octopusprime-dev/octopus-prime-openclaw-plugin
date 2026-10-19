import { CHANNEL_HISTORY_PARAMETERS, CHANNEL_HISTORY_TOOL, CHANNEL_HISTORY_TOOL_DESCRIPTION, conversationSessionFor, historyRequest, historyToolResult, refusalMessage, } from "./channel-history.js";
import { ChannelHistoryRefusedError, channelHistoryOffered, requestChannelHistory } from "./transport.js";
const agentKey = (id) => id.trim().toLowerCase();
/**
 * The agent tool `octopus_channel_history` (src/channel-history.ts, 1.15.0),
 * offered only in a turn of a session the plugin last saw dispatch a message
 * (any conversation: a channel, a project's channel or a direct message),
 * only to that session's agent, and only while that account's connection is
 * to a backend whose welcome offered channel history; anywhere else the
 * factory offers nothing. Each read goes to the backend through the connector
 * of the session's account, naming the conversation, the agent and the
 * delivery from the session, never from the model's arguments, and the
 * backend checks that the agent is still in that conversation and may read it.
 */
export function createChannelHistoryTool(ctx) {
    const session = conversationSessionFor(ctx.sessionKey);
    if (!session || (typeof ctx.agentId === "string" && agentKey(ctx.agentId) !== agentKey(session.agentId)))
        return null;
    if (!channelHistoryOffered(session.accountId))
        return null;
    return {
        name: CHANNEL_HISTORY_TOOL,
        label: "Conversation history",
        description: CHANNEL_HISTORY_TOOL_DESCRIPTION,
        // A plain JSON Schema, which core validates tool arguments against as it does TypeBox's.
        parameters: CHANNEL_HISTORY_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const request = historyRequest(session, params);
            let answer;
            try {
                answer = await requestChannelHistory(request, {
                    accountId: session.accountId, signal, assertHandoff: ctx.assertInvocationCurrent,
                });
            }
            catch (error) {
                if (error instanceof ChannelHistoryRefusedError)
                    throw new Error(refusalMessage(error.reason));
                throw error;
            }
            return historyToolResult(request, answer);
        },
    };
}
