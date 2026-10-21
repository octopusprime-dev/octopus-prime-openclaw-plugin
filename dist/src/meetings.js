/**
 * Your agent in your meetings (1.29.0). Someone in Octopus Prime presses "Send
 * <agent> to this meeting" on a Zoom, Google Meet or Microsoft Teams link, and
 * the agent joins it with OpenClaw's own meeting plugins (`zoom-meetings`,
 * `google-meet`, `teams-meetings`) as an observe-only guest that reads the
 * live captions; afterwards it posts the notes in that conversation.
 *
 * - The plugin asks for MEETINGS_CAPABILITY in the negotiation's optional
 *   field. On a connection whose backend offered it, it reports which meeting
 *   plugins this Gateway has (REPORT_FRAME, read from OpenClaw's config: see
 *   meetingsReport) on connect and whenever that changes, for Settings ›
 *   Plugin and the apps' "Send" button.
 * - The request is a person's message. Its delivery says which meeting
 *   (`meeting`, src/ingress.ts), and that turn tells the agent to join it with
 *   the platform's tool in `transcribe` mode and to say how it went with
 *   `octopus_meeting` (meetingInstruction).
 * - When the meeting should be over (`ends_at`), the plugin sends DUE_FRAME
 *   (MeetingDueTimers) and the backend asks for the notes in the requester's
 *   name; that turn tells the agent to read OpenClaw's notes (its
 *   `transcripts` tool) and post them with `octopus_meeting`.
 *
 * `octopus_meeting` is 1.28.0's `work.request` (tool "meetings",
 * src/agent-work.ts): the backend acts for the person whose message started
 * the turn, only for a meeting this agent was sent to in this conversation.
 */
export const MEETING_TOOL = "octopus_meeting";
export const REPORT_FRAME = "meetings.report";
export const DUE_FRAME = "meeting.due";
/** Each platform's label, OpenClaw plugin id and agent tool (OpenClaw docs/plugins/meeting-plugins.md). */
export const MEETING_PLATFORMS = {
    zoom: { label: "Zoom", plugin: "zoom-meetings", tool: "zoom_meetings" },
    google_meet: { label: "Google Meet", plugin: "google-meet", tool: "google_meet" },
    teams: { label: "Microsoft Teams", plugin: "teams-meetings", tool: "teams_meetings" },
};
const PLATFORM_ORDER = ["zoom", "google_meet", "teams"];
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const listed = (value, id) => Array.isArray(value) && value.includes(id);
/**
 * A meeting plugin's state in this Gateway's config: "missing" without a
 * `plugins.entries.<id>` (a normal `openclaw plugins install` writes one,
 * enabled); "off" when it, or plugins as a whole, is turned off, denied, or
 * left out of a restrictive allow list; otherwise "ready". OpenClaw's own
 * `openclaw <platform> setup` check stays the authority on whether a join
 * can work (Chrome profile, captions, audio).
 */
export function meetingPluginState(cfg, plugin) {
    const plugins = cfg.plugins;
    if (!isRecord(plugins))
        return "missing";
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const entry = Object.hasOwn(entries, plugin) ? entries[plugin] : undefined;
    if (!isRecord(entry))
        return "missing";
    if (plugins.enabled === false || entry.enabled === false || listed(plugins.deny, plugin))
        return "off";
    if (Array.isArray(plugins.allow) && plugins.allow.length > 0 && !plugins.allow.includes(plugin))
        return "off";
    return "ready";
}
/**
 * What REPORT_FRAME says of this Gateway: each meeting plugin's state, and
 * whether OpenClaw keeps meeting notes (`transcripts.enabled`, on unless set
 * to false); without them no notes come back from a meeting.
 */
export function meetingsReport(cfg) {
    const platforms = {};
    for (const platform of PLATFORM_ORDER)
        platforms[platform] = meetingPluginState(cfg, MEETING_PLATFORMS[platform].plugin);
    const transcripts = cfg.transcripts;
    return { platforms, notes: !(isRecord(transcripts) && transcripts.enabled === false) };
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const URL_MAX = 2048;
/**
 * A delivery's `meeting`, as the turn uses it, or undefined for one that is
 * not right (then the message is a plain one). The tool and the label come
 * from MEETING_PLATFORMS, never from the frame; the link must be https.
 */
export function parseMeetingMark(value) {
    if (!isRecord(value))
        return undefined;
    const { meeting_id: meetingId, phase, platform, url, ends_at: endsAt } = value;
    if (typeof meetingId !== "string" || !ID.test(meetingId))
        return undefined;
    if (phase !== "join" && phase !== "notes")
        return undefined;
    if (typeof platform !== "string" || !Object.hasOwn(MEETING_PLATFORMS, platform))
        return undefined;
    if (typeof url !== "string" || url.length > URL_MAX || !/^https:\/\/\S+$/i.test(url))
        return undefined;
    const ends = typeof endsAt === "string" && Number.isFinite(Date.parse(endsAt)) ? endsAt : undefined;
    return { meeting_id: meetingId, phase, platform: platform, url, ...(ends ? { ends_at: ends } : {}) };
}
/** What the turn of a meeting's request, or of its notes request, tells the agent. */
export function meetingInstruction(mark) {
    const { label, tool } = MEETING_PLATFORMS[mark.platform];
    if (mark.phase === "join") {
        return [
            `This message sends you to a ${label} meeting as the person's notetaker (meeting ID ${mark.meeting_id}).`,
            `Join it now with the ${tool} tool: action "join", url ${JSON.stringify(mark.url)}, mode "transcribe".`,
            "Only listen: never speak in the meeting.",
            `Then call ${MEETING_TOOL} with action "status", meeting_id "${mark.meeting_id}" and state "joined", or "failed"`,
            "with what stopped you (for example the host must let you in, or a sign-in is needed) as detail, and tell the",
            "person in one short reply. You will be asked for the notes here when the meeting should be over.",
        ].join(" ");
    }
    return [
        `The ${label} meeting you were sent to (meeting ID ${mark.meeting_id}, ${mark.url}) should be over now.`,
        `If you are still in it, leave it with the ${tool} tool (action "leave").`,
        "Read OpenClaw's notes of it with the transcripts tool (action \"list\", then \"show\" for this meeting).",
        `Post them with ${MEETING_TOOL}: action "notes", meeting_id "${mark.meeting_id}", a short summary, the decisions`,
        "and the action items. Make each action item that has a clear owner in this conversation a task with",
        "octopus_tasks. If the notes are not ready yet, say so in one short reply instead.",
    ].join(" ");
}
// -- the agent's tool --------------------------------------------------------------------
export const MEETING_TOOL_DESCRIPTION = [
    "Say how a meeting you were sent to from Octopus Prime went, and post its notes.",
    "status: you joined it, could not join it (with what stopped you), or left it.",
    "notes: post the meeting's notes in this conversation (a summary, the decisions, the action items); they are",
    "added to the project's Project Log too. Only for a meeting you were sent to in this conversation, once.",
].join(" ");
export const MEETING_PARAMETERS = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["status", "notes"], description: "status: how it went; notes: post the notes." },
        meeting_id: { type: "string", description: "The meeting ID in the request (the request message's ID)." },
        state: { type: "string", enum: ["joined", "failed", "left"], description: "status: joined, failed or left." },
        detail: { type: "string", description: "status: for failed, what stopped you, in a few words." },
        summary: { type: "string", description: "notes: what the meeting was about and concluded (up to 4000 characters)." },
        decisions: { type: "array", items: { type: "string" }, maxItems: 30, description: "notes: one line per decision." },
        action_items: { type: "array", items: { type: "string" }, maxItems: 30,
            description: "notes: one line per action item, with its owner when known." },
    },
    required: ["action", "meeting_id"],
    additionalProperties: false,
};
// -- asking for the notes when the meeting is over ---------------------------------------
/** How long a timer waits at most, and how often a frame that found no socket is tried again. */
export const DUE_WAIT_MAX_MS = 24 * 60 * 60 * 1_000;
export const DUE_RETRY_MS = 60_000;
export const DUE_RETRIES = 30;
export function dueFrame(due) {
    return { type: DUE_FRAME, meeting_id: due.meeting_id, channel_id: due.channel_id, agent_id: due.agent_id };
}
/**
 * One timer per meeting: at its end, `send` is called with its DUE_FRAME; one
 * that returns false (no socket just now) is tried again every DUE_RETRY_MS,
 * DUE_RETRIES times. Arming a meeting again replaces its timer. The timers
 * never keep the process alive and all end with clear(). They live in this
 * process only: after a Gateway restart the person asks for the notes in the
 * app ("Ask for the notes").
 */
export class MeetingDueTimers {
    send;
    now;
    timers = new Map();
    constructor(send, now = Date.now) {
        this.send = send;
        this.now = now;
    }
    arm(due) {
        const ends = Date.parse(due.ends_at);
        if (!Number.isFinite(ends))
            return;
        this.schedule(due, Math.min(Math.max(ends - this.now(), 0), DUE_WAIT_MAX_MS), DUE_RETRIES);
    }
    get size() {
        return this.timers.size;
    }
    clear() {
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
    }
    schedule(due, delay, retries) {
        const previous = this.timers.get(due.meeting_id);
        if (previous)
            clearTimeout(previous);
        const timer = setTimeout(() => {
            this.timers.delete(due.meeting_id);
            let sent = false;
            try {
                sent = this.send(dueFrame(due));
            }
            catch {
                sent = false;
            }
            if (!sent && retries > 0)
                this.schedule(due, DUE_RETRY_MS, retries - 1);
        }, delay);
        timer.unref?.();
        this.timers.set(due.meeting_id, timer);
    }
}
