export const TASKS_TOOL = "octopus_tasks";
export const CALENDAR_TOOL = "octopus_calendar";
export const PROJECTS_TOOL = "octopus_projects";
export const REQUEST_FRAME = "work.request";
export const RESULT_FRAME = "work.result";
export const REJECTED_FRAME = "work.rejected";
/** The line every turn on a connection that offers the tools carries (host-dispatch.ts agentWork). */
export const AGENT_WORK_INSTRUCTION = "You can create tasks, calendar events and projects in Octopus Prime with "
    + "octopus_tasks / octopus_calendar / octopus_projects when someone asks.";
// -- the agent's tools -----------------------------------------------------------------
const WHO = "A person or agent in this conversation, by name or ID: \"me\" is the person who asked you, "
    + "\"you\" is yourself.";
const PLACE = "conversation (default): this channel, or in a direct message only its people see it; project: "
    + "this conversation's project.";
const ZONE = "The IANA time zone the times are in (for example America/New_York, Europe/Madrid). Needed for a "
    + "wall time or a day; ask the person if you don't know theirs.";
const REMINDERS = { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 5,
    description: "Reminders, in whole minutes before it (for example [10, 60])." };
// How a task or an event repeats (1.39.0); the first time is the task's due time or the event's start.
const REPEAT_PROPERTIES = {
    frequency: { type: "string", enum: ["daily", "weekly", "monthly", "none"],
        description: "How often it repeats; none for no repeat." },
    weekdays: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 7,
        description: "weekly only: the days of the week it happens on, by name (monday or mon). The first time's day "
            + "is always one of them (for a task, it must be)." },
    until: { type: "string", description: "The last day it may happen on, YYYY-MM-DD. Not with count." },
    count: { type: "integer", minimum: 1, maximum: 1000, description: "How many times it happens in all. Not with until." },
};
const TASK_REPEAT = {
    type: ["object", "null"], properties: REPEAT_PROPERTIES, required: ["frequency"], additionalProperties: false,
    description: "create, update: how the task repeats from its due time (it needs a due time and timezone). For "
        + "update it is for this task and all future ones; null stops it.",
};
const EVENT_REPEAT = {
    type: ["object", "null"],
    properties: {
        ...REPEAT_PROPERTIES,
        every: { type: "integer", minimum: 1, maximum: 99, description: "Every so many days, weeks or months (1 by default)." },
    },
    required: ["frequency"], additionalProperties: false,
    description: "create, update: how the event repeats from its start, for example {\"frequency\": \"weekly\", "
        + "\"weekdays\": [\"tue\", \"thu\"], \"until\": \"2026-12-31\"}. For update, null stops it.",
};
export const TASKS_TOOL_DESCRIPTION = [
    "Create and manage tasks in Octopus Prime when someone asks.",
    "create: a task for the person who asked (or someone else in this conversation, or yourself), in this",
    "conversation or its project, with an optional due time, and repeating if asked; it shows as created by you.",
    "list: tasks of this conversation, of its project, given to you, or given to the person who asked.",
    "update: mark a task done, in progress, open again or cancelled, change its due time, assignee, title, notes,",
    "priority, category, reminders or how it repeats.",
    "comment: add a comment in the task's thread when its thread is in this conversation.",
    "You act with the permissions of the person who asked you; tasks are never deleted, only cancelled.",
].join(" ");
export const TASKS_PARAMETERS = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["create", "list", "update", "comment"],
            description: "create a task, list tasks, update one, or comment on one." },
        title: { type: "string", description: "create, update: the task's title (up to 200 characters)." },
        notes: { type: ["string", "null"], description: "create, update: more about the task. For update, null takes "
                + "the notes away." },
        due: { type: "string", description: "create, update: when it is due: YYYY-MM-DDTHH:MM in timezone, a day "
                + "YYYY-MM-DD (due at its end), or an instant with its UTC offset. For update, null takes the due time away." },
        timezone: { type: "string", description: ZONE },
        assignee: { type: "string", description: `create, update: who does it. ${WHO} For create, "me" when left out.` },
        place: { type: "string", enum: ["conversation", "project"], description: `create: where it belongs. ${PLACE}` },
        priority: { type: "string", enum: ["low", "normal", "high"], description: "create, update: its priority." },
        category: { type: ["string", "null"], description: "create, update: one of the organization's task "
                + "categories, by name. For update, null takes it away." },
        reminders: { ...REMINDERS, description: "create, update: reminders, in whole minutes before it is due." },
        repeat: TASK_REPEAT,
        scope: { type: "string", enum: ["conversation", "project", "agent", "person"],
            description: "list: this conversation's tasks (default), its project's, those given to you, or those given "
                + "to the person who asked." },
        status: { type: "string", enum: ["active", "open", "in_progress", "done", "cancelled", "any"],
            description: "list: which to list (active, the default, is open and in progress). update: the new status "
                + "(open, in_progress, done or cancelled)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "list: at most this many (20 by default)." },
        task_id: { type: "string", description: "update, comment: the task's ID (task_...)." },
        text: { type: "string", description: "comment: what to say in the task's thread." },
    },
    required: ["action"],
    additionalProperties: false,
};
export const CALENDAR_TOOL_DESCRIPTION = [
    "Create and manage calendar events in Octopus Prime when someone asks.",
    "create: an event organized by the person who asked, in this conversation or its project, with people and",
    "agents of this conversation invited; it shows as created by you.",
    "It may repeat (daily, weekly on some days, monthly; every so many; until a day or so many times).",
    "list: the events in a range (days or instants) of this conversation, of its project, or of the person who asked.",
    "update or cancel: only events you created. Events are never deleted, only cancelled.",
    "respond: answer an event the person who asked is invited to (going, maybe or no), for them.",
    "You act with the permissions of the person who asked you.",
].join(" ");
export const CALENDAR_PARAMETERS = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["create", "list", "update", "cancel", "respond"],
            description: "create an event, list events, update or cancel one you created, or respond to one for the "
                + "person who asked." },
        title: { type: "string", description: "create, update: the event's title." },
        start: { type: "string", description: "create, update: when it starts, YYYY-MM-DDTHH:MM in timezone (a day "
                + "YYYY-MM-DD when all_day). list: the first day (YYYY-MM-DD) or an instant with its UTC offset." },
        end: { type: "string", description: "create, update: when it ends, as start (the last day when all_day). "
                + "list: the last day, included, or an instant." },
        all_day: { type: "boolean", description: "create, update: an all-day event." },
        timezone: { type: "string", description: ZONE },
        description: { type: "string", description: "create, update: what it is about." },
        location: { type: "string", description: "create, update: where it is." },
        meeting_link: { type: ["string", "null"], description: "create, update: a web address to join it (https://...). "
                + "For update, null takes it away." },
        attendees: { type: "array", items: { type: "string" }, maxItems: 20,
            description: `create, update: who is invited. ${WHO} The person who asked organizes it.` },
        reminders: REMINDERS,
        repeat: EVENT_REPEAT,
        place: { type: "string", enum: ["conversation", "project"], description: `create: where it belongs. ${PLACE}` },
        scope: { type: "string", enum: ["conversation", "project", "person"],
            description: "list: this conversation's events (default), its project's, or the person who asked's." },
        event_id: { type: "string", description: "update, cancel, respond: the event's ID (cev_...)." },
        response: { type: "string", enum: ["going", "maybe", "no"],
            description: "respond: the answer of the person who asked." },
    },
    required: ["action"],
    additionalProperties: false,
};
export const PROJECTS_TOOL_DESCRIPTION = [
    "Create projects in Octopus Prime when someone asks, or list the projects you are in.",
    "create: a project with the person who asked and you in it, with its usual starter channels. Only an Owner,",
    "Admin or Manager of the organization may have one created; if the person who asked may not, tell them so.",
].join(" ");
export const PROJECTS_PARAMETERS = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["create", "list"], description: "create a project, or list yours." },
        name: { type: "string", description: "create: the project's name (up to 80 characters)." },
        description: { type: "string", description: "create: what the project is (up to 500 characters)." },
    },
    required: ["action"],
    additionalProperties: false,
};
// The arguments each tool passes on; anything else the model writes is dropped.
const ARGUMENTS = {
    tasks: ["title", "notes", "due", "timezone", "assignee", "place", "priority", "category", "reminders", "repeat",
        "scope", "status", "limit", "task_id", "text"],
    calendar: ["title", "start", "end", "all_day", "timezone", "description", "location", "meeting_link", "attendees",
        "reminders", "repeat", "place", "scope", "event_id", "response"],
    projects: ["name", "description"],
};
const ACTIONS = {
    tasks: ["create", "list", "update", "comment"],
    calendar: ["create", "list", "update", "cancel", "respond"],
    projects: ["create", "list"],
};
/**
 * The frame a tool call sends, or the reason it is refused before anything is
 * sent. The conversation, the agent and the delivery come from the session
 * alone; the model's arguments are only the tool's own, and any other (a
 * conversation, an organization, an agent or a person to act as) is dropped.
 */
export function workRequest(session, tool, params) {
    const given = (params && typeof params === "object" ? params : {});
    if (typeof given.action !== "string" || !ACTIONS[tool].includes(given.action)) {
        throw new Error(`action must be one of: ${ACTIONS[tool].join(", ")}`);
    }
    const args = {};
    for (const key of ARGUMENTS[tool]) {
        if (Object.hasOwn(given, key) && given[key] !== undefined)
            args[key] = given[key];
    }
    return {
        type: REQUEST_FRAME, channel_id: session.channelId, agent_id: session.agentId, event_id: session.eventId,
        tool, action: given.action, args,
    };
}
const REFUSALS = {
    invalid_request: "Octopus Prime did not understand the request.",
    unavailable: "This is not available to you here: you must be an agent in this conversation, shared with the "
        + "person who asked you.",
    no_person: "Only a person's request can create or change tasks, events or projects.",
    stale_turn: "The message you are answering is too old to act on; ask the person to ask again.",
    not_allowed: "The person who asked you is not allowed to do that in Octopus Prime.",
    not_found: "There is no such task, event or project where you are.",
    not_own_event: "You can change or cancel only the events you created.",
    no_thread: "That task's thread is not in this conversation.",
    refused: "Octopus Prime refused it.",
    rate_limited: "You created enough tasks, events and projects for now; try again later.",
    busy: "Octopus Prime could not do that just now. Try again in a moment.",
};
/** What the agent is told when the backend refuses its call: the backend's own sentence when it gave one. */
export function refusalMessage(reason, detail) {
    const said = typeof detail === "string" && detail.trim() ? detail.trim() : "";
    if (said)
        return said;
    return Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : "Octopus Prime refused the request.";
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const SPACES = /\s+/gu;
// One line of text: nothing the backend sends can pass for a line of its own.
const oneLine = (value) => (typeof value === "string" ? value.replace(SPACES, " ").trim() : "");
const quoted = (value) => JSON.stringify(oneLine(value));
// An instant as `YYYY-MM-DD HH:MM UTC`, or as the backend wrote it.
function utc(time) {
    const parsed = typeof time === "string" ? Date.parse(time) : Number.NaN;
    if (!Number.isFinite(parsed))
        return oneLine(time) || "no time";
    const iso = new Date(parsed).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
// Where a task or event made or changed belongs, as the agent's request sees it.
function where(request, item) {
    if (item.channel_id)
        return item.channel_id === request.channel_id ? "it is in this conversation" : "it is in a channel";
    if (item.project_id)
        return "it is in the project, not in one of its channels";
    return "only the people on it see it";
}
function taskLine(task) {
    const assignee = isRecord(task.assignee) ? task.assignee : {};
    const parts = [`${quoted(task.title)} (ID ${oneLine(task.task_id)})`, oneLine(task.status) || "open"];
    if (assignee.name)
        parts.push(`for ${oneLine(assignee.name)}${assignee.type === "agent" ? " (agent)" : ""}`);
    if (task.due_at)
        parts.push(`due ${utc(task.due_at)}${task.overdue ? ", overdue" : ""}`);
    if (task.priority && task.priority !== "normal")
        parts.push(`${oneLine(task.priority)} priority`);
    if (task.category)
        parts.push(`category ${quoted(task.category)}`);
    if (task.repeats)
        parts.push(`repeats ${oneLine(task.repeats)}`);
    const made = isRecord(task.created_by_agent) ? task.created_by_agent : undefined;
    if (made?.name)
        parts.push(`created by ${oneLine(made.name)}`);
    return parts.join(", ");
}
function eventLine(event) {
    const when = event.all_day
        ? `${oneLine(event.start_local)} to ${oneLine(event.end_local)}, all day (${oneLine(event.timezone)})`
        : `${oneLine(event.start_local)} to ${oneLine(event.end_local)} ${oneLine(event.timezone)} (${utc(event.start)} `
            + `to ${utc(event.end)})`;
    const parts = [`${quoted(event.title)} (ID ${oneLine(event.event_id)})`, when];
    if (event.repeats)
        parts.push(`repeats ${oneLine(event.repeats)}`);
    if (event.location)
        parts.push(`at ${quoted(event.location)}`);
    if (event.meeting_link)
        parts.push(`link ${quoted(event.meeting_link)}`);
    const people = Array.isArray(event.people) ? event.people.filter(isRecord) : [];
    if (people.length)
        parts.push(`people: ${people.map((p) => `${oneLine(p.name) || "Member"} (${oneLine(p.response)})`).join(", ")}`);
    const agents = Array.isArray(event.agents) ? event.agents.map(oneLine).filter(Boolean) : [];
    if (agents.length)
        parts.push(`agents: ${agents.join(", ")}`);
    if (event.cancelled === true)
        parts.push("CANCELLED");
    return parts.join(", ");
}
function projectLine(project) {
    const channels = Array.isArray(project.channels)
        ? project.channels.filter(isRecord).map((channel) => `#${oneLine(channel.name)}`).join(", ") : "";
    return `${quoted(project.name)} (ID ${oneLine(project.project_id)})${channels ? `, channels ${channels}` : ""}`;
}
const UNREADABLE = "Backend sent an answer to the request that could not be read";
// A repeat the agent asked for that the answer does not show: a backend
// without repeats does not read `repeat`, and its answer has no `repeats`
// field at all.
const NOT_SET = " Octopus Prime did not set the repeat: this server does not offer repeats yet. Tell the person.";
function notSet(request, item) {
    const asked = request.args.repeat;
    const wanted = isRecord(asked) && asked.frequency !== "none";
    return wanted && !Object.hasOwn(item, "repeats") ? NOT_SET : "";
}
/** What the agent gets back from the backend's answer to its call. */
export function workToolResult(request, frame) {
    const { tool, action } = request;
    let text;
    if (tool === "tasks") {
        if (action === "list") {
            if (!Array.isArray(frame.tasks))
                throw new Error(UNREADABLE);
            const tasks = frame.tasks.filter(isRecord);
            text = tasks.length
                ? [`${tasks.length} task${tasks.length === 1 ? "" : "s"}:`, ...tasks.map((task) => `- ${taskLine(task)}`)].join("\n")
                : "No tasks matched.";
            if (frame.truncated === true)
                text += "\nThere are more; narrow the list.";
        }
        else if (action === "comment") {
            if (typeof frame.message_id !== "string")
                throw new Error(UNREADABLE);
            text = `Commented in the thread of task ${oneLine(frame.task_id)}.`;
        }
        else {
            if (!isRecord(frame.task))
                throw new Error(UNREADABLE);
            text = `${action === "create" ? "Created task" : "Updated task"} ${taskLine(frame.task)}; ${where(request, frame.task)}.`
                + notSet(request, frame.task);
        }
    }
    else if (tool === "calendar") {
        if (action === "list") {
            if (!Array.isArray(frame.events))
                throw new Error(UNREADABLE);
            const events = frame.events.filter(isRecord);
            text = events.length
                ? [`${events.length} event${events.length === 1 ? "" : "s"} from ${utc(frame.start)} to ${utc(frame.end)}:`,
                    ...events.map((event) => `- ${eventLine(event)}`)].join("\n")
                : `No events from ${utc(frame.start)} to ${utc(frame.end)}.`;
            if (frame.truncated === true)
                text += "\nThere are more; ask for a shorter range.";
        }
        else {
            if (!isRecord(frame.event))
                throw new Error(UNREADABLE);
            if (action === "respond") {
                text = `Answered ${quoted(frame.response)} for the person who asked to event ${eventLine(frame.event)}.`;
            }
            else {
                const done = { create: "Created event", update: "Updated event", cancel: "Cancelled event" }[action] ?? "Event";
                text = `${done} ${eventLine(frame.event)}; ${where(request, frame.event)}.` + notSet(request, frame.event);
            }
        }
    }
    else if (action === "list") {
        if (!Array.isArray(frame.projects))
            throw new Error(UNREADABLE);
        const projects = frame.projects.filter(isRecord);
        text = projects.length
            ? [`${projects.length} project${projects.length === 1 ? "" : "s"} you are in:`,
                ...projects.map((project) => `- ${projectLine(project)}`)].join("\n")
            : "You are in no project of this organization that the person who asked is in too.";
    }
    else {
        if (!isRecord(frame.project))
            throw new Error(UNREADABLE);
        text = `Created project ${projectLine(frame.project)}, with the person who asked`
            + (frame.project.agent_added === false ? "; you could not be added to all of its channels." : " and you in it.");
    }
    const { type: _type, outbound_id: _outbound, ...answer } = frame;
    return { content: [{ type: "text", text }], details: { ok: true, ...answer, tool, action } };
}
/** The tool's answer to a refusal: a result the agent passes on, not an error. */
export function refusedToolResult(request, reason, detail, code) {
    return {
        content: [{ type: "text", text: refusalMessage(reason, detail) }],
        details: {
            ok: false, tool: request.tool, action: request.action, reason,
            ...(typeof code === "string" && code ? { code } : {}),
        },
    };
}
