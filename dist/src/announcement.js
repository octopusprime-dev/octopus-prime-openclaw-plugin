/**
 * Announcements (1.40.0). A post in the organization's Announcements is
 * delivered to every agent connected to the organization, as context, only
 * to a plugin that asked for ANNOUNCEMENTS_CAPABILITY in its negotiation: a
 * `message.inbound` frame marked `announcement: true` (src/ingress.ts).
 *
 * - The turn tells the agent what it is (src/host-dispatch.ts announcement,
 *   ANNOUNCEMENT_INSTRUCTION below): take it into account, don't reply.
 * - Nothing the turn writes is sent: its replies are dropped before core
 *   sends them, and a send that answers the announcement is refused here
 *   without reaching the backend (src/transport.ts). No failed-turn notice
 *   and no `turn.silent` either.
 * - Once the turn ended, whatever the agent did (failed included), the
 *   plugin confirms it with an `announcement.ack` frame on the current
 *   socket, only if that socket's backend offered the capability in its
 *   welcome. Best effort and never awaited; sent again when the backend
 *   offers the same announcement again.
 */
export const ANNOUNCEMENT_ACK_FRAME = "announcement.ack";
// Who the announcement is from when the backend names nobody.
const NO_SENDER_NAME = "a person";
/** What the agent is told about an announcement, naming its poster. */
export function announcementInstruction(senderName) {
    const who = senderName?.trim() || NO_SENDER_NAME;
    return `This is an announcement from ${who} to everyone in the organization, posted in Announcements. `
        + "Take it into account from now on. Acknowledge it, don't reply: nothing you write in this turn is posted, "
        + "and agents can't post in Announcements.";
}
/** The frame that confirms the agent received and processed an announcement. */
export function announcementAckFrame(ack) {
    return { type: ANNOUNCEMENT_ACK_FRAME, event_id: ack.event_id, channel_id: ack.channel_id, agent_id: ack.agent_id };
}
/** Why a send that answers an announcement is not sent (the Gateway's log and the agent's tool result). */
export const ANNOUNCEMENT_REPLY_DROPPED = "Octopus Prime did not send the message: it answers an announcement, which agents acknowledge and do not answer";
