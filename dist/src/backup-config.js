const OCTOPUS_CHANNEL = "octopus-prime";
const OCTOPUS_SECRET_FIELDS = new Set(["connectorToken", "setupCode"]);
// -- a small JSON5 reader ---------------------------------------------------------------
class Json5Reader {
    text;
    at = 0;
    constructor(text) {
        this.text = text;
    }
    read() {
        const value = this.value();
        this.space();
        if (this.at !== this.text.length)
            this.fail();
        return value;
    }
    fail() {
        throw new SyntaxError(`openclaw.json can't be read at character ${this.at}`);
    }
    space() {
        for (;;) {
            const char = this.text[this.at];
            if (char === undefined)
                return;
            if (/\s/.test(char) || char === "﻿") {
                this.at += 1;
                continue;
            }
            if (char === "/" && this.text[this.at + 1] === "/") {
                while (this.at < this.text.length && this.text[this.at] !== "\n")
                    this.at += 1;
                continue;
            }
            if (char === "/" && this.text[this.at + 1] === "*") {
                const end = this.text.indexOf("*/", this.at + 2);
                if (end === -1)
                    this.fail();
                this.at = end + 2;
                continue;
            }
            return;
        }
    }
    value() {
        this.space();
        const char = this.text[this.at];
        if (char === "{")
            return this.object();
        if (char === "[")
            return this.array();
        if (char === "\"" || char === "'")
            return this.string();
        if (char !== undefined && /[-+.0-9]/.test(char))
            return this.number();
        for (const [word, value] of [["true", true], ["false", false], ["null", null]]) {
            if (this.text.startsWith(word, this.at) && !/[\w$]/.test(this.text[this.at + word.length] ?? "")) {
                this.at += word.length;
                return value;
            }
        }
        return this.fail();
    }
    object() {
        this.at += 1;
        const out = {};
        for (;;) {
            this.space();
            if (this.text[this.at] === "}") {
                this.at += 1;
                return out;
            }
            const key = this.key();
            this.space();
            if (this.text[this.at] !== ":")
                this.fail();
            this.at += 1;
            // Not a prototype key: own data only.
            Object.defineProperty(out, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
            this.space();
            if (this.text[this.at] === ",") {
                this.at += 1;
                continue;
            }
            if (this.text[this.at] === "}") {
                this.at += 1;
                return out;
            }
            this.fail();
        }
    }
    key() {
        const char = this.text[this.at];
        if (char === "\"" || char === "'")
            return this.string();
        const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.at, this.at + 256));
        if (!match)
            this.fail();
        this.at += match[0].length;
        return match[0];
    }
    array() {
        this.at += 1;
        const out = [];
        for (;;) {
            this.space();
            if (this.text[this.at] === "]") {
                this.at += 1;
                return out;
            }
            out.push(this.value());
            this.space();
            if (this.text[this.at] === ",") {
                this.at += 1;
                continue;
            }
            if (this.text[this.at] === "]") {
                this.at += 1;
                return out;
            }
            this.fail();
        }
    }
    string() {
        const quote = this.text[this.at];
        this.at += 1;
        let out = "";
        for (;;) {
            const char = this.text[this.at];
            if (char === undefined || char === "\n" || char === "\r")
                this.fail();
            this.at += 1;
            if (char === quote)
                return out;
            if (char !== "\\") {
                out += char;
                continue;
            }
            const escape = this.text[this.at];
            this.at += 1;
            switch (escape) {
                case "n":
                    out += "\n";
                    break;
                case "t":
                    out += "\t";
                    break;
                case "r":
                    out += "\r";
                    break;
                case "b":
                    out += "\b";
                    break;
                case "f":
                    out += "\f";
                    break;
                case "v":
                    out += "\v";
                    break;
                case "0":
                    out += "\0";
                    break;
                case "\n": break;
                case "\r":
                    if (this.text[this.at] === "\n")
                        this.at += 1;
                    break;
                case "x": {
                    const hex = this.text.slice(this.at, this.at + 2);
                    if (!/^[0-9a-fA-F]{2}$/.test(hex))
                        this.fail();
                    out += String.fromCharCode(parseInt(hex, 16));
                    this.at += 2;
                    break;
                }
                case "u": {
                    const hex = this.text.slice(this.at, this.at + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex))
                        this.fail();
                    out += String.fromCharCode(parseInt(hex, 16));
                    this.at += 4;
                    break;
                }
                case undefined:
                    this.fail();
                    break;
                default: out += escape;
            }
        }
    }
    number() {
        const match = /^[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(this.text.slice(this.at, this.at + 64));
        if (!match)
            this.fail();
        this.at += match[0].length;
        const text = match[0];
        const sign = text.startsWith("-") ? -1 : 1;
        const body = text.replace(/^[-+]/, "");
        const value = /^0[xX]/.test(body) ? sign * parseInt(body.slice(2), 16) : Number(text);
        if (!Number.isFinite(value))
            this.fail();
        return value;
    }
}
/** openclaw.json's value, or null when it can't be parsed (then it is skipped, never copied raw). */
export function parseConfigText(text) {
    try {
        return new Json5Reader(text).read();
    }
    catch {
        return null;
    }
}
// -- redaction -----------------------------------------------------------------------
const SECRET_KEY = new RegExp([
    "api[_-]?key", "apikey", "token", "secret", "passw(?:or)?d", "passphrase", "credential", "private[_-]?key",
    "privatekey", "cookie", "setup[_-]?code", "auth[_-]?header", "authorization", "bearer", "access[_-]?key",
    "session[_-]?key", "signing[_-]?key", "client[_-]?secret", "webhook[_-]?url",
].join("|"), "i");
const SECRET_EXACT = /^(?:key|pass|pwd|pin|otp|totp|salt|signature)$/i;
// Names that mention tokens but count them, not hold them.
const NOT_SECRET = /(?:max|min|context|output|input|reserve|reserved|budget|limit|count|num|total|thinking|prompt|completion)[_-]?tokens?$|^tokens?[_-]?(?:limit|count|budget|per\w*)$|tokeniz/i;
const PLACEHOLDER = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const SECRET_REF_SOURCES = new Set(["env", "file", "exec", "store"]);
export function isSecretKey(name) {
    return (SECRET_KEY.test(name) || SECRET_EXACT.test(name)) && !NOT_SECRET.test(name);
}
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function isSecretRef(value) {
    return isObject(value) && typeof value.source === "string" && SECRET_REF_SOURCES.has(value.source)
        && typeof value.provider === "string" && typeof value.id === "string"
        && Object.keys(value).every((key) => key === "source" || key === "provider" || key === "id");
}
/** A URL with its user name and password removed, and secret-looking query values too; other text as it was. */
export function strippedUrl(text) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
        return text;
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return text;
    }
    let changed = false;
    if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
    }
    for (const name of [...url.searchParams.keys()]) {
        if (isSecretKey(name) || /^(?:key|sig|code)$/i.test(name)) {
            url.searchParams.set(name, "");
            changed = true;
        }
    }
    return changed ? url.toString() : text;
}
const join = (path) => path.join(".");
/** The config as a backup keeps it, and the dotted paths of what was removed. */
export function redactConfig(config) {
    const redacted = [];
    const walk = (value, path, underSecret) => {
        if (Array.isArray(value)) {
            const out = [];
            value.forEach((item, index) => {
                const kept = walk(item, [...path, String(index)], underSecret);
                // An array keeps its shape: a removed item becomes null.
                out.push(kept === undefined ? null : kept);
            });
            return out;
        }
        if (isObject(value)) {
            if (underSecret && isSecretRef(value))
                return { ...value };
            const out = {};
            for (const [key, item] of Object.entries(value)) {
                const kept = walk(item, [...path, key], underSecret || isSecretKey(key));
                if (kept !== undefined)
                    Object.defineProperty(out, key, { value: kept, enumerable: true, writable: true, configurable: true });
            }
            return out;
        }
        if (typeof value === "string") {
            if (PLACEHOLDER.test(value))
                return value;
            if (underSecret) {
                redacted.push(join(path));
                return undefined;
            }
            return strippedUrl(value);
        }
        if (typeof value === "number" && underSecret) {
            redacted.push(join(path));
            return undefined;
        }
        return value;
    };
    const out = walk(config, [], false) ?? null;
    // This plugin's own credential and setup code: always removed.
    const channel = isObject(out) && isObject(out.channels) ? out.channels[OCTOPUS_CHANNEL] : undefined;
    if (isObject(channel)) {
        const strip = (section, path) => {
            for (const field of OCTOPUS_SECRET_FIELDS) {
                if (field in section) {
                    delete section[field];
                    const name = join([...path, field]);
                    if (!redacted.includes(name))
                        redacted.push(name);
                }
            }
        };
        strip(channel, ["channels", OCTOPUS_CHANNEL]);
        if (isObject(channel.accounts)) {
            for (const [id, account] of Object.entries(channel.accounts)) {
                if (isObject(account))
                    strip(account, ["channels", OCTOPUS_CHANNEL, "accounts", id]);
            }
        }
    }
    return { config: out, redacted };
}
// -- restore -----------------------------------------------------------------------------
/**
 * The restored config merged into this computer's: `current` wins for
 * channels["octopus-prime"] (this computer's pairing; the backup's is never
 * taken, even when this computer has none) and for every redacted path;
 * otherwise restored values fill in, objects merged key by key.
 */
export function mergeConfig(current, restored, redacted) {
    const keepCurrent = new Set(redacted);
    const merge = (here, there, path) => {
        const name = join(path);
        if (name === `channels.${OCTOPUS_CHANNEL}`)
            return here;
        if (keepCurrent.has(name))
            return here;
        if (isObject(there) && (here === undefined || isObject(here))) {
            // Walked even when this computer has nothing there, so a kept path is never taken from the backup.
            const mine = here ?? {};
            const out = {};
            for (const key of new Set([...Object.keys(mine), ...Object.keys(there)])) {
                const value = merge(mine[key], there[key], [...path, key]);
                if (value !== undefined)
                    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
            }
            return out;
        }
        if (there === undefined)
            return here;
        if (Array.isArray(there) && Array.isArray(here) && path.length > 0) {
            // An array with a redacted item (kept as null) keeps this computer's value there.
            return there.map((item, index) => (item === null && keepCurrent.has(join([...path, String(index)])) ? here[index] ?? null : item));
        }
        return there;
    };
    return merge(current ?? {}, restored, []) ?? {};
}
