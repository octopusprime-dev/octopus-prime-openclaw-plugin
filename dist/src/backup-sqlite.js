import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
/**
 * Automations in a backup (1.38.0, docs/AGENT-BACKUP.md §5): a sanitized copy
 * of the state dir's `state/openclaw.sqlite`. The live database is copied with
 * `VACUUM INTO` to a temporary file, never changed; in the copy every table
 * OpenClaw's own `backup --exclude-secrets` leaves out is dropped (its
 * documented list, docs/cli/backup.md), so is any table whose name looks like
 * a secret store, and `config_machine_state` loses its rows for auth
 * profiles, node host and web push keys. A final VACUUM rewrites the file so
 * nothing removed stays in its free pages. The per-agent openclaw-agent.sqlite
 * (auth profiles, sessions, transcripts) is never backed up at all.
 *
 * On restore the live database is never overwritten: the sanitized copy is
 * written to `<stateDir>/octopus-restore/state-openclaw.sqlite`, and the
 * automations (`cron_jobs`) are imported into the live database only when it
 * has a cron_jobs table with exactly the same columns, rows it already has
 * kept as they are (INSERT OR IGNORE).
 */
export const STATE_DB = path.join("state", "openclaw.sqlite");
export const RESTORED_STATE_DB = path.join("octopus-restore", "state-openclaw.sqlite");
export const SECRET_TABLES = [
    "audit_identity_keys", "apns_registrations", "channel_ingress_events", "channel_pairing_requests",
    "clawhub_promotion_claims", "config_revision_keys", "device_auth_tokens", "device_bootstrap_tokens",
    "device_identities", "device_pairing_join_codes", "device_pairing_paired", "gateway_origin_device_tokens",
    "mcp_oauth_pending_authorizations", "mcp_oauth_stores", "native_hook_relay_bridges", "secret_store_entries",
    "web_push_subscriptions", "worker_environment_credentials",
];
const SECRET_TABLE_NAME = /secret|token|credential|oauth|password|private|cookie|pairing|identit|auth|^device_|^mcp_oauth_|push/i;
const MACHINE_STATE_SECRET_PREFIXES = ["authProfiles.", "nodeHost.", "webPush.vapidKeys"];
const sqlString = (text) => `'${text.replace(/'/g, "''")}'`;
const sqlName = (text) => `"${text.replace(/"/g, "\"\"")}"`;
export function isSecretTable(name) {
    return SECRET_TABLES.includes(name) || SECRET_TABLE_NAME.test(name);
}
function tableNames(db, schema = "main") {
    return db.prepare(`SELECT name FROM ${sqlName(schema)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all().map((row) => row.name);
}
function columns(db, table, schema = "main") {
    return db.prepare(`PRAGMA ${sqlName(schema)}.table_info(${sqlName(table)})`).all()
        .map((row) => ({ name: row.name, type: String(row.type ?? "") }));
}
async function removeDbFiles(file) {
    await Promise.all(["", "-wal", "-shm", "-journal"].map((suffix) => rm(`${file}${suffix}`, { force: true })));
}
/**
 * How long the copy waits for a lock another connection holds (a rollback-journal
 * database being committed, WAL recovery) before it fails with SQLite's own
 * "database is locked". In WAL mode readers are not blocked by a writer.
 */
export const BUSY_TIMEOUT_MS = 5000;
/**
 * The sanitized copy's bytes, or null when there is no database there. The
 * temporary file is made in `tempDir` and always removed.
 */
export async function sanitizedStateDb(source, tempDir, options = {}) {
    if (!existsSync(source))
        return null;
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(tempDir, `state-copy-${randomUUID()}.sqlite`);
    try {
        let live;
        const timeout = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
        try {
            live = new DatabaseSync(source, { readOnly: true, timeout });
        }
        catch {
            live = new DatabaseSync(source, { timeout });
        }
        try {
            live.exec(`VACUUM INTO ${sqlString(temporary)}`);
        }
        finally {
            live.close();
        }
        const copy = new DatabaseSync(temporary);
        const dropped = [];
        let automations = [];
        try {
            for (const name of tableNames(copy)) {
                if (!isSecretTable(name))
                    continue;
                copy.exec(`DROP TABLE IF EXISTS ${sqlName(name)}`);
                dropped.push(name);
            }
            if (tableNames(copy).includes("config_machine_state") && columns(copy, "config_machine_state").some((c) => c.name === "key")) {
                const remove = copy.prepare("DELETE FROM config_machine_state WHERE substr(key, 1, ?) = ?");
                for (const prefix of MACHINE_STATE_SECRET_PREFIXES)
                    remove.run(prefix.length, prefix);
            }
            automations = automationNames(copy);
            copy.exec("PRAGMA journal_mode = DELETE");
            copy.exec("VACUUM");
        }
        finally {
            copy.close();
        }
        return { bytes: await readFile(temporary), dropped, automations };
    }
    finally {
        await removeDbFiles(temporary);
    }
}
/** The automations' names in a database (cron_jobs: its name, else the job's own name or id). */
export function automationNames(db, schema = "main") {
    if (!tableNames(db, schema).includes("cron_jobs"))
        return [];
    const have = new Set(columns(db, "cron_jobs", schema).map((c) => c.name));
    const picked = ["name", "id", "job_json"].filter((name) => have.has(name));
    if (picked.length === 0)
        return [];
    const rows = db.prepare(`SELECT ${picked.map(sqlName).join(", ")} FROM ${sqlName(schema)}.cron_jobs`).all();
    return rows.map((row) => {
        let job = {};
        if (typeof row.job_json === "string") {
            try {
                const parsed = JSON.parse(row.job_json);
                if (parsed && typeof parsed === "object")
                    job = parsed;
            }
            catch { /* a job that can't be read is named by its id */ }
        }
        const name = [row.name, job.name, job.title, row.id, job.id].find((value) => typeof value === "string" && value.trim());
        return typeof name === "string" ? name.trim().slice(0, 200) : "automation";
    });
}
/**
 * Writes the sanitized copy beside the live database (never over it) and
 * imports its automations into the live one when its cron_jobs table has the
 * same columns. `stateDir` is this computer's state dir.
 */
export async function restoreStateDb(bytes, stateDir) {
    const staged = path.join(stateDir, RESTORED_STATE_DB);
    await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
    await removeDbFiles(staged);
    await writeFile(staged, bytes, { mode: 0o600 });
    const restored = new DatabaseSync(staged, { readOnly: true });
    let automations;
    try {
        automations = automationNames(restored);
    }
    finally {
        restored.close();
    }
    const livePath = path.join(stateDir, STATE_DB);
    if (!existsSync(livePath))
        return { staged, imported: 0, automations, importable: false };
    const live = new DatabaseSync(livePath);
    try {
        live.exec(`ATTACH DATABASE ${sqlString(staged)} AS restored`);
        try {
            const same = tableNames(live).includes("cron_jobs") && tableNames(live, "restored").includes("cron_jobs")
                && JSON.stringify(columns(live, "cron_jobs")) === JSON.stringify(columns(live, "cron_jobs", "restored"));
            if (!same)
                return { staged, imported: 0, automations, importable: false };
            const before = live.prepare("SELECT count(*) AS n FROM main.cron_jobs").get().n;
            live.exec("INSERT OR IGNORE INTO main.cron_jobs SELECT * FROM restored.cron_jobs");
            const after = live.prepare("SELECT count(*) AS n FROM main.cron_jobs").get().n;
            return { staged, imported: Number(after) - Number(before), automations, importable: true };
        }
        finally {
            live.exec("DETACH DATABASE restored");
        }
    }
    finally {
        live.close();
    }
}
