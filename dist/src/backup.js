/**
 * Agent Backup (1.38.0, docs/AGENT-BACKUP.md): an encrypted copy of this
 * Gateway's OpenClaw files, kept by Octopus Prime, to bring its agents back on
 * a new computer. Everything is encrypted here before it leaves
 * (src/backup-crypto.ts); the server keeps ciphertext, sizes and counts.
 *
 * A backend that keeps backups offers "agent-backup" in its welcome, to a
 * plugin that asked for it in the negotiation's optional field
 * (src/protocol.ts). Only on such a connection does the plugin ask
 * `backup.status` every 10 minutes and back up when its plan's interval
 * passed or "Back up now" was asked (here: BackupScheduler; the socket frame
 * `backup.run` asks at once). Every call is a frame POSTed to
 * /api/connector/backup with the connector's credential, answered
 * `backup.result` or `backup.rejected` with a reason (REFUSALS). Chunks and
 * manifests go to and come from R2 through links the server signs for minutes
 * (PUT with exactly the signed headers; GET), never through the server.
 *
 * Without a Backup plan for this Gateway, an older backend, or no keychain on
 * this computer, nothing is backed up and everything works as before.
 */
export const BACKUP_TOOL = "octopus_backup";
export const RUN_FRAME = "backup.run";
export const STATUS_FRAME = "backup.status";
export const SETUP_FRAME = "backup.setup";
export const BEGIN_FRAME = "backup.begin";
export const CHUNKS_FRAME = "backup.chunks";
export const UPLOADED_FRAME = "backup.uploaded";
export const MANIFEST_FRAME = "backup.manifest";
export const COMMIT_FRAME = "backup.commit";
export const ABORT_FRAME = "backup.abort";
export const MACHINES_FRAME = "backup.machines";
export const POINTS_FRAME = "backup.points";
export const KEYS_FRAME = "backup.keys";
export const DOWNLOAD_FRAME = "backup.download";
export const RESTORED_FRAME = "backup.restored";
export const RESULT_FRAME = "backup.result";
export const REJECTED_FRAME = "backup.rejected";
export const BACKUP_PATH = "/api/connector/backup";
export const REBUILD_KIT_FILE = "OCTOPUS-REBUILD-KIT.md";
// The backend's limits (backend/agent_backup.py).
export const CHUNK_PAGE = 1000;
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024 + 64 * 1024;
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
export const SNAPSHOT_CHUNKS_MAX = 250_000;
export const BODY_MAX_BYTES = 256 * 1024;
export const SIGN_IN_MAX = 100;
export const NAME_MAX = 200;
/** How often each account asks whether a backup is due. */
export const CHECK_EVERY_MS = 10 * 60 * 1000;
/** The first ask after a connection: soon, but not in the middle of the welcome. */
export const FIRST_CHECK_MS = 60 * 1000;
/** A call to the backend is given up after this long; an upload or download of one object too. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const OBJECT_TIMEOUT_MS = 5 * 60 * 1000;
export const GB = 1024 ** 3;
/** The Backup plans (docs/AGENT-BACKUP.md §2), smallest first. */
export const BACKUP_PLANS = [
    { key: "backup_5", name: "Backup 5 GB", monthly_usd: 5, storage_gb: 5, every: "daily", keep_days: 14 },
    { key: "backup_25", name: "Backup 25 GB", monthly_usd: 12, storage_gb: 25, every: "every 6 hours", keep_days: 30 },
    { key: "backup_100", name: "Backup 100 GB", monthly_usd: 29, storage_gb: 100, every: "hourly", keep_days: 90 },
];
/** The smallest plan that holds `bytes`, or null when none does (over 100 GB). */
export function planFit(bytes) {
    const plan = BACKUP_PLANS.find((candidate) => bytes <= candidate.storage_gb * GB);
    return plan ? { key: plan.key, name: plan.name } : null;
}
/** What each of the backend's reasons means, in plain words. */
export const REFUSALS = {
    unavailable: "Agent Backup isn't available on this Octopus Prime server right now.",
    invalid_request: "The Octopus Prime server didn't accept the backup request as sent.",
    not_enabled: "Backups are off for this Gateway. Its owner turns them on in Octopus Prime: Settings › Plugin › Backups.",
    no_plan: "This Gateway has no Backup plan. An Owner adds one in Billing on the web.",
    not_set_up: "Backups aren't set up on this computer yet. Run `openclaw octopus-prime backup setup` here.",
    already_set_up: "Backups are already set up for this Gateway. To change the passphrase, run `openclaw octopus-prime backup passphrase`.",
    too_soon: "A backup was made or asked for a short while ago. The next one runs on schedule.",
    busy: "Another backup of this Gateway is running. Try again when it has finished.",
    over_plan: "This backup would go over the plan's storage. The last restore point stays; a bigger plan or fewer files fixes it.",
    too_many_chunks: "This backup has more pieces than one restore point can hold.",
    not_found: "That Gateway or restore point wasn't found.",
    closed: "That backup was already finished or given up.",
    incomplete: "Not every piece of this backup reached Octopus Prime, so it wasn't finished.",
};
export function refusalMessage(reason) {
    return REFUSALS[reason] ?? `The Octopus Prime server refused the backup request (${reason}).`;
}
/** The backend refused a backup call, with its reason (REFUSALS) and its answer. */
export class BackupRefusedError extends Error {
    reason;
    frame;
    constructor(reason, frame = {}) {
        super(refusalMessage(reason));
        this.reason = reason;
        this.frame = frame;
    }
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/**
 * POSTs one call to the account's backend with its connector credential, never
 * following a redirect (the credential goes to its own backend only), and
 * reads the answer. Used by the Gateway's transport (after its own checks)
 * and by the `openclaw octopus-prime backup` commands.
 */
export async function postBackupFrame(params) {
    const body = JSON.stringify(params.frame);
    if (Buffer.byteLength(body) > BODY_MAX_BYTES)
        throw new Error("This backup request is too large to send at once");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await params.fetch(`${params.backendUrl.replace(/\/+$/, "")}${BACKUP_PATH}`, {
            method: "POST",
            headers: { authorization: `Bearer ${params.connectorToken}`, "content-type": "application/json" },
            body,
            redirect: "error",
            signal: params.signal ? AbortSignal.any([params.signal, timeout]) : timeout,
        });
    }
    catch {
        throw new Error("The Octopus Prime server could not be reached for the backup; try again in a moment");
    }
    let answer;
    try {
        answer = await response.json();
    }
    catch {
        answer = undefined;
    }
    const frame = isRecord(answer) ? answer : {};
    if (response.status === 429)
        throw new Error("Too many backup calls just now; wait a moment and try again");
    if (response.status === 404)
        throw new Error("This Octopus Prime server doesn't offer Agent Backup");
    if (!response.ok)
        throw new Error(`The Octopus Prime server refused the backup call (${response.status})`);
    if (frame.type === REJECTED_FRAME)
        throw new BackupRefusedError(typeof frame.reason === "string" ? frame.reason : "rejected", frame);
    if (frame.type !== RESULT_FRAME)
        throw new Error("The Octopus Prime server did not answer the backup request");
    return frame;
}
/** Uploads one sealed object to its signed link with exactly the headers it was signed with. */
export async function putObject(fetchFn, url, headers, bytes) {
    let response;
    try {
        response = await fetchFn(url, {
            method: "PUT", headers: { ...headers }, body: new Uint8Array(bytes), redirect: "error",
            signal: AbortSignal.timeout(OBJECT_TIMEOUT_MS),
        });
    }
    catch {
        throw new Error("A backup piece could not be uploaded");
    }
    if (!response.ok)
        throw new Error(`A backup piece was refused by storage (${response.status})`);
    try {
        await response.arrayBuffer();
    }
    catch { /* the body is not needed */ }
}
/** Downloads one sealed object from its signed link. */
export async function getObject(fetchFn, url) {
    let response;
    try {
        response = await fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(OBJECT_TIMEOUT_MS) });
    }
    catch {
        throw new Error("A backup piece could not be downloaded");
    }
    if (!response.ok)
        throw new Error(`A backup piece could not be downloaded (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
}
/** backup.status's answer as this plugin reads it. */
export function statusOf(frame) {
    const plan = isRecord(frame.plan) && typeof frame.plan.key === "string" ? frame.plan : null;
    const count = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
        enabled: frame.enabled === true,
        set_up: frame.set_up === true,
        key_id: typeof frame.key_id === "string" ? frame.key_id : null,
        plan,
        last_backup_at: typeof frame.last_backup_at === "string" ? frame.last_backup_at : null,
        stored_bytes: count(frame.stored_bytes),
        storage_bytes: count(frame.storage_bytes),
        due: frame.due === true,
        run_now: frame.run_now === true,
    };
}
/**
 * One account's schedule: asks backup.status every 10 minutes, and backs up
 * when the Gateway's backups are on and set up, this computer holds the
 * matching key, and a backup is due or "Back up now" was asked. One backup at
 * a time per account. Its timers never keep the process alive, and stop()
 * ends it (the socket closed).
 */
export class BackupScheduler {
    timer = null;
    running = null;
    stopped = false;
    warnedKey = false;
    options;
    constructor(options) {
        this.options = options;
    }
    start() {
        this.stopped = false;
        this.arm(this.options.firstMs ?? FIRST_CHECK_MS);
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            (this.options.clearTimeout ?? ((t) => clearTimeout(t)))(this.timer);
        this.timer = null;
    }
    get busy() {
        return this.running !== null;
    }
    arm(ms) {
        if (this.stopped)
            return;
        const set = this.options.setTimeout ?? ((fn, wait) => setTimeout(fn, wait));
        this.timer = set(() => {
            this.timer = null;
            void this.check().finally(() => this.arm(this.options.everyMs ?? CHECK_EVERY_MS));
        }, ms);
        this.timer.unref?.();
    }
    /** One look at backup.status, and a backup if one is due. Never throws. */
    async check() {
        if (this.stopped || this.running)
            return;
        try {
            const status = statusOf(await this.options.call({ type: STATUS_FRAME }));
            if (!status.enabled || !status.set_up || !status.key_id || !(status.due || status.run_now))
                return;
            if (!await this.options.hasKey(status.key_id)) {
                if (!this.warnedKey) {
                    this.options.log.warn("backups are on for this Gateway, but this computer's keychain doesn't hold its backup key; "
                        + "run `openclaw octopus-prime backup setup` here");
                    this.warnedKey = true;
                }
                return;
            }
            this.warnedKey = false;
            await this.start1(status.run_now ? "manual" : "scheduled", status);
        }
        catch (error) {
            this.options.log.warn(`the backup check did not finish: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** "Back up now" (the socket's backup.run): false when a backup is already running. */
    runNow() {
        if (this.stopped || this.running)
            return false;
        void this.start1("manual").catch(() => { });
        return true;
    }
    async start1(kind, known) {
        if (this.running)
            return;
        const work = (async () => {
            const status = known ?? statusOf(await this.options.call({ type: STATUS_FRAME }));
            if (!status.enabled || !status.set_up || !status.key_id)
                return;
            if (!known && !await this.options.hasKey(status.key_id))
                return;
            await this.options.run(kind, status);
        })();
        this.running = work;
        try {
            await work;
        }
        catch (error) {
            if (error instanceof BackupRefusedError && error.reason === "too_soon")
                this.options.log.info(error.message);
            else
                this.options.log.warn(`the backup did not finish: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.running = null;
        }
    }
}
// -- the agent's tool ---------------------------------------------------------------------------
export const BACKUP_TOOL_DESCRIPTION = [
    "Octopus Prime Agent Backup for this OpenClaw Gateway (an encrypted copy of your workspace, memory, skills,",
    "config without secrets and automations). Use it when someone asks how big an Octopus Prime backup of you (this",
    "agent, this Gateway or this computer's OpenClaw) would be, which Backup plan fits, or whether backups are on.",
    "action \"estimate\": counts exactly what a backup would take (the same exclusions: no secrets, sign-ins,",
    "dependencies, caches, repositories with a remote, files over 100 MB) and answers the total size, the number of",
    "files, the 5 largest folders and which plan fits (5, 25 or 100 GB). It uploads nothing and works before any plan",
    "is bought. action \"status\": whether backups are on for this Gateway, its plan, the last backup and the storage",
    "used.",
].join(" ");
export const BACKUP_PARAMETERS = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["estimate", "status"],
            description: "estimate: the size a backup would be and which plan fits. status: whether backups are on and the last one.",
        },
    },
    required: ["action"],
    additionalProperties: false,
};
/** A size in plain words: 1.2 GB, 340 MB, 12 KB. */
export function sizeText(bytes) {
    const units = [[GB, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
    for (const [unit, name] of units) {
        if (bytes >= unit)
            return `${(Math.round((bytes / unit) * 10) / 10).toLocaleString("en-US")} ${name}`;
    }
    return `${bytes.toLocaleString("en-US")} bytes`;
}
