/** The most files one message holds (MAX_MESSAGE_ATTACHMENTS in backend/server.py). */
export const MAX_REPLY_FILES = 5;
/** The largest file the backend keeps (MAX_FILE_BYTES in backend/server.py). */
export const MAX_REPLY_FILE_BYTES = 5 * 1024 * 1024;
function named(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** A reply's files, each once, in the order core names them (mediaUrl first). */
export function replyMediaUrls(payload) {
    const urls = [];
    for (const url of [payload.mediaUrl, ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [])]) {
        const name = named(url);
        if (name && !urls.includes(name))
            urls.push(name);
    }
    return urls;
}
/**
 * Reads one file as core's channels read outbound media, without changing
 * it: the backend cleans an image's metadata itself. Loaded only when a reply
 * has files, so a reply of text alone never loads core's media modules.
 */
export const loadReplyFile = async (mediaUrl, access) => {
    const [{ loadWebMediaRaw }, { buildOutboundMediaLoadOptions }] = await Promise.all([
        import("openclaw/plugin-sdk/web-media"),
        import("openclaw/plugin-sdk/media-runtime"),
    ]);
    const loaded = await loadWebMediaRaw(mediaUrl, buildOutboundMediaLoadOptions({
        maxBytes: MAX_REPLY_FILE_BYTES,
        ...(access.mediaAccess ? { mediaAccess: access.mediaAccess } : {}),
        ...(access.mediaLocalRoots ? { mediaLocalRoots: access.mediaLocalRoots } : {}),
        ...(access.mediaReadFile ? { mediaReadFile: access.mediaReadFile } : {}),
    }));
    if (loaded.buffer.byteLength > MAX_REPLY_FILE_BYTES)
        throw new Error("The file is larger than 5 MB");
    return { buffer: loaded.buffer, contentType: loaded.contentType, fileName: loaded.fileName };
};
