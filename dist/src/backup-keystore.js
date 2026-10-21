import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
/**
 * Where a Gateway's backup data key (DK) lives on its computer (1.38.0,
 * docs/AGENT-BACKUP.md §4): the operating system's own keychain, so scheduled
 * backups run without the passphrase. macOS Keychain (`security`), Linux
 * Secret Service (`secret-tool`), Windows DPAPI for the current user
 * (PowerShell). The key never goes on a command line: each tool gets it on its
 * standard input. No keychain, no backups on that computer: there is no plain
 * file fallback (systemKeystore answers null and setup refuses).
 *
 * The OS tools can't run in the plugin's tests; the tests check the commands
 * and the standard input given to an injected spawn.
 */
export const KEYCHAIN_SERVICE = "octopus-prime-backup";
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const COMMAND_TIMEOUT_MS = 30_000;
/**
 * The keychain could not keep or give the key: a named reason in plain words
 * that says which keychain and what to do, never the tool's own output (which
 * could carry anything) and never a key.
 */
export class KeychainError extends Error {
    constructor(message) {
        super(message);
        this.name = "KeychainError";
    }
}
function checkName(name) {
    if (!NAME.test(name))
        throw new Error("A backup key's name is a connector id");
    return name;
}
function checkKey(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
        throw new Error("A backup data key is 32 bytes");
    return key.toString("hex");
}
// The key is the one line of output that is 64 hex digits, alone or after
// `security -i`'s prompt on the same line. Anything else is no key (never an
// empty one).
const KEY_LINE = /^(?:security>\s*)?([0-9a-f]{64})$/;
function keyFrom(output) {
    for (const part of output.split(/\r?\n/)) {
        const match = KEY_LINE.exec(part.trim());
        if (match)
            return Buffer.from(match[1], "hex");
    }
    return null;
}
/**
 * Runs one OS tool and turns a tool that is missing, can't be run or never
 * answers into a KeychainError that names the keychain and the tool.
 */
async function ask(kind, tool, run) {
    try {
        return await run();
    }
    catch (error) {
        const code = error?.code;
        if (code === "ENOENT")
            throw new KeychainError(`The ${kind} can't be used: ${tool} is not installed on this computer`);
        if (code === "ETIMEDOUT") {
            throw new KeychainError(`The ${kind} did not answer (${tool} was stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds); it may be waiting for you to unlock it`);
        }
        throw new KeychainError(`The ${kind} can't be used: ${tool} could not be run${typeof code === "string" ? ` (${code})` : ""}`);
    }
}
// Exit codes and words of a keychain that is locked, or where the owner said no
// (macOS: errSecInteractionNotAllowed 36, errSecAuthFailed 51, user cancelled 128).
const REFUSED_CODES = new Set([36, 51, 128]);
const REFUSED_WORDS = /interaction is not allowed|locked|unlock|cancel|denied|dismissed|not allowed|authori[sz]|d-bus|dbus|not valid for use/i;
/** What a tool's failure means, without repeating its output. */
function failed(kind, did, result) {
    if (REFUSED_CODES.has(result.code) || REFUSED_WORDS.test(result.stderr)) {
        return new KeychainError(`The ${kind} is locked or refused access, so it did not ${did} the backup key (exit code ${result.code}); unlock it and run this again`);
    }
    return new KeychainError(`The ${kind} did not ${did} the backup key (exit code ${result.code})`);
}
/** For tests, and for nothing else: a keystore that forgets when the process ends. */
export function memoryKeystore() {
    const keys = new Map();
    return {
        kind: "memory",
        async get(name) { const key = keys.get(checkName(name)); return key ? Buffer.from(key) : null; },
        async set(name, key) { checkKey(key); keys.set(checkName(name), Buffer.from(key)); },
        async delete(name) { keys.delete(checkName(name)); },
    };
}
export const defaultSpawner = (command, args, input) => new Promise((resolve, reject) => {
    const child = nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut)
            reject(Object.assign(new Error(`${command} did not answer`), { code: "ETIMEDOUT" }));
        else
            resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => { });
    child.stdin.end(input);
});
// A double-quoted argument for `security -i`'s own command line (read from
// standard input, never the process's argv). Names are connector ids and keys
// are hex, so nothing here needs more than the quotes.
const quoted = (value) => `"${value.replace(/["\\]/g, "\\$&")}"`;
/**
 * macOS: `/usr/bin/security -i` (interactive mode) reads its commands from
 * standard input, so the key is never in any process's argv:
 * add-generic-password -U -s octopus-prime-backup -a <connector id> -w <hex>,
 * find-generic-password -s … -a … -w (prints the password), and
 * delete-generic-password -s … -a ….
 */
export function macKeystore(spawn = defaultSpawner) {
    const kind = "macOS Keychain";
    const run = (line) => ask(kind, "security", () => spawn("/usr/bin/security", ["-i"], `${line}\n`));
    const account = (name) => `-s ${quoted(KEYCHAIN_SERVICE)} -a ${quoted(checkName(name))}`;
    return {
        kind,
        async get(name) {
            const result = await run(`find-generic-password ${account(name)} -w`);
            if (result.code === 0)
                return keyFrom(result.stdout);
            // 44 is errSecItemNotFound, the one failure that means "no key stored".
            if (result.code === 44)
                return null;
            throw failed(kind, "give", result);
        },
        async set(name, key) {
            const result = await run(`add-generic-password -U ${account(name)} -w ${quoted(checkKey(key))}`);
            if (result.code !== 0)
                throw failed(kind, "keep", result);
        },
        async delete(name) {
            await run(`delete-generic-password ${account(name)}`);
        },
    };
}
/**
 * Linux: `secret-tool` (libsecret, the Secret Service). `store` reads the
 * secret from standard input; `lookup` prints it; `clear` removes it.
 */
export function linuxKeystore(spawn = defaultSpawner) {
    const kind = "Secret Service";
    const run = (args, input) => ask(kind, "secret-tool", () => spawn("secret-tool", args, input));
    const attributes = (name) => ["service", KEYCHAIN_SERVICE, "account", checkName(name)];
    return {
        kind,
        async get(name) {
            const result = await run(["lookup", ...attributes(name)], "");
            if (result.code === 0)
                return keyFrom(result.stdout);
            // Not found is a silent exit 1; a service that is locked, missing or not running says why.
            if (result.stderr.trim() === "")
                return null;
            throw failed(kind, "give", result);
        },
        async set(name, key) {
            const result = await run(["store", "--label=Octopus Prime backup key", ...attributes(name)], checkKey(key));
            if (result.code !== 0)
                throw failed(kind, "keep", result);
        },
        async delete(name) {
            await run(["clear", ...attributes(name)], "");
        },
    };
}
// PowerShell scripts with no secret in them (Windows PowerShell 5.1 and 7):
// each reads its one input, base64, from standard input, and prints its one
// output (the protected blob as base64, or the key as hex).
const DPAPI_PROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
    + "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); "
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const DPAPI_UNPROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
    + "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); "
    + "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); "
    + "-join ($k | ForEach-Object { $_.ToString('x2') })";
/**
 * Windows: DPAPI for the current user through PowerShell. The protected blob
 * (only this Windows user can open it) is kept in a file under the state dir;
 * the key goes in and comes out through standard input and output.
 */
export function windowsKeystore(dir, spawn = defaultSpawner) {
    const file = (name) => path.join(dir, `${checkName(name)}.dpapi`);
    const kind = "Windows DPAPI";
    const shell = (script, input) => ask(kind, "powershell", () => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input));
    return {
        kind,
        async get(name) {
            let blob;
            try {
                blob = (await readFile(file(name), "utf8")).trim();
            }
            catch {
                return null;
            }
            const result = await shell(DPAPI_UNPROTECT, blob);
            if (result.code === 0)
                return keyFrom(result.stdout);
            throw failed(kind, "open", result);
        },
        async set(name, key) {
            const result = await shell(DPAPI_PROTECT, Buffer.from(checkKey(key), "hex").toString("base64"));
            const blob = result.stdout.trim();
            if (result.code !== 0)
                throw failed(kind, "protect", result);
            if (!/^[A-Za-z0-9+/=]+$/.test(blob))
                throw new KeychainError(`The ${kind} did not protect the backup key (it gave no protected copy)`);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const temporary = `${file(name)}.tmp`;
            await writeFile(temporary, `${blob}\n`, { mode: 0o600 });
            await rename(temporary, file(name));
            await chmod(file(name), 0o600).catch(() => { });
        },
        async delete(name) {
            await rm(file(name), { force: true });
        },
    };
}
/**
 * This computer's keychain, or null where there is none this plugin uses:
 * then backups can't be switched on here (fail closed, never a plain file).
 * `dir` is where Windows keeps its DPAPI blobs (under the state dir).
 */
export function systemKeystore(platform, options) {
    if (platform === "darwin")
        return macKeystore(options.spawn);
    if (platform === "linux")
        return linuxKeystore(options.spawn);
    if (platform === "win32")
        return windowsKeystore(options.dir, options.spawn);
    return null;
}
