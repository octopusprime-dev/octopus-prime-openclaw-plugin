/**
 * A person's pictures handed to the agent as images (1.35.0).
 *
 * The links in a message's text reach OpenClaw as words; its transcript hides
 * their signature, and they stop working after an hour, so an agent could not
 * see a screenshot again on a later turn. A backend that offers inbound-media
 * names each picture of the message in its frame (`files`: id, name, type and
 * size, never a link). When the message's turn starts, the plugin downloads
 * each one from the backend with the connector's own credential
 * (GET /api/connector/files/{id}?event_id=...), at most 25 MB each, saves it
 * in OpenClaw's media store and hands it to the turn as its media, so the
 * agent sees the image and it stays in the session. A picture it cannot get
 * is named in one line after the message, which points at the link above:
 * the message's text keeps its links for every plugin. No address is ever
 * logged; the download's address carries no signature.
 */
// The kinds the backend names (chat_attachments.AGENT_MEDIA_TYPES).
export const INBOUND_PICTURE_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
]);
// A message's file may be 25 MB (the backend's MAX_FILE_BYTES); so may a picture here.
export const MAX_INBOUND_PICTURE_BYTES = 25 * 1024 * 1024;
// A message holds at most five files.
export const MAX_INBOUND_PICTURES = 5;
// How long one picture's download may take.
export const INBOUND_PICTURE_TIMEOUT_MS = 30_000;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * A frame's `files` as the plugin keeps them: each a picture with a backend
 * id, a kind it names and a whole size, at most five, each id once. Anything
 * else is left out, never a reason to refuse the message; undefined for none.
 */
export function parseInboundPictures(value) {
    if (!Array.isArray(value))
        return undefined;
    const pictures = [];
    const seen = new Set();
    for (const entry of value) {
        if (pictures.length >= MAX_INBOUND_PICTURES)
            break;
        if (!entry || typeof entry !== "object")
            continue;
        const { id, name, content_type: type, size } = entry;
        if (typeof id !== "string" || !FILE_ID.test(id) || seen.has(id))
            continue;
        if (typeof type !== "string" || !INBOUND_PICTURE_TYPES.has(type.toLowerCase()))
            continue;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
            continue;
        seen.add(id);
        pictures.push({
            id,
            name: typeof name === "string" && name.trim() ? name.trim().slice(0, 255) : "picture",
            content_type: type.toLowerCase(),
            size,
        });
    }
    return pictures.length > 0 ? pictures : undefined;
}
// A response's type without its parameters, lower case.
function mediaType(response) {
    return (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}
class TooLarge extends Error {
}
// The body, refused as soon as it passes `limit` bytes.
async function cappedBody(response, limit) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new TooLarge();
    }
    if (!response.body)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    const pieces = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw new TooLarge();
        }
        pieces.push(value);
    }
    return Buffer.concat(pieces, total);
}
/**
 * Downloads each picture in turn and saves it in OpenClaw's media store
 * (`save`, the host's saveMediaBuffer), answering the turn's media facts in
 * the message's order and the pictures that could not be had. Never throws
 * for a picture: one over 25 MB (by the frame or by what arrived), one the
 * backend refuses, of another kind than it said, cut short or not saved is
 * counted missing, and the turn goes on. A cancelled turn stops here.
 */
export async function loadInboundPictures(params) {
    const media = [];
    const missing = [];
    const count = params.pictures.length;
    for (const [index, picture] of params.pictures.entries()) {
        if (params.signal?.aborted)
            throw new Error("Octopus dispatch was cancelled");
        const said = (reason) => params.warn?.(`picture ${index + 1} of ${count} of event ${params.eventId} was not given to the agent: ${reason}`);
        if (picture.size > MAX_INBOUND_PICTURE_BYTES) {
            missing.push({ name: picture.name, reason: "too_large" });
            said("it is larger than 25 MB");
            continue;
        }
        const timeout = AbortSignal.timeout(params.timeoutMs ?? INBOUND_PICTURE_TIMEOUT_MS);
        const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
        try {
            const response = await params.download(picture, signal);
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error(`the backend answered ${response.status}`);
            }
            const type = mediaType(response) || picture.content_type;
            if (!INBOUND_PICTURE_TYPES.has(type)) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error("the backend did not answer a picture");
            }
            const buffer = await cappedBody(response, MAX_INBOUND_PICTURE_BYTES);
            const saved = await params.save(buffer, type, MAX_INBOUND_PICTURE_BYTES, picture.name);
            media.push({
                path: saved.path,
                url: saved.path,
                contentType: saved.contentType || type,
                kind: "image",
                fileName: picture.name,
                sizeBytes: buffer.byteLength,
                messageId: params.eventId,
            });
        }
        catch (error) {
            if (params.signal?.aborted)
                throw new Error("Octopus dispatch was cancelled");
            const tooLarge = error instanceof TooLarge;
            missing.push({ name: picture.name, reason: tooLarge ? "too_large" : "unavailable" });
            said(tooLarge ? "it is larger than 25 MB" : error instanceof Error && error.name === "TimeoutError"
                ? "the download took too long" : error instanceof Error ? error.message : "it could not be downloaded");
        }
    }
    return { media, missing };
}
/**
 * The line after the message for the pictures the agent was not given, or
 * undefined when it was given them all: their names, and that their links are
 * in the message.
 */
export function missingPicturesNote(missing) {
    if (missing.length === 0)
        return undefined;
    const names = missing.map((item) => `"${item.name}"${item.reason === "too_large" ? " (over 25 MB)" : ""}`).join(", ");
    const one = missing.length === 1;
    return `${one ? "A picture" : `${missing.length} pictures`} shared with this message ${one ? "isn't" : "aren't"} shown to you as ${one ? "an image" : "images"}: ${names}. Read ${one ? "it" : "them"} from the link${one ? "" : "s"} above.`;
}
/** The message as the agent gets it, with that line after it, if any. */
export function withMissingPicturesNote(body, missing) {
    const note = missingPicturesNote(missing);
    if (!note)
        return body;
    return body ? `${body}\n\n${note}` : note;
}
