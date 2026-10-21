/**
 * An agent's rich reply (1.32.0): OpenClaw's message presentation (a card with
 * a title and a tone, text, context lines, dividers, tables and charts), in
 * the shape the Octopus Prime backend keeps next to the reply's words
 * (`presentation` on message.outbound and message.post).
 *
 * The rules are the backend's, word for word, as the Octopus Prime apps read
 * them too: a card that breaks any one of them is not sent at all, and the
 * reply goes as its words alone, which say everything the card shows. Only
 * the size cap differs: the plugin's 16,000 bytes are a little under the
 * backend's 16,384, so nothing it sends is refused for its size. Buttons and
 * selects are not part of it yet: the channel tells core it has none, so core
 * turns them into context lines before the card gets here.
 */
import { renderMessagePresentationFallbackText } from "openclaw/plugin-sdk/interactive-runtime";
/** Where a rendered card rides in a payload's channelData, to message.send.payload. */
export const CHANNEL_DATA_KEY = "octopus-prime";
export const PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"];
export const CHART_SERIES = ["bar", "line", "area"];
export const PRESENTATION_LIMITS = Object.freeze({
    blocks: 40,
    title: 200,
    text: 8000,
    caption: 200,
    headers: 12,
    header: 100,
    rows: 100,
    cell: 500,
    segments: 24,
    label: 100,
    categories: 60,
    series: 8,
    bytes: 16000,
});
const L = PRESENTATION_LIMITS;
// Control characters other than tab (9), line feed (10) and carriage return (13).
// And lone surrogates (a JSON "\ud800" escape), which no UTF-8 text can hold.
// (Exported, with the checks below, for tap-to-answer's own rules, 1.33.0, src/questions.ts.)
export const control = (code) => (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    || (code >= 0xd800 && code < 0xe000);
// What counts as blank, by code point, spelled out as the backend spells it.
export const BLANK = new Set([9, 10, 13, 32, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a]);
export class Invalid extends Error {
}
export function fail() {
    throw new Invalid();
}
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A field that is there, null counting as absent.
export const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && object[key] !== null && object[key] !== undefined;
export const codePoints = (value) => [...value].map((char) => char.codePointAt(0));
// Words with nothing but blanks (or nothing at all).
export function blank(value) {
    return codePoints(value).every((code) => BLANK.has(code));
}
// A required string: some non-blank content, at most `limit` code points, no
// control character but tab, line feed and carriage return. Kept verbatim.
export function text(value, limit) {
    if (typeof value !== "string")
        fail();
    const codes = codePoints(value);
    if (codes.length > limit || codes.every((code) => BLANK.has(code)) || codes.some(control))
        fail();
    return value;
}
// A finite number the apps hold exactly when whole; never a boolean.
function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        fail();
    if (Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER)
        fail();
    return value;
}
// A list of `least` to `most` entries.
export function list(value, least, most) {
    if (!Array.isArray(value) || value.length < least || value.length > most)
        fail();
    return value;
}
// The same values, none twice.
export function unique(values) {
    if (new Set(values).size !== values.length)
        fail();
    return values;
}
// A table: its caption, its headers and rows of exactly as many cells.
function table(block) {
    const headers = unique(list(block.headers, 1, L.headers).map((header) => text(header, L.header)));
    const rows = list(block.rows, 1, L.rows).map((row) => {
        if (!Array.isArray(row) || row.length !== headers.length)
            fail();
        return row.map((cell) => (typeof cell === "string" ? text(cell, L.cell) : number(cell)));
    });
    const kept = { type: "table", caption: text(block.caption, L.caption), headers, rows };
    if (has(block, "rowHeaderColumnIndex")) {
        const index = block.rowHeaderColumnIndex;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= headers.length)
            fail();
        kept.rowHeaderColumnIndex = index;
    }
    return kept;
}
// A pie chart's segments, or a bar, line or area chart's categories and series.
function chart(block) {
    const kind = block.chartType;
    const title = text(block.title, L.title);
    if (kind === "pie") {
        const segments = list(block.segments, 1, L.segments).map((segment) => {
            if (!isObject(segment))
                fail();
            const value = number(segment.value);
            if (!(value > 0))
                fail();
            return { label: text(segment.label, L.label), value };
        });
        unique(segments.map((segment) => segment.label));
        return { type: "chart", chartType: "pie", title, segments };
    }
    if (typeof kind !== "string" || !CHART_SERIES.includes(kind))
        fail();
    const categories = unique(list(block.categories, 1, L.categories).map((category) => text(category, L.label)));
    const series = list(block.series, 1, L.series).map((line) => {
        if (!isObject(line))
            fail();
        const values = list(line.values, categories.length, categories.length).map(number);
        return { name: text(line.name, L.label), values };
    });
    unique(series.map((line) => line.name));
    const kept = { type: "chart", chartType: kind, title, categories, series };
    for (const axis of ["xLabel", "yLabel"]) {
        if (has(block, axis))
            kept[axis] = text(block[axis], L.label);
    }
    return kept;
}
// One block of a known type; any other type makes the whole card invalid.
function block(raw) {
    if (!isObject(raw))
        fail();
    if (raw.type === "text" || raw.type === "context")
        return { type: raw.type, text: text(raw.text, L.text) };
    if (raw.type === "divider")
        return { type: "divider" };
    if (raw.type === "table")
        return table(raw);
    if (raw.type === "chart")
        return chart(raw);
    return fail();
}
/**
 * A card's size written compactly (as it goes in the frame), in UTF-8 bytes,
 * counted by code point as the backend and the apps count it.
 */
export function presentationSize(presentation) {
    let bytes = 0;
    for (const char of JSON.stringify(presentation)) {
        const code = char.codePointAt(0);
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}
/**
 * The card as the backend keeps it, or undefined when it breaks any rule (it
 * is then never sent). Unknown keys are dropped; strings are kept verbatim.
 */
export function presentationOf(raw) {
    try {
        if (!isObject(raw))
            fail();
        const kept = {};
        if (has(raw, "title"))
            kept.title = text(raw.title, L.title);
        if (has(raw, "tone")) {
            if (typeof raw.tone !== "string" || !PRESENTATION_TONES.includes(raw.tone))
                fail();
            kept.tone = raw.tone;
        }
        kept.blocks = list(raw.blocks, 1, L.blocks).map(block);
        if (presentationSize(kept) > L.bytes)
            fail();
        return kept;
    }
    catch (error) {
        if (error instanceof Invalid)
            return undefined;
        throw error;
    }
}
/**
 * A reply rendered for Octopus Prime (the outbound adapter's renderPresentation):
 * its text becomes the full plain-text equivalent, OpenClaw's own fallback of
 * the words and the original card, so search, read aloud, pushes and older
 * apps keep working from the words; and the card, as the backend keeps it,
 * goes in `channelData["octopus-prime"].presentation`, which takes the reply
 * to message.send.payload. The reply's own words, unless blank or the card's
 * title, become the card's first text block, since the apps show the card
 * instead of the words. Null for a card the backend would refuse: core then
 * sends its own plain text.
 */
export function presentationReply(params) {
    const { payload, presentation } = params;
    const words = typeof payload.text === "string" && !blank(payload.text) && payload.text !== presentation.title
        ? payload.text
        : undefined;
    const blocks = presentation.blocks;
    const card = presentationOf({
        ...presentation,
        blocks: Array.isArray(blocks) && words !== undefined ? [{ type: "text", text: words }, ...blocks] : blocks,
    });
    if (!card)
        return null;
    const { presentation: _presentation, presentationTextMode: _mode, ...rest } = payload;
    return {
        ...rest,
        text: renderMessagePresentationFallbackText({ text: payload.text, presentation: params.sourcePresentation ?? presentation }),
        channelData: { ...(isObject(payload.channelData) ? payload.channelData : {}), [CHANNEL_DATA_KEY]: { presentation: card } },
    };
}
/** The card a payload's channelData carries for Octopus Prime, checked again, or undefined. */
export function channelDataPresentation(channelData) {
    const own = isObject(channelData) ? channelData[CHANNEL_DATA_KEY] : undefined;
    return isObject(own) && own.presentation !== undefined ? presentationOf(own.presentation) : undefined;
}
