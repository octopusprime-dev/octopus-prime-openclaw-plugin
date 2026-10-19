/**
 * An agent reply's attachments that cannot reach Octopus Prime, and the note
 * that counts them.
 *
 * Until 1.11.0 core required a "media" capability for a reply payload with
 * mediaUrl or mediaUrls, which this channel did not declare, so OpenClaw
 * refused the whole reply, text included ("prepared payload capability
 * mismatch (media)"), and the person saw nothing (1.8.0 left the files out
 * and added the note). Since 1.11.0 core's media path delivers a reply's files
 * (src/reply-media.ts), and the note counts those that could not be delivered.
 * Core runs the channel's outbound normalizePayload on every reply before that
 * check: a payload that names attachments with no mediaUrl or mediaUrls, which
 * core's media path never sends, still leaves as its text and the note. The
 * note names no file, path or URL (they can be local Gateway paths).
 *
 * Core also copies a reply's local files into its delivery queue before the
 * send, in OpenClaw 2026.9.8 and 2026.10.3 alike, and a file it cannot copy
 * (gone, not a file, over its 5 MB) fails the whole reply there. So such a
 * file is left out here, before that copy, and counted in the note.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_REPLY_FILE_BYTES } from "./reply-media.js";
// Fields that only describe the attachments, which go with them.
const ATTACHMENT_FIELDS = [
    "mediaUrl",
    "mediaUrls",
    "attachments",
    "trustedLocalMedia",
    "sensitiveMedia",
    "audioAsVoice",
    "videoAsNote",
];
function named(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/**
 * How many distinct attachments a reply carries. A file is known by its URL or
 * path, so one named in mediaUrl, in mediaUrls and in attachments counts once.
 * OpenClaw keeps attachments as metadata of mediaUrls, so an entry that names
 * no file is one of those URLs, and counts on its own only when there are none.
 */
export function attachmentCount(payload) {
    const files = new Set();
    for (const url of [payload.mediaUrl, ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [])]) {
        const name = named(url);
        if (name)
            files.add(name);
    }
    let unnamed = 0;
    for (const attachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
        if (!attachment || typeof attachment !== "object")
            continue;
        const name = named(attachment.url) ?? named(attachment.mediaUrl) ?? named(attachment.path) ?? named(attachment.filePath);
        if (name)
            files.add(name);
        else
            unnamed += 1;
    }
    return files.size > 0 ? files.size : unnamed;
}
export function attachmentsNote(count) {
    return `(${count} attachment${count === 1 ? "" : "s"} couldn't be delivered in Octopus.)`;
}
// The note a reply's text already ends with, put there when its payload was
// prepared (withoutAttachments), with the text before it.
const TRAILING_NOTE = /(?:^|\n\n)\((\d+) attachments? couldn't be delivered in Octopus\.\)$/;
/**
 * A reply's text with the note for `count` files after it, on a line of its
 * own, or the note alone when there is no text; the text unchanged for none.
 * A note it already ends with (files left out when its payload was prepared)
 * counts these too, so a reply has one note. A long reply is then cut into
 * parts as any other (src/reply-parts.ts), so the note ends its last part.
 */
export function withAttachmentsNote(text, count) {
    if (count === 0)
        return text;
    const earlier = TRAILING_NOTE.exec(text);
    if (earlier) {
        const before = text.slice(0, earlier.index);
        const note = attachmentsNote(Number(earlier[1]) + count);
        return before ? `${before}\n\n${note}` : note;
    }
    const note = attachmentsNote(count);
    const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return text.trim() ? `${text}${gap}${note}` : note;
}
// Images core shrinks to fit when it copies them (its own image optimizer),
// so one over 5 MB still arrives.
const SHRUNK_IMAGES = /\.(?:jpe?g|png|webp)$/i;
// The kinds of local file core copies from the Gateway (its host media rule:
// images, audio, video, PDF, Office documents, archives and plain text, each
// checked against its contents); it refuses any other, and the reply with it.
const COPIED_KINDS = new RegExp("\\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif"
    + "|mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|mp4|m4v|mov|webm|mkv|avi"
    + "|pdf|docx?|xlsx?|xlsm|pptx?|zip|gz|tgz|7z|tar|txt|md|csv|json|ya?ml)$", "i");
// A file's local path on the Gateway, as core reads it, or undefined for one
// core does not copy (a remote or data URL) or resolves against a workspace.
function localPath(source) {
    if (/^file:/i.test(source)) {
        try {
            return fileURLToPath(source);
        }
        catch {
            return undefined;
        }
    }
    if (source === "~" || source.startsWith("~/"))
        return path.join(homedir(), source.slice(1));
    return path.isAbsolute(source) ? source : undefined;
}
// Whether core can copy a reply's file into its queue: any but a local path
// that is gone, not a file, of a kind core does not copy, or over 5 MB (an
// image core shrinks excepted).
function copyable(source) {
    const file = localPath(source);
    if (file === undefined)
        return true;
    if (!COPIED_KINDS.test(file))
        return false;
    try {
        const stats = statSync(file);
        return stats.isFile() && (stats.size <= MAX_REPLY_FILE_BYTES || SHRUNK_IMAGES.test(file));
    }
    catch {
        return false;
    }
}
/**
 * The reply as core's send path takes it. A payload without attachments, or
 * whose files core's media path can all send, is handed back as it is. A
 * file core could not copy is left out, with every attachment entry naming
 * it, and the note counts it. One that names attachments core never sends
 * (no mediaUrl or mediaUrls left) loses them and every field about them; its
 * text is kept exactly, with the note.
 */
export function withoutAttachments(payload) {
    const text = typeof payload.text === "string" ? payload.text : "";
    const sources = [payload.mediaUrl, ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [])]
        .flatMap((url) => (named(url) ? [named(url)] : []));
    const left = new Set(sources.filter((source) => !copyable(source)));
    if (sources.length > 0 && left.size < new Set(sources).size) {
        if (left.size === 0)
            return payload;
        const sent = (url) => !(named(url) && left.has(named(url)));
        const narrowed = { ...payload, text: withAttachmentsNote(text, left.size) };
        if (!sent(payload.mediaUrl))
            delete narrowed.mediaUrl;
        if (Array.isArray(payload.mediaUrls))
            narrowed.mediaUrls = payload.mediaUrls.filter(sent);
        if (Array.isArray(payload.attachments)) {
            narrowed.attachments = payload.attachments.filter((attachment) => !attachment || typeof attachment !== "object"
                || sent(named(attachment.url) ?? named(attachment.mediaUrl) ?? named(attachment.path) ?? named(attachment.filePath)));
        }
        return narrowed;
    }
    const count = attachmentCount(payload);
    if (count === 0)
        return payload;
    const kept = { ...payload };
    for (const field of ATTACHMENT_FIELDS)
        delete kept[field];
    return { ...kept, text: withAttachmentsNote(text, count) };
}
