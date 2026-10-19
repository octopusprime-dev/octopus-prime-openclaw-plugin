/**
 * An agent reply, cut into the messages the backend keeps whole.
 *
 * The backend keeps at most 20,000 characters of a message (MESSAGE_BODY_MAX in
 * backend/server.py) and cuts a longer agent reply short (connector_reply_body).
 * It counts as Python's len() does, in Unicode code points: an emoji is one
 * character there, where a JavaScript string's length counts two. Its connector
 * socket also closes on any frame over 64 KiB (ws_max_size in
 * backend/run_server.py), and the reply in that frame is lost. So a reply over
 * either limit is sent as several messages, each in a frame of at most 60,000
 * bytes. OpenClaw 2026.9.8 would split a reply itself only for a channel that
 * declares a chunker, and it could not finish a reply cut that way after a later
 * part failed (see sendOutboundReply in transport.ts). Each part's frame names
 * the reply and the part's place in it, so the backend counts, pushes and
 * answers the parts once, as the one reply they are (reply_part in server.py).
 */
import { createHash } from "node:crypto";
/** The most characters (code points) of one message the backend keeps. */
export const REPLY_PART_MAX_CHARS = 20_000;
/** The largest frame written for one part, under the backend socket's 65,536 bytes. */
export const OUTBOUND_FRAME_MAX_BYTES = 60_000;
/** The backend ignores a frame whose outbound_id is longer. */
export const OUTBOUND_ID_MAX_LENGTH = 128;
/**
 * The outbound id of each part. The first part keeps the queue's own id, so a
 * reply that fits in one message is sent exactly as before; part n adds ":n".
 * The ids derive from the queue id alone, so a resend of the reply names every
 * part as the first send did, and the backend, which keeps one message per
 * connector and outbound id, answers a part it already holds with its receipt.
 * A queue id too long for the suffix is replaced by its SHA-256, which keeps
 * every id within the backend's 128 characters.
 */
export function replyPartOutboundId(queueId, index) {
    if (index === 0)
        return queueId;
    const id = `${queueId}:${index + 1}`;
    if (id.length <= OUTBOUND_ID_MAX_LENGTH)
        return id;
    return `${createHash("sha256").update(queueId).digest("hex")}:${index + 1}`;
}
const LINE_BREAK = 0x0a;
// Fenced code blocks as CommonMark defines them: three or more backticks or
// tildes, indented at most three spaces, closed by a run of the same character
// at least as long.
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// A sentence ends with one of these, then any closing quotes or brackets, then a space.
const SENTENCE_ENDS = new Set([".", "!", "?", "…", "‼", "⁇", "⁈", "⁉", "。", "！", "？", "｡"]);
// These end a sentence without a space after them, as Chinese and Japanese text has none.
const FULL_STOPS = new Set(["。", "！", "？", "｡"]);
const CLOSERS = new Set([")", "]", "}", "\"", "'", "»", "”", "’", "」", "』", "）", "】", "〉", "》"]);
const GRAPHEMES = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
/** Spaces a message may be cut at; no-break spaces are not among them. */
function isBreakSpace(unit) {
    return unit === 0x20 || (unit >= 0x09 && unit <= 0x0d) || unit === 0x1680
        || (unit >= 0x2000 && unit <= 0x200a && unit !== 0x2007)
        || unit === 0x2028 || unit === 0x2029 || unit === 0x205f || unit === 0x3000;
}
/** UTF-8 bytes of one UTF-16 code unit inside a JSON string, as JSON.stringify writes it. */
function unitBytes(unit) {
    if (unit === 0x22 || unit === 0x5c)
        return 2;
    if (unit < 0x20)
        return unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6;
    if (unit < 0x80)
        return 1;
    if (unit < 0x800)
        return 2;
    // A surrogate here is a lone one, which JSON.stringify writes as \uXXXX.
    if (unit >= 0xd800 && unit <= 0xdfff)
        return 6;
    return 3;
}
function pairAt(text, i) {
    const high = text.charCodeAt(i);
    const low = text.charCodeAt(i + 1);
    return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}
function costOf(text) {
    let chars = 0;
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
        chars += 1;
        if (pairAt(text, i)) {
            bytes += 4;
            i += 1;
        }
        else {
            bytes += unitBytes(text.charCodeAt(i));
        }
    }
    return [chars, bytes];
}
/**
 * Cuts a reply into parts within `limits`, in order. A reply that fits is
 * returned whole and unchanged. Otherwise each part ends at the last paragraph
 * break that leaves it at least half full; failing that, at the last line
 * break, sentence end or space that does (in that order); failing those, at
 * the last of any of them; only text with none of them is cut between two
 * characters, and never inside a surrogate pair or a grapheme cluster (an emoji
 * with a skin tone, a family, a flag). The blank lines or spaces at a cut are
 * dropped; the next line's indentation is kept. A fenced code block that fits
 * in one part is never cut: the part before it ends first. A block too long for
 * one part is cut between its lines, closed with its fence at the end of one
 * part and reopened with its opening line at the start of the next.
 */
export function splitReply(text, limits) {
    const [totalChars, totalBytes] = costOf(text);
    if (totalChars <= limits.maxChars && totalBytes <= limits.maxBytes)
        return [text];
    return cutParts(text, limits, 0);
}
/**
 * The parts of what follows `from` (a UTF-16 index) in a reply, cut as
 * splitReply cuts them, or none if nothing but spaces follows. They start as a
 * part after a cut does, past the spaces and blank lines there. From inside a
 * fenced code block the first part reopens the block (from inside its opening
 * line, the whole line); from inside its closing line the block is over.
 */
export function splitReplyFrom(text, limits, from) {
    return cutParts(text, limits, from);
}
/**
 * What the backend holds of a reply that a plugin before 1.2.0 sent whole, in
 * one frame (connector_reply_body in backend/server.py): the reply itself up to
 * 20,000 characters, else its first 19,999 and "…". `kept` is where the text it
 * did not keep starts, as a UTF-16 index (the reply's length if it kept it all).
 */
export function wholeReplySave(text) {
    let chars = 0;
    let cut = text.length;
    for (let i = 0; i < text.length; i += pairAt(text, i) ? 2 : 1) {
        if (chars === REPLY_PART_MAX_CHARS - 1)
            cut = i;
        chars += 1;
    }
    return chars > REPLY_PART_MAX_CHARS ? { body: `${text.slice(0, cut)}…`, kept: cut } : { body: text, kept: text.length };
}
function cutParts(text, limits, from) {
    const n = text.length;
    // Running characters and bytes before each offset. Both halves of a surrogate
    // pair count it whole, and no cut falls between them.
    const chars = new Uint32Array(n + 1);
    const bytes = new Uint32Array(n + 1);
    const insidePair = new Uint8Array(n + 1);
    for (let i = 0; i < n;) {
        if (pairAt(text, i)) {
            chars[i + 1] = chars[i + 2] = chars[i] + 1;
            bytes[i + 1] = bytes[i + 2] = bytes[i] + 4;
            insidePair[i + 1] = 1;
            i += 2;
        }
        else {
            chars[i + 1] = chars[i] + 1;
            bytes[i + 1] = bytes[i] + unitBytes(text.charCodeAt(i));
            i += 1;
        }
    }
    const fits = (from, to, extra) => chars[to] - chars[from] + extra[0] <= limits.maxChars && bytes[to] - bytes[from] + extra[1] <= limits.maxBytes;
    const fences = findFences(text, (from, to) => fits(from, to, [0, 0]));
    // The block whose span holds `at`, from just after its opening line's start
    // to the end of its closing line.
    const fenceAround = (at) => {
        let low = 0;
        let high = fences.length - 1;
        let found;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (fences[middle].open < at) {
                found = fences[middle];
                low = middle + 1;
            }
            else {
                high = middle - 1;
            }
        }
        return found && at < found.closeEnd ? found : undefined;
    };
    const insideCode = (fence, at) => fence.oversized && fence.body < at && at < fence.close;
    const closing = (cut) => (cut.open ? `${text.charCodeAt(cut.end - 1) === LINE_BREAK ? "" : "\n"}${cut.open.closeLine}` : "");
    const partFits = (start, prefix, cut) => {
        const [closeChars, closeBytes] = costOf(closing(cut));
        return fits(start, cut.end, [prefix[0] + closeChars, prefix[1] + closeBytes]);
    };
    // Back from `at` over the spaces that end a part.
    const trimBack = (at, start) => {
        let end = at;
        while (end > start && isBreakSpace(text.charCodeAt(end - 1)))
            end -= 1;
        return end;
    };
    // Over the spaces from `at`: where the next part starts (the start of the
    // line after the last line break, keeping its indentation), and how many
    // line breaks were passed.
    const skipSpaces = (at) => {
        let next = at;
        let breaks = 0;
        let lineStart = -1;
        while (next < n && isBreakSpace(text.charCodeAt(next))) {
            if (text.charCodeAt(next) === LINE_BREAK) {
                breaks += 1;
                lineStart = next + 1;
            }
            next += 1;
        }
        return [next >= n || lineStart < 0 ? next : lineStart, breaks];
    };
    // A cut in prose drops the spaces between `end` and `next`; it may not fall in a block.
    const proseCut = (end, next) => (fenceAround(end) ? undefined : { end, next });
    const cutAtParagraph = (i, start) => {
        if (text.charCodeAt(i) !== LINE_BREAK)
            return undefined;
        const [next, breaks] = skipSpaces(i);
        return breaks > 1 ? proseCut(trimBack(i, start), next) : undefined;
    };
    const cutAtLine = (i, start) => {
        if (text.charCodeAt(i) !== LINE_BREAK)
            return undefined;
        const fence = fenceAround(i + 1);
        if (fence)
            return insideCode(fence, i + 1) ? { end: i + 1, next: i + 1, open: fence } : undefined;
        return proseCut(trimBack(i, start), skipSpaces(i)[0]);
    };
    const cutAtSentence = (i, start) => {
        const space = isBreakSpace(text.charCodeAt(i));
        if (!space && CLOSERS.has(text[i]))
            return undefined;
        let last = i - 1;
        while (last > start && CLOSERS.has(text[last]))
            last -= 1;
        if (space ? SENTENCE_ENDS.has(text[last]) : FULL_STOPS.has(text[last]))
            return proseCut(i, skipSpaces(i)[0]);
        return undefined;
    };
    const cutAtSpace = (i) => {
        if (!isBreakSpace(text.charCodeAt(i)) || isBreakSpace(text.charCodeAt(i - 1)))
            return undefined;
        return proseCut(i, skipSpaces(i)[0]);
    };
    const cutsInOrder = [cutAtParagraph, cutAtLine, cutAtSentence, cutAtSpace];
    // The latest cut of each kind in turn whose part is at least half full, else
    // the latest of each kind at all, else a cut between two characters.
    const chooseCut = (start, limit, prefix) => {
        const half = start + Math.ceil((limit - start) / 2);
        for (const least of [half, start + 1]) {
            for (const cutAt of cutsInOrder) {
                for (let i = limit; i > start; i -= 1) {
                    const cut = cutAt(i, start);
                    if (!cut)
                        continue;
                    if (cut.end < least)
                        break;
                    if (cut.end <= limit && partFits(start, prefix, cut))
                        return cut;
                }
            }
        }
        return cutInsideWord(start, limit, prefix);
    };
    const cutInsideWord = (start, limit, prefix) => {
        const cutAt = (at) => {
            if (insidePair[at])
                return undefined;
            const fence = fenceAround(at);
            const cut = !fence ? { end: at, next: at } : insideCode(fence, at) ? { end: at, next: at, open: fence } : undefined;
            return cut && partFits(start, prefix, cut) ? cut : undefined;
        };
        if (GRAPHEMES) {
            let last;
            // Text past the limit too, so that a cluster running across it is not taken as ending there.
            for (const { index } of GRAPHEMES.segment(text.slice(start, Math.min(n, limit + 32)))) {
                if (start + index > limit)
                    break;
                if (index > 0)
                    last = cutAt(start + index) ?? last;
            }
            if (last)
                return last;
        }
        // One grapheme cluster longer than a part: cut it between code points.
        for (let at = limit; at > start; at -= 1) {
            const cut = cutAt(at);
            if (cut)
                return cut;
        }
        // Only a fence line longer than a part leaves no other place.
        for (let at = limit; at > start; at -= 1)
            if (!insidePair[at])
                return { end: at, next: at };
        throw new Error("Octopus Prime reply part limits leave no room for any text");
    };
    // The furthest end for a part from `start` that fits with `prefix`.
    const furthest = (start, prefix) => {
        let low = start;
        let high = n;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(start, middle, prefix))
                low = middle;
            else
                high = middle - 1;
        }
        return low;
    };
    const parts = [];
    let start = from;
    let reopen;
    const around = from > 0 ? fenceAround(from) : undefined;
    if (around && from < around.body) {
        start = around.body;
        reopen = around;
    }
    else if (around && from < around.close) {
        reopen = around;
    }
    else if (around) {
        start = around.closeEnd;
    }
    if (from > 0 && !reopen)
        start = skipSpaces(start)[0];
    while (start < n) {
        const prefix = reopen ? reopen.reopen : "";
        const prefixCost = costOf(prefix);
        const limit = furthest(start, prefixCost);
        if (limit >= n) {
            parts.push(prefix + text.slice(start));
            break;
        }
        const cut = chooseCut(start, limit, prefixCost);
        parts.push(prefix + text.slice(start, cut.end) + closing(cut));
        start = cut.next;
        reopen = cut.open;
    }
    return parts;
}
function findFences(text, fitsAlone) {
    const fences = [];
    let opened;
    const add = (close, closeEnd) => {
        if (!opened)
            return;
        fences.push({
            open: opened.open,
            body: opened.body,
            close,
            closeEnd,
            reopen: text.slice(opened.open, opened.body),
            closeLine: opened.indent + opened.run,
            oversized: !fitsAlone(opened.open, closeEnd),
        });
        opened = undefined;
    };
    for (let lineStart = 0; lineStart < text.length;) {
        const lineBreak = text.indexOf("\n", lineStart);
        const lineEnd = lineBreak === -1 ? text.length : lineBreak;
        const next = lineBreak === -1 ? text.length : lineBreak + 1;
        const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
        if (!opened) {
            const match = FENCE_OPEN.exec(line);
            // A backtick fence's info string has no backtick.
            if (match && !(match[2][0] === "`" && match[3].includes("`"))) {
                opened = { open: lineStart, body: next, indent: match[1], run: match[2] };
            }
        }
        else {
            const match = FENCE_CLOSE.exec(line);
            if (match && match[1][0] === opened.run[0] && match[1].length >= opened.run.length) {
                add(lineStart, lineStart + line.trimEnd().length);
            }
        }
        lineStart = next;
    }
    // A block never closed runs to the end of the reply.
    add(text.length, text.length);
    return fences;
}
