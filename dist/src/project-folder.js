/**
 * The project folder (1.14.0). An agent reads and
 * writes the files of its project's folder in place, with no download or
 * upload: in a turn in one of a project's channels, the `octopus_folder` tool
 * (src/project-folder-tool.ts) can
 *
 * - list the folder's folders and files, each file with its size, type, who
 *   changed it last and when, and its version;
 * - read a text file (.md, .txt, .csv, .json) a page at a time, an .xlsx as its
 *   sheet names and rows as CSV text (read only), or any other file as its
 *   details and a download link that works for minutes;
 * - create a text file in a folder that exists;
 * - edit a text file: replace its whole text, replace an exact piece of it,
 *   or add text at its end, always from the version it read. The backend
 *   refuses an edit of a file changed since, so nothing is overwritten.
 *
 * Only for that project's folder; never deletes, renames or makes folders,
 * and never touches the log book's CONTEXT.md and MILESTONES.md (the
 * octopus_log_book tool adds entries to those). Every change is a new version
 * that people in the project can view and restore. Text goes up to 1 MB each
 * way.
 *
 * A backend with project folders offers "project-folder" in its welcome, to a
 * plugin that asked for it in the negotiation's optional field (src/protocol.ts),
 * and only on such a connection is the tool offered. Its calls are frames that
 * go to POST /api/connector/folder with the connector's credential, not over
 * the socket, which takes frames up to 64 KiB (src/reply-parts.ts); the
 * backend answers each with a `folder.result` or a `folder.rejected` frame.
 */
export const FOLDER_TOOL = "octopus_folder";
export const LIST_FRAME = "folder.list";
export const READ_FRAME = "folder.read";
export const CREATE_FRAME = "folder.create";
export const EDIT_FRAME = "folder.edit";
export const RESULT_FRAME = "folder.result";
export const REJECTED_FRAME = "folder.rejected";
// The backend's limits (backend/agent_folder.py): text each way in UTF-8 bytes,
// a page of a read in code points as Python's len() counts them, a page of the
// list, a path and an id, and one call's body at its gate.
export const TEXT_MAX_BYTES = 1024 * 1024;
export const PAGE_MAX_CHARS = 60_000;
export const LIST_PAGE_MAX = 500;
const PATH_MAX_CHARS = 1_024;
const FIELD_MAX_CHARS = 128;
export const BODY_MAX_BYTES = 4 * 1024 * 1024 + 16 * 1024;
export const EDIT_MODES = ["replace", "find_replace", "append"];
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".csv", ".json"];
// -- the agent's tool --------------------------------------------------------------
export const FOLDER_TOOL_DESCRIPTION = [
    "Read and edit the files in this Octopus Prime project's Project Log (its shared folder) in place, for shared notes and documents.",
    "action \"list\": its folders and files by path, each file with its size, type, who changed it last and when, and",
    "its version (folder: list only inside one folder). action \"read\": a file by its path or file_id. A text file",
    "(.md, .txt, .csv, .json) comes a page at a time with its version; an .xlsx comes as its sheet names and rows as",
    "CSV text, read only; any other file as its details and a download link. action \"create\": a new text file at",
    "path, in a folder that exists, with text. action \"edit\": change a text file from the version you read: mode",
    "\"replace\" (text is the whole new text), \"find_replace\" (find is an exact piece of the file, replace what goes",
    "there; it must match once, or set replace_all), or \"append\" (text is added at the end). An edit of a file changed",
    "since you read it is refused: read it again and redo the edit. Every change is a new version people can restore.",
    "You cannot delete, rename or make folders, and CONTEXT.md and MILESTONES.md are kept with octopus_log_book.",
    "Text goes up to 1 MB.",
].join(" ");
export const FOLDER_PARAMETERS = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["list", "read", "create", "edit"],
            description: "list: the folder's folders and files. read: one file. create: a new text file. edit: change a text file.",
        },
        path: {
            type: "string",
            description: "For read, create and edit: the file's path in the Project Log, its folders' names and its own "
                + "joined by \"/\" (e.g. \"Meeting notes/2026-10-16.md\"), as the list shows it.",
        },
        file_id: {
            type: "string",
            description: "For read and edit, instead of path: the file's file_id from the list.",
        },
        folder: {
            type: "string",
            description: "For list: list only what is inside this folder (its path). The whole folder when left out.",
        },
        offset: {
            type: "integer",
            minimum: 0,
            description: "For list: how many entries to pass over. For read: the character to start the page at. 0 when "
                + "left out; for the next page, the offset the answer names.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            description: `For list: entries per page, up to ${LIST_PAGE_MAX}. For read: characters per page, up to `
                + `${PAGE_MAX_CHARS.toLocaleString("en-US")}.`,
        },
        text: {
            type: "string",
            description: "For create: the new file's text. For edit with mode replace: the whole new text; with append: "
                + "the text to add at the end.",
        },
        version: {
            type: "integer",
            minimum: 1,
            description: "For edit: the version of the file you read (the read and the list name it).",
        },
        mode: {
            type: "string",
            enum: [...EDIT_MODES],
            description: "For edit: replace, find_replace or append.",
        },
        find: {
            type: "string",
            description: "For edit with find_replace: the exact text to find, spaces, case and line breaks included.",
        },
        replace: {
            type: "string",
            description: "For edit with find_replace: the text that takes its place (empty to remove it).",
        },
        replace_all: {
            type: "boolean",
            description: "For edit with find_replace: replace every place the text is found, not only a single one.",
        },
    },
    required: ["action"],
    additionalProperties: false,
};
const bytesOf = (text) => Buffer.byteLength(text, "utf8");
const megabytes = (bytes) => `${(Math.ceil((bytes * 10) / (1024 * 1024)) / 10).toLocaleString("en-US")} MB`;
function textArgument(args, name, limit, what) {
    const value = args[name];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must be ${what}`);
    if ([...value].length > limit)
        throw new Error(`${name} can be up to ${limit.toLocaleString("en-US")} characters`);
    return value.trim();
}
function countArgument(args, name, largest) {
    const value = args[name];
    if (value === undefined || value === null)
        return undefined;
    const least = name === "limit" ? 1 : 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < least || (largest !== undefined && value > largest)) {
        throw new Error(`${name} must be a whole number from ${least}${largest === undefined ? " up" : ` to ${largest}`}`);
    }
    return value;
}
function sizedText(args, name, required) {
    const value = args[name];
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${name} is needed`);
        return undefined;
    }
    if (typeof value !== "string")
        throw new Error(`${name} must be text`);
    const size = bytesOf(value);
    if (size > TEXT_MAX_BYTES) {
        throw new Error(`${name} is ${megabytes(size)}; the folder tool writes text up to 1 MB`);
    }
    return value;
}
// A read or an edit names its file by path or by file_id, not both.
function fileTarget(args) {
    const path = textArgument(args, "path", PATH_MAX_CHARS, "a file's path");
    const fileId = textArgument(args, "file_id", FIELD_MAX_CHARS, "a file_id from the list");
    if (!path === !fileId)
        throw new Error("name the file by path or by file_id, not both");
    return path ? { path } : { file_id: fileId };
}
/** The frame a tool call sends, or the reason it is refused before anything is sent. */
export function folderRequest(session, params) {
    const args = (params && typeof params === "object" ? params : {});
    const place = { channel_id: session.channelId, agent_id: session.agentId };
    const offset = countArgument(args, "offset");
    const paging = (largest) => {
        const limit = countArgument(args, "limit", largest);
        return { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
    };
    if (args.action === "list") {
        const folder = textArgument(args, "folder", PATH_MAX_CHARS, "a folder's path");
        return { type: LIST_FRAME, ...place, ...(folder ? { folder } : {}), ...paging(LIST_PAGE_MAX) };
    }
    if (args.action === "read")
        return { type: READ_FRAME, ...place, ...fileTarget(args), ...paging(PAGE_MAX_CHARS) };
    if (offset !== undefined || args.limit !== undefined)
        throw new Error("offset and limit are for list and read");
    if (args.action === "create") {
        const path = textArgument(args, "path", PATH_MAX_CHARS, "the new file's path");
        if (!path)
            throw new Error("create needs the new file's path");
        if (args.file_id !== undefined)
            throw new Error("create takes a path, not a file_id");
        const name = path.split("/").pop() ?? "";
        if (!TEXT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
            throw new Error(`a new file must be a text file: its name ends in ${TEXT_EXTENSIONS.join(", ")}`);
        }
        return { type: CREATE_FRAME, ...place, path, text: sizedText(args, "text", true) };
    }
    if (args.action !== "edit")
        throw new Error("action must be list, read, create or edit");
    const version = args.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
        throw new Error("edit needs the version of the file you read");
    }
    const mode = args.mode;
    if (!EDIT_MODES.includes(mode))
        throw new Error("mode must be replace, find_replace or append");
    const edit = { type: EDIT_FRAME, ...place, ...fileTarget(args), version, mode };
    if (mode === "find_replace") {
        const find = sizedText(args, "find", true);
        if (!find)
            throw new Error("find must be the exact text to find");
        edit.find = find;
        edit.replace = sizedText(args, "replace", true);
        if (args.replace_all !== undefined) {
            if (typeof args.replace_all !== "boolean")
                throw new Error("replace_all must be true or false");
            edit.replace_all = args.replace_all;
        }
    }
    else {
        const text = sizedText(args, "text", true);
        if (mode === "append" && !text)
            throw new Error("append needs the text to add");
        edit.text = text;
    }
    return edit;
}
/** Whether a frame fits the backend's gate: a call past it is refused before it is sent. */
export function folderBody(request) {
    const body = JSON.stringify(request);
    if (bytesOf(body) > BODY_MAX_BYTES) {
        throw new Error("This change is too large to send at once; make it in smaller edits");
    }
    return body;
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** What the agent is told when the backend refuses its call: its own reason, in words it can act on. */
export function refusalMessage(reason, frame = {}) {
    const size = typeof frame.size === "number" ? `${megabytes(frame.size)}; ` : "";
    switch (reason) {
        case "unavailable":
            return "This conversation has no Project Log you can use: you must be in one of the project's channels.";
        case "not_found":
            return "No file has that path or file_id in this project's Project Log. List it to see what is there.";
        case "folder_not_found":
            return "That folder is not in this project's Project Log. List it to see its folders; only people make folders.";
        case "ambiguous":
            return "Several files match that path. Name one by its file_id from the list.";
        case "is_folder":
            return "That is a folder, not a file. List what is in it with action list and folder set to its path.";
        case "log_book":
            return "CONTEXT.md and MILESTONES.md are the project log: read them and add entries with octopus_log_book.";
        case "not_text":
            return "Only UTF-8 text files (.md, .txt, .csv, .json) can be created or edited with the folder tool.";
        case "too_large":
            return `That is ${size || "more than "}the folder tool reads and writes text up to 1 MB.`;
        case "changed":
            return `File changed since you read it — read it again.${typeof frame.version === "number" ? ` It is version ${frame.version} now.` : ""}`;
        case "name_taken":
            return "A file with that name is already in that folder. Read it and edit it instead.";
        case "invalid_name":
            return `That file name can't be used.${typeof frame.detail === "string" ? ` ${frame.detail}` : ""}`;
        case "no_match":
            return "The text to find is not in the file. It must match exactly, spaces, case and line breaks included: "
                + "read the file again and copy it.";
        case "many_matches":
            return `The text to find is in the file ${typeof frame.matches === "number" ? `${frame.matches} times` : "more than once"}. `
                + "Add some of the text around it so it matches once, or set replace_all to change every one.";
        case "folder_full":
            return "The workspace's storage is full. Ask someone in the project to make room.";
        case "subscription_inactive":
            return "The workspace's subscription is inactive, so nothing can be saved in its folders now.";
        case "unreadable":
            return "That workbook could not be read.";
        case "busy":
            return "The Project Log could not be read or saved just now. Try again in a moment.";
        case "invalid_request":
            return "The Project Log did not understand the request.";
        default:
            return "The Project Log refused the request.";
    }
}
const UNREADABLE = "Backend sent a folder answer that could not be read";
const counted = (count, noun) => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
const quoted = (value) => JSON.stringify(typeof value === "string" ? value : "");
// Who changed a file last and when, as the backend names them.
function changedBy(frame) {
    const by = isRecord(frame.updated_by) && typeof frame.updated_by.name === "string" ? frame.updated_by.name : "";
    const kind = isRecord(frame.updated_by) && frame.updated_by.kind === "agent" ? " (agent)" : "";
    const at = typeof frame.updated_at === "string" ? ` at ${frame.updated_at}` : "";
    return by ? `, last changed by ${by}${kind}${at}` : "";
}
function listResult(frame) {
    const { entries, total, offset, next_offset: next } = frame;
    if (!Array.isArray(entries) || typeof total !== "number" || typeof offset !== "number")
        throw new Error(UNREADABLE);
    // 1.23.0: the folder is called the Project Log.
    const place = `${typeof frame.folder === "string" && frame.folder ? `folder ${quoted(frame.folder)} of the ` : ""}Project Log of project ${quoted(frame.project_name)}`;
    const shown = entries.length === 0 ? `Nothing in the ${place}${offset ? ` from ${offset}` : ""}.`
        : `${offset === 0 && typeof next !== "number" ? `${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"}`
            : `Entries ${offset + 1} to ${offset + entries.length} of ${total}`} in the ${place}.`;
    const lines = [
        `${shown} Read a file with action read and its path; an editable text file can be edited with the version shown.`,
        ...(typeof next === "number" ? [`${total - next} more: call again with offset=${next}.`] : []),
    ];
    return {
        content: [{ type: "text", text: `${lines.join("\n")}\n\n${JSON.stringify({ total, offset, entries })}` }],
        details: { ok: true, action: "list", total, offset, entries: entries.length, next_offset: typeof next === "number" ? next : null },
    };
}
function readResult(frame) {
    const { path, version, format } = frame;
    if (typeof path !== "string" || typeof version !== "number" || typeof format !== "string")
        throw new Error(UNREADABLE);
    const details = { ok: true, action: "read", path, file_id: frame.file_id, version, format };
    if (format === "link") {
        if (typeof frame.download_url !== "string")
            throw new Error(UNREADABLE);
        const size = typeof frame.size === "number" ? `, ${megabytes(frame.size)}` : "";
        return {
            content: [{
                    type: "text",
                    text: `${path} (${typeof frame.content_type === "string" ? frame.content_type : "file"}${size}, version ${version}`
                        + `${changedBy(frame)}) is not text the folder tool reads. Download link, valid until `
                        + `${typeof frame.link_expires_at === "string" ? frame.link_expires_at : "it expires"}: ${frame.download_url}`,
                }],
            details,
        };
    }
    const { text, offset, chars, next_offset: next } = frame;
    if (typeof text !== "string" || typeof offset !== "number" || typeof chars !== "number")
        throw new Error(UNREADABLE);
    const kind = format === "sheet"
        ? `a workbook, as its sheets' rows in CSV, read only${Array.isArray(frame.sheets) ? ` (sheets: ${frame.sheets.join(", ")})` : ""}`
        : `version ${version}${changedBy(frame)}`;
    const part = offset === 0 && typeof next !== "number" ? counted(chars, "character")
        : `characters ${offset.toLocaleString("en-US")} to ${(offset + [...text].length).toLocaleString("en-US")} of ${chars.toLocaleString("en-US")}`;
    const more = typeof next === "number" ? `\nThere is more: call again with offset=${next}.` : "";
    const editing = format === "text" && frame.editable === true ? `\nTo edit it, pass version ${version}.` : "";
    return {
        content: [{ type: "text", text: `${path} (${kind}; ${part}):${more}${editing}\n\n${text}` }],
        details: { ...details, offset, chars, next_offset: typeof next === "number" ? next : null },
    };
}
/** What the agent gets back from the backend's `folder.result` for its call. Anything else is no answer. */
export function folderToolResult(request, frame) {
    if (request.type === LIST_FRAME)
        return listResult(frame);
    if (request.type === READ_FRAME)
        return readResult(frame);
    const { path, version, size } = frame;
    if (typeof path !== "string" || typeof version !== "number" || typeof size !== "number")
        throw new Error(UNREADABLE);
    if (request.type === CREATE_FRAME) {
        return {
            content: [{ type: "text", text: `Created ${path} in the project ${quoted(frame.project_name)}'s folder (version 1).` }],
            details: { ok: true, action: "create", path, file_id: frame.file_id, version, size },
        };
    }
    const replaced = typeof frame.replaced === "number" ? ` (${counted(frame.replaced, "place")} replaced)` : "";
    return {
        content: [{ type: "text", text: `Saved ${path} as version ${version}${replaced}. The version before stays in its history.` }],
        details: { ok: true, action: "edit", path, file_id: frame.file_id, version, size,
            ...(typeof frame.replaced === "number" ? { replaced: frame.replaced } : {}) },
    };
}
