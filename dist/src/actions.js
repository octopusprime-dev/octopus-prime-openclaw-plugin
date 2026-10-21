import { jsonResult, readReactionParams, resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import { sendReaction } from "./transport.js";
/** The backend's conversation ids: channels (ch_) and direct messages (dm_). */
export const CONVERSATION_ID = /^(?:ch|dm)_[A-Za-z0-9_-]{1,125}$/;
/**
 * The shared `message` tool on Octopus Prime offers one action, `react` (an
 * agent acknowledges a request or update with a thumbs-up). Replies still leave only through core's durable reply path.
 * Without a message id the reaction goes on the message the agent is
 * answering, whose id is the inbound event id; core lets an agent from
 * another plugin react only in its current conversation. The backend applies
 * a reaction only to a message it delivered to this agent, and a reaction
 * never wakes an agent or sends a push. It goes through the connector of the
 * account core names, the one whose message the agent is answering (core
 * allows a reaction only where that is the requester's account too).
 * Since 1.32.0 it also offers the tool's `presentation` parameter, so an
 * agent's send can carry a card, table or chart (src/presentation.ts).
 */
export const octopusMessageActions = {
    describeMessageTool: () => ({ actions: ["react"], capabilities: ["presentation"] }),
    supportsAction: ({ action }) => action === "react",
    handleAction: async (ctx) => {
        if (ctx.action !== "react")
            throw new Error(`Octopus Prime does not support the ${ctx.action} message action`);
        const target = resolveReactionMessageId({ args: ctx.params, toolContext: ctx.toolContext });
        const eventId = target === undefined ? "" : String(target).trim();
        if (!eventId)
            throw new Error("An Octopus Prime reaction needs the message to react to");
        const reaction = readReactionParams(ctx.params, {
            removeErrorMessage: "Name the emoji to remove from an Octopus Prime message.",
        });
        const emoji = reaction.emoji.trim();
        if (!emoji)
            throw new Error("An Octopus Prime reaction needs an emoji");
        const agentId = ctx.agentId?.trim();
        await sendReaction({
            accountId: ctx.accountId ?? ctx.requesterAccountId,
            eventId,
            emoji,
            remove: reaction.remove,
            ...(agentId ? { agentId } : {}),
            assertHandoff: ctx.assertDirectAdapterHandoff,
        });
        return jsonResult(reaction.remove ? { ok: true, removed: emoji } : { ok: true, added: emoji });
    },
};
