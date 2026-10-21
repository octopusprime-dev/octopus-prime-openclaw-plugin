import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { accountSection, listConnectorAccountIds, normalizeAccountId } from "./accounts.js";
import { BackupRefusedError, getObject, KEYS_FRAME, postBackupFrame, putObject, refusalMessage, SETUP_FRAME, sizeText, STATUS_FRAME, statusOf, } from "./backup.js";
import { BackupKeyError, buildEnvelope, checkedEnvelope, confirmsLastGroup, formatRecoveryKey, newDataKey, newRecoveryKey, openEnvelopeWithTyped, passphraseProblem, rewrapEnvelope, } from "./backup-crypto.js";
import { estimateBackup, estimateText, listMachines, listPoints, restoreBackup, RestoreConflictError, runBackup, } from "./backup-engine.js";
import { computerKeystore, keystoreHolds, placeFromConfig } from "./backup-gateway.js";
import { resolvePinnedRuntimeConfig } from "./runtime-config.js";
export const BACKUP_COMMANDS = ["setup", "status", "now", "estimate", "restore", "passphrase"];
class CliStop extends Error {
}
function account(env, requested) {
    const ids = listConnectorAccountIds(env.config);
    const id = requested ? normalizeAccountId(requested) : ids.length === 1 ? ids[0] : ids.includes("default") ? "default" : undefined;
    if (!id || !ids.includes(id)) {
        throw new CliStop(`Choose the Octopus Prime account with --account <id> (this Gateway has: ${ids.join(", ") || "none"}).`);
    }
    const section = accountSection(env.config, id);
    if (section.connectorToken !== undefined && typeof section.connectorToken !== "string") {
        throw new CliStop("This account's connector credential is kept as a secret reference, which this command can't read yet. "
            + "Run the backup commands from a Gateway whose credential is in openclaw.json.");
    }
    let binding;
    try {
        binding = resolvePinnedRuntimeConfig(section);
    }
    catch {
        throw new CliStop("This Gateway isn't connected to Octopus Prime for that account yet. Pair it first (openclaw channels add).");
    }
    const call = (frame) => postBackupFrame({
        fetch: env.fetch, backendUrl: binding.backendUrl, connectorToken: binding.connectorToken, frame,
    });
    return { accountId: id, connectorId: binding.connectorId, call, fetch: env.fetch };
}
async function newPassphrase(io) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const first = await io.ask("Choose a backup passphrase (at least 12 characters): ", { hidden: true });
        const problem = passphraseProblem(first);
        if (problem) {
            io.error(problem);
            continue;
        }
        const second = await io.ask("Type it again: ", { hidden: true });
        if (first !== second) {
            io.error("The two passphrases are not the same.");
            continue;
        }
        return first;
    }
    throw new CliStop("No passphrase was chosen; nothing was changed.");
}
/** Shows a new recovery key once, saves it where asked, and has the owner type its last group back. */
async function showRecoveryKey(io, formatted, file) {
    io.print("");
    io.print("Your recovery key (shown once):");
    io.print("");
    io.print(`    ${formatted}`);
    io.print("");
    io.print("Save or print it now and keep it somewhere safe, away from this computer. Your passphrase or this key");
    io.print("restores the backup on a new computer. If you lose both, nobody can restore it, not even Octopus Prime.");
    if (file) {
        try {
            await writeFile(path.resolve(file), `${formatted}\n`, { mode: 0o600, flag: "wx" });
            io.print(`Saved to ${path.resolve(file)} (readable by you only). Move it somewhere safe.`);
        }
        catch {
            throw new CliStop("The recovery key could not be saved to that file (it may already exist); nothing was changed.");
        }
    }
    io.print("");
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const typed = await io.ask("To confirm you saved it, type its last group (the 4 characters after the last dash): ");
        if (confirmsLastGroup(formatted, typed))
            return;
        io.error("That isn't the recovery key's last group.");
    }
    throw new CliStop("The recovery key wasn't confirmed; nothing was changed.");
}
async function statusCommand(env, acct) {
    const status = statusOf(await acct.call({ type: STATUS_FRAME }));
    const { io } = env;
    if (!status.plan) {
        io.print(refusalMessage("no_plan"));
        return 0;
    }
    io.print(`Plan: ${status.plan.name}.`);
    io.print(`Backups: ${status.enabled ? "on" : "off"}${status.enabled && !status.set_up ? ", not set up yet" : ""}.`);
    io.print(`Last backup: ${status.last_backup_at ?? "none yet"}.`);
    io.print(`Stored: ${sizeText(status.stored_bytes)} of ${sizeText(status.storage_bytes)}.`);
    if (status.set_up && status.key_id) {
        const store = env.keystore();
        io.print(!store ? "This computer has no keychain the plugin can use."
            : await keystoreHolds(store, acct.connectorId, status.key_id)
                ? `This computer's ${store.kind} holds the backup key.`
                : "This computer's keychain doesn't hold the backup key: run `openclaw octopus-prime backup setup` here.");
    }
    return 0;
}
async function setupCommand(env, acct, options) {
    const { io } = env;
    const status = statusOf(await acct.call({ type: STATUS_FRAME }));
    if (!status.plan)
        throw new CliStop(refusalMessage("no_plan"));
    if (!status.enabled)
        throw new CliStop(refusalMessage("not_enabled"));
    const store = env.keystore();
    if (!store) {
        throw new CliStop("This computer has no keychain the plugin can use (macOS Keychain, the Linux Secret Service or "
            + "Windows DPAPI), so backups can't be set up here. The key is never kept in a plain file.");
    }
    if (status.set_up && status.key_id) {
        if (await keystoreHolds(store, acct.connectorId, status.key_id)) {
            io.print("Agent Backup is already set up on this computer. To change the passphrase: openclaw octopus-prime backup passphrase");
            return 0;
        }
        io.print("Backups for this Gateway were set up before. Type the passphrase or the recovery key to keep its key on this computer.");
        const envelope = (await acct.call({ type: KEYS_FRAME, connector_id: acct.connectorId })).keys;
        const dk = await openEnvelopeWithTyped(envelope, await io.ask("Passphrase or recovery key: ", { hidden: true }));
        await store.set(acct.connectorId, dk);
        if (!await keystoreHolds(store, acct.connectorId, status.key_id))
            throw new CliStop(`The ${store.kind} did not keep the backup key.`);
        io.print(`The backup key is in this computer's ${store.kind}. Backups run on schedule while the Gateway runs.`);
        return 0;
    }
    io.print("Agent Backup encrypts this Gateway's files on this computer before they leave. You need a passphrase");
    io.print("and a recovery key to restore them; Octopus Prime never receives either.");
    const passphrase = await newPassphrase(io);
    const dk = newDataKey();
    const recoveryKey = newRecoveryKey();
    await showRecoveryKey(io, formatRecoveryKey(recoveryKey), options.recoveryKeyFile);
    io.print("Sealing the key (this takes a moment)…");
    const envelope = await buildEnvelope(dk, passphrase, recoveryKey, { n: env.scryptN });
    await store.set(acct.connectorId, dk);
    if (!await keystoreHolds(store, acct.connectorId, envelope.key_id))
        throw new CliStop(`The ${store.kind} did not keep the backup key.`);
    try {
        await acct.call({ type: SETUP_FRAME, keys: envelope });
    }
    catch (error) {
        await store.delete(acct.connectorId).catch(() => { });
        throw error;
    }
    io.print(`Agent Backup is set up. The key is in this computer's ${store.kind}; the first backup runs within about`);
    io.print("10 minutes while the Gateway runs, or now with: openclaw octopus-prime backup now");
    return 0;
}
async function passphraseCommand(env, acct, options) {
    const { io } = env;
    const status = statusOf(await acct.call({ type: STATUS_FRAME }));
    if (!status.set_up)
        throw new CliStop(refusalMessage("not_set_up"));
    const envelope = checkedEnvelope((await acct.call({ type: KEYS_FRAME, connector_id: acct.connectorId })).keys);
    const dk = await openEnvelopeWithTyped(envelope, await io.ask("Current passphrase or recovery key: ", { hidden: true }));
    const passphrase = await newPassphrase(io);
    let recoveryKey;
    if (options.newRecoveryKey) {
        recoveryKey = newRecoveryKey();
        await showRecoveryKey(io, formatRecoveryKey(recoveryKey), options.recoveryKeyFile);
    }
    io.print("Sealing the key (this takes a moment)…");
    const next = await rewrapEnvelope(envelope, dk, passphrase, { n: env.scryptN, recoveryKey });
    await acct.call({ type: SETUP_FRAME, keys: next, replace: true });
    const store = env.keystore();
    if (store && !await keystoreHolds(store, acct.connectorId, next.key_id))
        await store.set(acct.connectorId, dk).catch(() => { });
    io.print(recoveryKey ? "The passphrase and the recovery key are changed; the old ones no longer open this backup."
        : "The passphrase is changed; the old one no longer opens this backup. Your recovery key is the same.");
    return 0;
}
async function nowCommand(env, acct) {
    const store = env.keystore();
    if (!store)
        throw new CliStop("This computer has no keychain the plugin can use, so it can't back up.");
    env.io.print("Backing up…");
    const result = await runBackup({
        ...env.place(), connectorId: acct.connectorId, keystore: store, kind: "manual", call: acct.call,
        put: (url, headers, bytes) => putObject(acct.fetch, url, headers, bytes),
        get: (url) => getObject(acct.fetch, url),
        log: { info: () => { }, warn: (message) => env.io.error(message) },
    });
    env.io.print(`Backed up ${result.files.toLocaleString("en-US")} files (${sizeText(result.plain_bytes)}); `
        + `${result.uploaded.toLocaleString("en-US")} new pieces uploaded.`);
    return 0;
}
async function choose(io, items, label, question) {
    items.forEach((item, index) => io.print(`  ${index + 1}. ${label(item, index)}`));
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = (await io.ask(question)).trim();
        const picked = answer === "" ? 1 : Number(answer);
        if (Number.isInteger(picked) && picked >= 1 && picked <= items.length)
            return items[picked - 1];
        io.error(`Type a number from 1 to ${items.length}.`);
    }
    throw new CliStop("Nothing was chosen; nothing was restored.");
}
async function restoreCommand(env, acct, options) {
    const { io } = env;
    const machines = await listMachines(acct.call);
    if (machines.length === 0)
        throw new CliStop("No Gateway of yours in this organization has backups to restore.");
    const machine = options.machine
        ? machines.find((candidate) => candidate.connector_id === options.machine)
        : machines.length === 1 ? machines[0] : await (async () => {
            io.print("Which Gateway's backup?");
            return choose(io, machines, (m) => `${m.name}${m.this ? " (this Gateway)" : ""}${m.removed ? " (removed)" : ""}`
                + ` — last backup ${m.last_backup_at ?? "none"}`, "Number (Enter for 1): ");
        })();
    if (!machine)
        throw new CliStop("That Gateway has no backups you can restore.");
    const points = await listPoints(acct.call, machine.connector_id);
    if (points.length === 0)
        throw new CliStop(`${machine.name} has no restore points.`);
    const point = options.point
        ? points.find((candidate) => candidate.snapshot_id === options.point)
        : await (async () => {
            io.print(`Restore points of ${machine.name}, newest first:`);
            return choose(io, points, (p) => `${p.made_at ?? "?"} — ${p.files.toLocaleString("en-US")} files, ${sizeText(p.bytes)} (${p.kind})`, "Number (Enter for the newest): ");
        })();
    if (!point)
        throw new CliStop("That restore point wasn't found.");
    const place = env.place();
    const store = options.keepKeys ? env.keystore() : null;
    if (options.keepKeys && !store)
        io.error("This computer has no keychain the plugin can use, so the keys can't be kept for its own backups.");
    for (let attempt = 0;; attempt += 1) {
        const secret = await io.ask("Passphrase or recovery key: ", { hidden: true });
        io.print("Downloading and checking the backup…");
        try {
            const result = await restoreBackup({
                call: acct.call,
                put: (url, headers, bytes) => putObject(acct.fetch, url, headers, bytes),
                get: (url) => getObject(acct.fetch, url),
                stateDir: place.stateDir, configPath: place.configPath,
                connectorId: machine.connector_id, snapshotId: point.snapshot_id, secret,
                overwrite: options.overwrite === true,
                keepKeys: store ? { connectorId: acct.connectorId, keystore: store } : null,
                resolveWorkspace: env.resolveWorkspace, pointMadeAt: point.made_at,
                log: { info: () => { }, warn: (message) => io.error(message) },
            });
            io.print(`Restored ${result.files.toLocaleString("en-US")} file${result.files === 1 ? "" : "s"}.`);
            if (result.config === "merged")
                io.print("openclaw.json was merged; the one before is saved as openclaw.json.before-restore.");
            if (result.automations.names.length > 0) {
                io.print(result.automations.importable ? `Automations: ${result.automations.imported} imported.`
                    : "Automations: not imported (see the rebuild kit).");
            }
            if (result.kit)
                io.print(`Rebuild kit: ${result.kit}`);
            for (const note of result.notes)
                io.print(note);
            if (result.keys_kept)
                io.print("This computer keeps the same backup keys for its own backups.");
            io.print("");
            io.print("Sign-in checklist (sign in again to each; nothing secret was backed up):");
            for (const name of result.sign_in)
                io.print(`  - ${name}`);
            if (result.sign_in.length === 0)
                io.print("  nothing");
            io.print("");
            io.print("Restart the Gateway so it uses what was restored. Then, in Octopus Prime, send the rebuild kit to your agent.");
            return 0;
        }
        catch (error) {
            if (error instanceof BackupKeyError && attempt < 2) {
                io.error(error.message);
                continue;
            }
            throw error;
        }
    }
}
/** Runs one backup command and gives its exit code; what went wrong is told in plain words. */
export async function runBackupCommand(command, options, env) {
    try {
        if (command === "estimate") {
            env.io.print(estimateText(await estimateBackup(env.place())));
            return 0;
        }
        if (!BACKUP_COMMANDS.includes(command))
            throw new CliStop(`Unknown backup command: ${command}`);
        const acct = account(env, options.account);
        if (command === "status")
            return await statusCommand(env, acct);
        if (command === "setup")
            return await setupCommand(env, acct, options);
        if (command === "passphrase")
            return await passphraseCommand(env, acct, options);
        if (command === "now")
            return await nowCommand(env, acct);
        return await restoreCommand(env, acct, options);
    }
    catch (error) {
        if (error instanceof CliStop || error instanceof BackupRefusedError || error instanceof BackupKeyError
            || error instanceof RestoreConflictError) {
            env.io.error(error.message);
        }
        else {
            env.io.error(`The backup command did not finish: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 1;
    }
}
// -- the terminal ------------------------------------------------------------------------------
/**
 * Prompts on this terminal. A hidden prompt shows its question and nothing
 * typed; it does so by replacing readline's output writer, Node's long-used
 * way to read a password with node:readline alone (no new dependency).
 */
export function terminalIo() {
    return {
        print: (line) => { process.stdout.write(`${line}\n`); },
        error: (line) => { process.stderr.write(`${line}\n`); },
        ask: (question, options = {}) => new Promise((resolve, reject) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
            let answered = false;
            if (options.hidden) {
                let prompted = false;
                rl._writeToOutput = (text) => {
                    if (!prompted) {
                        process.stdout.write(text);
                        prompted = true;
                    }
                };
            }
            rl.on("close", () => { if (!answered)
                reject(new CliStop("Stopped; nothing more was done.")); });
            rl.question(question, (answer) => {
                answered = true;
                rl.close();
                if (options.hidden)
                    process.stdout.write("\n");
                resolve(answer);
            });
        }),
    };
}
/** Whether a folder can be made or written here: a workspace path from another computer may not be. */
function usableDir(dir) {
    let probe = path.resolve(dir);
    while (!existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe)
            return null;
        probe = parent;
    }
    try {
        accessSync(probe, fsConstants.W_OK);
        return dir;
    }
    catch {
        return null;
    }
}
/** The environment of a command run by `openclaw`: its config, this terminal, Node's fetch and this computer's keychain. */
export function cliEnvironment(config) {
    return {
        config,
        io: terminalIo(),
        fetch: (input, init) => fetch(input, init),
        place: () => placeFromConfig(config),
        keystore: () => computerKeystore(resolveStateDir(process.env)),
        resolveWorkspace: (merged, agentId) => {
            try {
                return usableDir(resolveAgentWorkspaceDir(merged, agentId));
            }
            catch {
                return null;
            }
        },
    };
}
const DESCRIPTIONS = {
    setup: "Set up Agent Backup on this computer: a passphrase, a recovery key, and the key in this computer's keychain",
    status: "Whether backups are on for this Gateway, its plan and its last backup",
    now: "Back up now",
    estimate: "How big a backup of this Gateway would be and which plan fits (uploads nothing)",
    restore: "Restore a backup onto this computer (passphrase or recovery key)",
    passphrase: "Change the backup passphrase (and, with --new-recovery-key, the recovery key)",
};
/**
 * `openclaw octopus-prime …`: the connector's command, with
 * `backup <setup|status|now|estimate|restore|passphrase>` under it. `env` is
 * made when a command runs (the config the CLI gave, this terminal).
 */
export function registerOctopusCli(program, makeEnv) {
    const root = program.command("octopus-prime").description("Octopus Prime connector management");
    const backup = root.command("backup").description("Agent Backup: this Gateway's files, encrypted on this computer, kept by Octopus Prime");
    for (const name of BACKUP_COMMANDS) {
        let command = backup.command(name).description(DESCRIPTIONS[name]);
        if (name !== "estimate")
            command = command.option("--account <id>", "the Octopus Prime account (connector) to use");
        if (name === "setup" || name === "passphrase") {
            command = command.option("--recovery-key-file <path>", "also save the new recovery key to this file (readable by you only)");
        }
        if (name === "passphrase")
            command = command.option("--new-recovery-key", "make a new recovery key too");
        if (name === "restore") {
            command = command
                .option("--overwrite", "replace files that are already on this computer")
                .option("--keep-keys", "keep the same keys for this computer's own backups")
                .option("--machine <connector_id>", "the Gateway whose backup to restore")
                .option("--point <snapshot_id>", "the restore point");
        }
        command.action(async (...args) => {
            const options = (args[0] && typeof args[0] === "object" ? args[0] : {});
            process.exitCode = await runBackupCommand(name, options, makeEnv());
        });
    }
}
