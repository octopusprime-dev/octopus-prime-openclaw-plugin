import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { ABORT_FRAME, BACKUP_PLANS, BackupFailure, BackupRefusedError, BEGIN_FRAME, CHUNK_MAX_BYTES, failureReasonOf, sizeText, CHUNK_PAGE, CHUNKS_FRAME, COMMIT_FRAME, DOWNLOAD_FRAME, KEYS_FRAME, MACHINES_FRAME, MANIFEST_FRAME, MANIFEST_MAX_BYTES, NAME_MAX, planFit, POINTS_FRAME, REBUILD_KIT_FILE, RESTORED_FRAME, SETUP_FRAME, SIGN_IN_MAX, SNAPSHOT_CHUNKS_MAX, STATUS_FRAME, statusOf, UPLOADED_FRAME, } from "./backup.js";
import { mergeConfig, parseConfigText, redactConfig } from "./backup-config.js";
import { chunkIdOf, decryptChunk, decryptManifest, deriveKeys, encryptManifest, keyIdOf, openEnvelope, openEnvelopeWithTyped, PIECE_MAX_BYTES, sealChunk, sha256Hex, } from "./backup-crypto.js";
import { backupRoots, walkBackupFiles, } from "./backup-files.js";
import { restoreStateDb, sanitizedStateDb } from "./backup-sqlite.js";
import { PLUGIN_VERSION } from "./protocol.js";
const quiet = { info() { }, warn() { } };
const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
async function pool(items, limit, work) {
    let next = 0;
    let failed;
    const worker = async () => {
        while (next < items.length && failed === undefined) {
            const item = items[next++];
            try {
                await work(item);
            }
            catch (error) {
                failed ??= error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    if (failed !== undefined)
        throw failed;
}
async function readPiece(file, offset, length) {
    const handle = await open(file, "r");
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
/** A file's pieces, read one at a time (never the whole file at once). */
async function* filePieces(file, size) {
    const handle = await open(file, "r");
    try {
        for (let offset = 0; offset < size;) {
            const length = Math.min(PIECE_MAX_BYTES, size - offset);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (bytesRead === 0)
                break;
            yield buffer.subarray(0, bytesRead);
            offset += bytesRead;
        }
    }
    finally {
        await handle.close();
    }
}
function* bufferPieces(bytes) {
    for (let offset = 0; offset < bytes.length; offset += PIECE_MAX_BYTES)
        yield bytes.subarray(offset, offset + PIECE_MAX_BYTES);
}
/**
 * `<stateDir>/plugins/octopus-prime/backup/<connectorId>-index.json`: each
 * file's size, change time and inode with its chunk ids and their sealed
 * sizes and digests, so an unchanged file isn't read again. It names files by
 * root label and relative path, and it never leaves this computer.
 */
export function backupDir(stateDir) {
    return path.join(stateDir, "plugins", "octopus-prime", "backup");
}
const indexFile = (stateDir, connectorId) => path.join(backupDir(stateDir), `${connectorId}-index.json`);
const indexKey = (file) => `${file.root}\u0000${file.path}`;
/** The restore point this computer opened and has not closed yet: a run that was killed leaves it for the next one. */
const openFile = (stateDir, connectorId) => path.join(backupDir(stateDir), `${connectorId}-open.json`);
async function loadIndex(stateDir, connectorId, keyId) {
    try {
        const parsed = JSON.parse(await readFile(indexFile(stateDir, connectorId), "utf8"));
        if (parsed?.v === 1 && parsed.key_id === keyId && isRecord(parsed.files))
            return parsed;
    }
    catch { /* none yet, or unreadable: start afresh */ }
    return { v: 1, key_id: keyId, files: {} };
}
async function rememberOpen(stateDir, connectorId, snapshotId) {
    const file = openFile(stateDir, connectorId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ snapshot_id: snapshotId }), { mode: 0o600 });
}
/**
 * Gives up an open restore point (backup.abort). One the server already
 * closed or doesn't know is as good as given up; one it could not be told
 * about (no network, a killed process) stays remembered for the next run.
 * `reason` (a code, never text) is how the server tells the Gateway's owner
 * that the backup did not finish; a server that doesn't take it is told
 * without.
 */
async function giveUp(deps, snapshotId, reason) {
    try {
        await deps.call({ type: ABORT_FRAME, snapshot_id: snapshotId, ...(reason ? { reason } : {}) });
    }
    catch (error) {
        if (!(error instanceof BackupRefusedError))
            throw error;
        if (reason && error.reason === "invalid_request") {
            await deps.call({ type: ABORT_FRAME, snapshot_id: snapshotId }).catch((again) => {
                if (!(again instanceof BackupRefusedError))
                    throw again;
            });
        }
    }
    await rm(openFile(deps.stateDir, deps.connectorId), { force: true });
}
/** A restore point an earlier run left open (killed, or offline when it failed): given up before a new one begins. */
async function giveUpLeftOpen(deps, log) {
    let snapshotId;
    try {
        snapshotId = JSON.parse(await readFile(openFile(deps.stateDir, deps.connectorId), "utf8"))?.snapshot_id;
    }
    catch {
        return;
    }
    if (typeof snapshotId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshotId)) {
        await rm(openFile(deps.stateDir, deps.connectorId), { force: true }).catch(() => { });
        return;
    }
    await giveUp(deps, snapshotId, "interrupted").catch((error) => {
        log.warn(`the restore point a run left open was not given up yet: ${error instanceof Error ? error.message : String(error)}`);
    });
}
async function saveIndex(stateDir, connectorId, index) {
    const file = indexFile(stateDir, connectorId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
    await rename(temporary, file);
}
// -- backup -----------------------------------------------------------------------------------
/** An upload of a sealed object; whatever stops it is reported as an upload that failed. */
async function putSealed(io, url, headers, bytes) {
    try {
        await io.put(url, headers, bytes);
    }
    catch (error) {
        if (error instanceof BackupFailure)
            throw error;
        throw new BackupFailure(error instanceof Error ? error.message : "A backup piece could not be uploaded", "upload_failed");
    }
}
function uploadsOf(answer) {
    const list = Array.isArray(answer.upload) ? answer.upload : [];
    return list.map((item) => {
        if (!isRecord(item) || typeof item.id !== "string" || typeof item.url !== "string" || !isRecord(item.headers)) {
            throw new Error("The Octopus Prime server sent an upload link that could not be read");
        }
        const headers = {};
        for (const [name, value] of Object.entries(item.headers))
            headers[name] = String(value);
        return { id: item.id, url: item.url, headers };
    });
}
/** Chunks waiting to be named to the server, in pages of at most CHUNK_PAGE, each uploaded where it asks. */
class ChunkSender {
    io;
    keys;
    snapshotId;
    page;
    batchBytes;
    concurrency;
    pending = [];
    pendingBytes = 0;
    /** Every chunk this restore point references, with what was sent for it. */
    sealed = new Map();
    uploaded = 0;
    uploadedBytes = 0;
    constructor(io, keys, snapshotId, page, batchBytes, concurrency) {
        this.io = io;
        this.keys = keys;
        this.snapshotId = snapshotId;
        this.page = page;
        this.batchBytes = batchBytes;
        this.concurrency = concurrency;
    }
    has(id) {
        return this.sealed.has(id);
    }
    async add(chunk) {
        if (this.sealed.has(chunk.id))
            return;
        if (this.sealed.size >= SNAPSHOT_CHUNKS_MAX)
            throw new BackupRefusedError("too_many_chunks");
        this.sealed.set(chunk.id, { id: chunk.id, size: chunk.size, sha256: chunk.sha256 });
        this.pending.push(chunk);
        this.pendingBytes += chunk.bytes?.length ?? 0;
        if (this.pending.length >= this.page || this.pendingBytes >= this.batchBytes)
            await this.flush();
    }
    async flush() {
        if (this.pending.length === 0)
            return;
        const batch = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        const byId = new Map(batch.map((chunk) => [chunk.id, chunk]));
        const ask = async (chunks) => uploadsOf(await this.io.call({
            type: CHUNKS_FRAME, snapshot_id: this.snapshotId,
            chunks: chunks.map(({ id, size, sha256 }) => ({ id, size, sha256 })),
        }));
        const ready = [];
        const stale = [];
        for (const upload of await ask(batch)) {
            const chunk = byId.get(upload.id);
            if (!chunk)
                throw new Error("The Octopus Prime server asked for a piece this backup didn't name");
            if (chunk.bytes)
                ready.push({ ...upload, bytes: chunk.bytes });
            else
                stale.push(chunk);
        }
        if (stale.length > 0) {
            // Pieces this computer sent before that the server no longer holds:
            // read again, sealed afresh (a new nonce, so a new digest), named again.
            const fresh = new Map();
            for (const chunk of stale) {
                const piece = await chunk.reread();
                if (chunkIdOf(this.keys, piece) !== chunk.id)
                    throw new Error("A file changed while it was being backed up; it is backed up next time");
                const sealed = await sealChunk(this.keys, piece, chunk.id);
                fresh.set(chunk.id, sealed.bytes);
                this.sealed.set(chunk.id, { id: chunk.id, size: sealed.size, sha256: sealed.sha256 });
            }
            for (const upload of await ask([...fresh.keys()].map((id) => this.sealed.get(id)))) {
                const bytes = fresh.get(upload.id);
                if (!bytes)
                    throw new Error("The Octopus Prime server asked for a piece this backup didn't name");
                ready.push({ ...upload, bytes });
            }
        }
        const sent = [];
        const failed = await pool(ready, this.concurrency, async (upload) => {
            await putSealed(this.io, upload.url, upload.headers, upload.bytes);
            sent.push(upload);
        }).then(() => null, (error) => ({ error }));
        // What reached storage is confirmed even when another piece failed, so the next run doesn't send it again.
        if (sent.length > 0) {
            try {
                await this.io.call({ type: UPLOADED_FRAME, snapshot_id: this.snapshotId, chunks: sent.map((upload) => upload.id) });
                this.uploaded += sent.length;
                this.uploadedBytes += sent.reduce((sum, upload) => sum + upload.bytes.length, 0);
            }
            catch (error) {
                if (!failed)
                    throw error;
            }
        }
        if (failed)
            throw failed.error;
    }
}
const channelNames = (config) => (isRecord(config) && isRecord(config.channels) ? Object.keys(config.channels) : [])
    .filter((name) => name !== "octopus-prime").sort();
/**
 * One backup: backup.status, then backup.begin, the walk, every file split
 * into pieces of at most 4 MiB, each piece's id, the new ones sealed and named
 * in pages (backup.chunks), uploaded where the server asks (PUT with exactly
 * its signed headers, at most `concurrency` at once) and confirmed
 * (backup.uploaded); then the sealed manifest (backup.manifest, PUT) and
 * backup.commit. On any error the pieces that reached storage are still
 * confirmed, the restore point is given up (backup.abort) and the error
 * thrown. A point the server could not be told about (offline, a killed
 * process) is remembered and given up before the next run's backup.begin.
 */
export async function runBackup(deps) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? quiet;
    const status = deps.status ?? statusOf(await deps.call({ type: STATUS_FRAME }));
    if (!status.enabled)
        throw new BackupRefusedError("not_enabled");
    if (!status.set_up || !status.key_id)
        throw new BackupRefusedError("not_set_up");
    const dk = await deps.keystore.get(deps.connectorId);
    if (!dk || keyIdOf(dk) !== status.key_id) {
        throw new Error("This computer's keychain doesn't hold this Gateway's backup key; run `openclaw octopus-prime backup setup` here");
    }
    const keys = deriveKeys(dk);
    await giveUpLeftOpen(deps, log);
    const begun = await deps.call({ type: BEGIN_FRAME, kind: deps.kind ?? "scheduled" });
    const snapshotId = typeof begun.snapshot_id === "string" ? begun.snapshot_id : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(snapshotId))
        throw new Error("The Octopus Prime server did not open a restore point");
    const page = Math.max(1, Math.min(CHUNK_PAGE, typeof begun.chunk_page === "number" ? begun.chunk_page : CHUNK_PAGE));
    const manifestMax = typeof begun.manifest_max_bytes === "number" ? begun.manifest_max_bytes : MANIFEST_MAX_BYTES;
    try {
        await rememberOpen(deps.stateDir, deps.connectorId, snapshotId).catch((error) => {
            log.warn(`the open restore point was not remembered: ${error instanceof Error ? error.message : String(error)}`);
        });
        const result = await backUp(deps, keys, snapshotId, page, manifestMax, now, log);
        await rm(openFile(deps.stateDir, deps.connectorId), { force: true }).catch(() => { });
        return result;
    }
    catch (error) {
        // Not told (offline, killed): remembered, given up by the next run, and by the server within a day anyway.
        await giveUp(deps, snapshotId, failureReasonOf(error)).catch(() => { });
        throw error;
    }
}
async function backUp(deps, keys, snapshotId, page, manifestMax, now, log) {
    const { roots, workspaceDirs } = backupRoots(deps.stateDir, deps.workspaces);
    const walked = await walkBackupFiles(roots, { now: now(), configPath: deps.configPath, workspaceDirs });
    const index = await loadIndex(deps.stateDir, deps.connectorId, keys.keyId);
    const known = new Map();
    for (const entry of Object.values(index.files))
        for (const chunk of entry.chunks ?? [])
            known.set(chunk.id, chunk);
    const nextIndex = { v: 1, key_id: keys.keyId, files: {} };
    const sender = new ChunkSender(deps, keys, snapshotId, page, deps.batchBytes ?? 64 * 1024 * 1024, deps.concurrency ?? 4);
    const files = [];
    const skipped = [...walked.skipped];
    let redacted = [];
    let channels = [];
    let automations = [];
    let plainBytes = 0;
    // A piece read now: sealed unless this computer sealed it before (then named with what was sent then).
    const takePiece = async (piece, reread) => {
        const id = chunkIdOf(keys, piece);
        if (sender.has(id))
            return id;
        const before = known.get(id);
        if (before) {
            await sender.add({ ...before, reread });
            return id;
        }
        const sealed = await sealChunk(keys, piece, id);
        if (sealed.size > CHUNK_MAX_BYTES)
            throw new Error("A backup piece came out larger than the server takes");
        await sender.add({ id, size: sealed.size, sha256: sealed.sha256, bytes: sealed.bytes });
        return id;
    };
    const record = (file, size, chunks) => {
        files.push({ root: file.root, path: file.path, size, mtime: Math.round(file.mtimeMs), mode: file.mode, chunks,
            ...(file.special ? { special: file.special } : {}) });
        plainBytes += size;
    };
    for (const file of walked.files) {
        if (file.special) {
            let content = null;
            if (file.special === "config") {
                const parsed = parseConfigText(await readFile(file.abs, "utf8").catch(() => ""));
                if (parsed === null) {
                    skipped.push({ root: file.root, path: file.path, reason: "config_unreadable" });
                    log.warn("openclaw.json could not be parsed, so it is not in this backup");
                    continue;
                }
                channels = channelNames(parsed);
                const clean = redactConfig(parsed);
                redacted = clean.redacted;
                content = Buffer.from(`${JSON.stringify(clean.config, null, 2)}\n`, "utf8");
            }
            else {
                const db = await sanitizedStateDb(file.abs, path.join(backupDir(deps.stateDir), "tmp")).catch((error) => {
                    log.warn(`the automations database could not be copied: ${error instanceof Error ? error.message : String(error)}`);
                    return null;
                });
                if (!db) {
                    skipped.push({ root: file.root, path: file.path, reason: "state_db_unreadable" });
                    continue;
                }
                automations = db.automations;
                content = db.bytes;
            }
            const ids = [];
            for (const piece of bufferPieces(content)) {
                const copy = Buffer.from(piece);
                ids.push(await takePiece(copy, async () => copy));
            }
            record(file, content.length, ids);
            continue;
        }
        const key = indexKey(file);
        const prior = index.files[key];
        if (prior && prior.size === file.size && prior.mtimeMs === file.mtimeMs && prior.ino === file.ino
            && Array.isArray(prior.chunks) && prior.chunks.length === Math.ceil(file.size / PIECE_MAX_BYTES)) {
            // Unchanged since the last backup: not read again.
            for (const [at, chunk] of prior.chunks.entries()) {
                if (sender.has(chunk.id))
                    continue;
                const offset = at * PIECE_MAX_BYTES;
                await sender.add({ ...chunk, reread: () => readPiece(file.abs, offset, Math.min(PIECE_MAX_BYTES, file.size - offset)) });
            }
            record(file, file.size, prior.chunks.map((chunk) => chunk.id));
            nextIndex.files[key] = prior;
            continue;
        }
        const ids = [];
        let size = 0;
        try {
            for await (const piece of filePieces(file.abs, file.size)) {
                const offset = size;
                const length = piece.length;
                ids.push(await takePiece(piece, () => readPiece(file.abs, offset, length)));
                size += piece.length;
            }
        }
        catch (error) {
            if (error instanceof BackupRefusedError || !(isRecord(error) && typeof error.code === "string"))
                throw error;
            // A file that went away or can't be read now is left out of this restore point.
            skipped.push({ root: file.root, path: file.path, reason: "unreadable" });
            continue;
        }
        record(file, size, ids);
        if (size === file.size)
            nextIndex.files[key] = { size, mtimeMs: file.mtimeMs, ino: file.ino, chunks: ids.map((id) => ({ id })) };
    }
    await sender.flush();
    // What was sent for each chunk, now that every page is answered (a resealed one has a new digest).
    for (const entry of Object.values(nextIndex.files)) {
        entry.chunks = entry.chunks.map((chunk) => sender.sealed.get(chunk.id) ?? known.get(chunk.id) ?? chunk);
    }
    const manifest = {
        v: 1, made_at: new Date(now()).toISOString(), plugin_version: PLUGIN_VERSION,
        roots: walked.roots.map((root) => ({ label: root.label, kind: root.kind, agents: [...root.agents] })),
        files, repos: walked.repos, plugins: walked.plugins, packages: walked.packages, skipped, redacted,
        agents: [...deps.agents], channels, automations, excluded: walked.excluded,
    };
    const sealedManifest = encryptManifest(keys, snapshotId, Buffer.from(JSON.stringify(manifest), "utf8"));
    if (sealedManifest.length > manifestMax)
        throw new Error("This backup's file list is larger than the server takes");
    const link = await deps.call({
        type: MANIFEST_FRAME, snapshot_id: snapshotId, size: sealedManifest.length, sha256: sha256Hex(sealedManifest),
    });
    if (typeof link.url !== "string" || !isRecord(link.headers))
        throw new Error("The Octopus Prime server sent no link for the file list");
    await putSealed(deps, link.url, Object.fromEntries(Object.entries(link.headers).map(([name, value]) => [name, String(value)])), sealedManifest);
    const committed = await deps.call({
        type: COMMIT_FRAME, snapshot_id: snapshotId, files: files.length, plain_bytes: plainBytes, chunks: sender.sealed.size,
    });
    await saveIndex(deps.stateDir, deps.connectorId, nextIndex).catch((error) => {
        log.warn(`the backup's local index was not saved: ${error instanceof Error ? error.message : String(error)}`);
    });
    return {
        snapshot_id: snapshotId, files: files.length, plain_bytes: plainBytes, chunks: sender.sealed.size,
        uploaded: sender.uploaded, uploaded_bytes: sender.uploadedBytes,
        snapshot: isRecord(committed.snapshot) ? committed.snapshot : null,
    };
}
/**
 * What a backup would take, by the same walk with the same exclusions, with
 * no network at all: the total size, how many files, the 5 largest
 * first-level folders across the roots, and the smallest plan that holds it
 * (null over 100 GB).
 */
export async function estimateBackup(place) {
    const { roots, workspaceDirs } = backupRoots(place.stateDir, place.workspaces);
    const walked = await walkBackupFiles(roots, { now: (place.now ?? Date.now)(), configPath: place.configPath, workspaceDirs });
    const folders = new Map();
    let total = 0;
    for (const file of walked.files) {
        total += file.size;
        const slash = file.path.indexOf("/");
        const folder = slash === -1 ? `${file.root} (files at the top)` : `${file.root}/${file.path.slice(0, slash)}`;
        folders.set(folder, (folders.get(folder) ?? 0) + file.size);
    }
    return {
        total_bytes: total,
        files: walked.files.length,
        top_folders: [...folders.entries()].map(([folder, bytes]) => ({ path: folder, bytes }))
            .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 5),
        plan: planFit(total),
        excluded: walked.excluded,
        repos: walked.repos.length,
        plugins: walked.plugins.length,
        skipped: walked.skipped.length,
    };
}
const counted = (count, noun) => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
/** The estimate as the agent (octopus_backup) and the CLI tell it: facts only. */
export function estimateText(estimate) {
    const lines = [
        `An Octopus Prime Agent Backup of this Gateway would be about ${sizeText(estimate.total_bytes)} in ${counted(estimate.files, "file")}`
            + " (before compression; secrets, sign-ins, dependencies, caches and repositories with a remote are left out).",
    ];
    if (estimate.top_folders.length > 0) {
        lines.push("Largest folders:");
        for (const folder of estimate.top_folders)
            lines.push(`- ${folder.path}: ${sizeText(folder.bytes)}`);
    }
    if (estimate.plan) {
        const plan = BACKUP_PLANS.find((candidate) => candidate.key === estimate.plan?.key);
        lines.push(`Plan that fits: ${estimate.plan.name}${plan
            ? ` ($${plan.monthly_usd} a month, backs up ${plan.every}, keeps restore points ${plan.keep_days} days)` : ""}.`);
    }
    else {
        lines.push("No Backup plan fits: it is over 100 GB.");
    }
    const notes = [
        estimate.repos ? `${counted(estimate.repos, "repository")} with a remote would be recorded, not copied` : "",
        estimate.plugins ? `${counted(estimate.plugins, "plugin")} would be listed to install again` : "",
        estimate.skipped ? `${counted(estimate.skipped, "file")} over 100 MB would be skipped` : "",
    ].filter(Boolean);
    if (notes.length > 0)
        lines.push(`${notes.join("; ")}.`);
    return lines.join("\n");
}
export async function listMachines(call) {
    const answer = await call({ type: MACHINES_FRAME });
    return (Array.isArray(answer.machines) ? answer.machines : []).filter(isRecord)
        .filter((machine) => typeof machine.connector_id === "string")
        .map((machine) => ({
        connector_id: machine.connector_id,
        name: typeof machine.name === "string" ? machine.name : "Gateway",
        this: machine.this === true, removed: machine.removed === true,
        last_backup_at: typeof machine.last_backup_at === "string" ? machine.last_backup_at : null,
    }));
}
/** Whether `a` comes after `b` in the server's order, which is the order of a page's points. */
function olderThan(a, b) {
    const [x, y] = [a.made_at ?? "", b.made_at ?? ""];
    return x < y || (x === y && a.snapshot_id < b.snapshot_id);
}
/**
 * The restore points of a Gateway, newest first, at most 100 a page: the newest
 * page, or with `before` the page of points older than that one. A backend that
 * does not know `before` answers its newest page again; only points really older
 * than `before` are kept, so it gives an empty page and no `more`, never a loop.
 */
export async function listPointsPage(call, connectorId, before) {
    if (before && before.made_at === null)
        return { points: [], more: false };
    const answer = await call({
        type: POINTS_FRAME, connector_id: connectorId,
        ...(before ? { before: { made_at: before.made_at, snapshot_id: before.snapshot_id } } : {}),
    });
    const points = (Array.isArray(answer.points) ? answer.points : []).filter(isRecord)
        .filter((point) => typeof point.snapshot_id === "string")
        .map((point) => ({
        snapshot_id: point.snapshot_id,
        made_at: typeof point.made_at === "string" ? point.made_at : null,
        files: typeof point.files === "number" ? point.files : 0,
        bytes: typeof point.bytes === "number" ? point.bytes : 0,
        kind: typeof point.kind === "string" ? point.kind : "scheduled",
    }))
        .filter((point) => !before || olderThan(point, before));
    return { points, more: answer.more === true && points.length > 0 };
}
/** The newest page of restore points (what a backend that does not page lists, and the most the picker offers at first). */
export async function listPoints(call, connectorId) {
    return (await listPointsPage(call, connectorId)).points;
}
/** A page limit for findPoint: 100 pages are 10,000 points, more than any plan keeps (Backup 100 GB: 2,160). */
const POINT_PAGES_MAX = 100;
const POINT_PAGE_GAP_MS = 250;
/**
 * One restore point of a Gateway by its id, however old: the newest page first
 * (`first`, when the caller already has it), then each older page until the id
 * is on one, the server says there are no more or a page is the last the limit allows. null: not found.
 */
export async function findPoint(call, connectorId, snapshotId, first) {
    let page = first ?? await listPointsPage(call, connectorId);
    for (let pages = 1;; pages += 1) {
        const found = page.points.find((point) => point.snapshot_id === snapshotId);
        if (found)
            return found;
        if (!page.more || pages >= POINT_PAGES_MAX)
            return null;
        // The server lets a Gateway make 5 backup calls a second after a burst of 20 (a 429 ends the restore): 4 a second at most.
        await new Promise((resolve) => setTimeout(resolve, POINT_PAGE_GAP_MS));
        page = await listPointsPage(call, connectorId, page.points[page.points.length - 1]);
    }
}
/** Files that are already there and would be overwritten: a restore without `overwrite` stops before writing anything. */
export class RestoreConflictError extends Error {
    paths;
    constructor(paths) {
        super(`${paths.length.toLocaleString("en-US")} file${paths.length === 1 ? " is" : "s are"} already on this computer `
            + "(for example " + paths.slice(0, 3).join(", ") + "). Nothing was written. Restore into an empty OpenClaw, "
            + "or pass --overwrite to replace them.");
        this.paths = paths;
    }
}
function checkedManifest(value) {
    const bad = () => new Error("The backup's file list can't be read");
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.files) || !Array.isArray(value.roots))
        throw bad();
    for (const file of value.files) {
        if (!isRecord(file) || typeof file.root !== "string" || typeof file.path !== "string" || typeof file.size !== "number"
            || !Array.isArray(file.chunks) || file.chunks.some((id) => typeof id !== "string" || !HEX64.test(id)))
            throw bad();
    }
    const list = (name) => (Array.isArray(value[name]) ? value[name] : []);
    return {
        v: 1, made_at: typeof value.made_at === "string" ? value.made_at : "", plugin_version: String(value.plugin_version ?? ""),
        roots: list("roots").filter(isRecord).filter((root) => typeof root.label === "string")
            .map((root) => ({
            label: root.label, kind: root.kind === "workspace" ? "workspace" : "state",
            agents: Array.isArray(root.agents) ? root.agents.filter((id) => typeof id === "string") : [],
        })),
        files: value.files,
        repos: list("repos").filter(isRecord),
        plugins: list("plugins").filter(isRecord),
        packages: list("packages").filter(isRecord),
        skipped: list("skipped").filter(isRecord),
        redacted: list("redacted").filter((name) => typeof name === "string"),
        agents: list("agents").filter((name) => typeof name === "string"),
        channels: list("channels").filter((name) => typeof name === "string"),
        automations: list("automations").filter((name) => typeof name === "string"),
        excluded: isRecord(value.excluded) ? value.excluded : {},
    };
}
/** A manifest path below its root on this computer, or null when it would leave it. */
function targetPath(rootDir, relative) {
    if (!relative || relative.includes("\0") || relative.includes("\\") || relative.startsWith("/"))
        return null;
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === ".."))
        return null;
    const target = path.resolve(rootDir, ...parts);
    const back = path.relative(path.resolve(rootDir), target);
    return back && !back.startsWith("..") && !path.isAbsolute(back) ? target : null;
}
const exists = (file) => existsSync(file);
/** The Sign-in checklist: names only, never a value. */
export function signInChecklist(manifest) {
    const names = [
        ...manifest.redacted.map((name) => `Setting ${name}`),
        ...manifest.agents.map((id) => `Model provider sign-ins for agent ${id}`),
        ...manifest.channels.map((name) => `Channel ${name}`),
    ].map((name) => name.trim().slice(0, NAME_MAX)).filter(Boolean);
    return [...new Set(names)].slice(0, SIGN_IN_MAX);
}
const shellQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
/** OCTOPUS-REBUILD-KIT.md: what to install again and sign in to again, for the owner and the agent. */
export function rebuildKit(params) {
    const { manifest } = params;
    const where = (root, relative) => {
        const base = params.rootDirs.get(root);
        return base ? path.join(base, ...relative.split("/")) : `${root}/${relative}`;
    };
    const lines = [
        "# Octopus Prime rebuild kit",
        "",
        `This OpenClaw was restored from an Octopus Prime backup${params.pointMadeAt ? ` made ${params.pointMadeAt}` : ""}.`,
        "Work through this list, then delete this file. Never paste passwords or tokens into a chat.",
        "",
        "## Repositories to clone",
        "",
    ];
    if (manifest.repos.length === 0)
        lines.push("None.");
    for (const repo of manifest.repos) {
        const remote = repo.remotes.find((r) => r.name === "origin") ?? repo.remotes[0];
        const target = where(repo.root, repo.path);
        lines.push(`- ${repo.root}/${repo.path}${repo.branch ? ` (branch ${repo.branch})` : ""}${repo.head ? `, was at ${repo.head.slice(0, 12)}` : ""}`);
        lines.push("  ```sh", `  git clone ${shellQuote(remote.url)} ${shellQuote(target)}`);
        if (repo.branch)
            lines.push(`  git -C ${shellQuote(target)} checkout ${shellQuote(repo.branch)}`);
        for (const other of repo.remotes.filter((r) => r !== remote)) {
            lines.push(`  git -C ${shellQuote(target)} remote add ${shellQuote(other.name)} ${shellQuote(other.url)}`);
        }
        lines.push("  ```");
    }
    lines.push("", "## Plugins to install", "");
    const plugins = manifest.plugins.filter((plugin) => plugin.name !== "@octopusprime/openclaw-channel-plugin");
    if (plugins.length === 0)
        lines.push("None.");
    for (const plugin of plugins)
        lines.push(`- \`openclaw plugins install ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}\``);
    lines.push("", "## Packages to install again", "");
    if (manifest.packages.length === 0)
        lines.push("None.");
    for (const pkg of manifest.packages) {
        const dir = where(pkg.root, pkg.path === "." ? "" : pkg.path).replace(/[\\/]$/, "");
        const commands = pkg.kinds.map((kind) => (kind === "npm" ? "npm install" : "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt (or pip install . for pyproject.toml)"));
        lines.push(`- In ${dir}: ${commands.join("; ")}`);
    }
    lines.push("", "## Files that were not backed up", "");
    if (manifest.skipped.length === 0)
        lines.push("None.");
    for (const item of manifest.skipped) {
        const why = item.reason === "too_large" ? "over 100 MB" : item.reason.replace(/_/g, " ");
        lines.push(`- ${item.root}/${item.path} (${why})`);
    }
    lines.push("", "## Automations", "");
    if (params.automations.names.length === 0)
        lines.push("None.");
    else {
        lines.push(params.automations.importable
            ? `${params.automations.imported} imported into this OpenClaw (those it already had were kept):`
            : "Not imported (this OpenClaw has no automations database of the same version yet); the sanitized copy is in "
                + "octopus-restore/state-openclaw.sqlite under the state folder:");
        for (const name of params.automations.names)
            lines.push(`- ${name}`);
    }
    lines.push("", "## Sign-in checklist", "", "Sign in again to each of these (no password, key or token was backed up):", "");
    if (params.signIn.length === 0)
        lines.push("Nothing to sign in to again.");
    for (const name of params.signIn)
        lines.push(`- [ ] ${name}`);
    lines.push("");
    return lines.join("\n");
}
/**
 * One restore (docs/AGENT-BACKUP.md §8): the key envelope opened with the
 * passphrase or the recovery key (its key id checked), the manifest and every
 * chunk downloaded and checked (tag and id), the files written into this
 * computer's state dir and workspaces with their modes and times. An existing
 * file is never overwritten without `overwrite`: then nothing is written at
 * all. openclaw.json is merged (the current one saved first as
 * openclaw.json.before-restore), the automations imported, and the rebuild kit
 * written into the main workspace; the server is told what to sign in to
 * again (names only, backup.restored).
 */
export async function restoreBackup(deps) {
    const log = deps.log ?? quiet;
    const notes = [];
    const answer = await deps.call({ type: KEYS_FRAME, connector_id: deps.connectorId });
    const envelope = answer.keys;
    const dk = typeof deps.secret === "string" ? await openEnvelopeWithTyped(envelope, deps.secret) : await openEnvelope(envelope, deps.secret);
    const keys = deriveKeys(dk);
    const links = await deps.call({ type: DOWNLOAD_FRAME, connector_id: deps.connectorId, snapshot_id: deps.snapshotId, manifest: true });
    if (typeof links.manifest_url !== "string")
        throw new Error("The Octopus Prime server sent no link for the backup's file list");
    const manifest = checkedManifest(JSON.parse(decryptManifest(keys, deps.snapshotId, await deps.get(links.manifest_url)).toString("utf8")));
    const concurrency = deps.concurrency ?? 4;
    const download = async (ids) => {
        const pieces = new Map();
        for (let at = 0; at < ids.length; at += CHUNK_PAGE) {
            const pageIds = ids.slice(at, at + CHUNK_PAGE);
            const answer = await deps.call({ type: DOWNLOAD_FRAME, connector_id: deps.connectorId, snapshot_id: deps.snapshotId, chunks: pageIds });
            const urls = isRecord(answer.urls) ? answer.urls : {};
            await pool(pageIds, concurrency, async (id) => {
                const url = urls[id];
                if (typeof url !== "string")
                    throw new Error("The Octopus Prime server sent no link for a piece of this backup");
                pieces.set(id, decryptChunk(keys, id, await deps.get(url)));
            });
        }
        return pieces;
    };
    const assemble = (file, pieces) => {
        const bytes = Buffer.concat(file.chunks.map((id) => pieces.get(id)));
        if (bytes.length !== file.size)
            throw new Error("A restored file is not the size the backup says");
        return bytes;
    };
    // The config first, in memory: the workspaces' places come from it.
    const configFile = manifest.files.find((file) => file.special === "config");
    let merged = null;
    let currentText = null;
    let configMode = "none";
    if (configFile) {
        const restored = parseConfigText(assemble(configFile, await download([...new Set(configFile.chunks)])).toString("utf8"));
        if (restored === null)
            throw new Error("The backup's openclaw.json can't be read");
        currentText = exists(deps.configPath) ? await readFile(deps.configPath, "utf8") : null;
        const current = currentText === null ? {} : parseConfigText(currentText);
        if (current === null) {
            configMode = "staged";
            notes.push("This computer's openclaw.json could not be read, so it was left as it is; the backup's is in octopus-restore/openclaw.json.");
            merged = restored;
        }
        else {
            configMode = "merged";
            merged = mergeConfig(current, restored, manifest.redacted);
        }
    }
    // Where each root goes here.
    const rootDirs = new Map();
    for (const root of manifest.roots) {
        if (root.kind === "state") {
            rootDirs.set(root.label, deps.stateDir);
            continue;
        }
        let dir = null;
        for (const agent of root.agents) {
            dir = deps.resolveWorkspace && merged !== null ? deps.resolveWorkspace(merged, agent) : null;
            if (dir)
                break;
        }
        rootDirs.set(root.label, dir ?? path.join(deps.stateDir, "octopus-restore", root.label.replace(/[^A-Za-z0-9_-]/g, "_")));
    }
    // Every target first: nothing is written when one would overwrite a file without `overwrite`.
    const plain = manifest.files.filter((file) => !file.special);
    const targets = new Map();
    const conflicts = [];
    for (const file of plain) {
        const base = rootDirs.get(file.root);
        const target = base ? targetPath(base, file.path) : null;
        if (!target)
            throw new Error("The backup names a file outside its folders; it was not restored");
        targets.set(file, target);
        if (!deps.overwrite && exists(target))
            conflicts.push(`${file.root}/${file.path}`);
    }
    if (conflicts.length > 0)
        throw new RestoreConflictError(conflicts);
    // The files, a page of pieces at a time, each checked before it is written.
    let written = 0;
    const batches = [];
    let batch = [];
    let ids = new Set();
    let bytes = 0;
    for (const file of plain) {
        const more = file.chunks.filter((id) => !ids.has(id)).length;
        if (batch.length > 0 && (ids.size + more > CHUNK_PAGE || bytes + file.size > 256 * 1024 * 1024)) {
            batches.push(batch);
            batch = [];
            ids = new Set();
            bytes = 0;
        }
        batch.push(file);
        for (const id of file.chunks)
            ids.add(id);
        bytes += file.size;
    }
    if (batch.length > 0)
        batches.push(batch);
    for (const group of batches) {
        const pieces = await download([...new Set(group.flatMap((file) => file.chunks))]);
        for (const file of group) {
            const target = targets.get(file);
            const data = assemble(file, pieces);
            await mkdir(path.dirname(target), { recursive: true });
            const mode = (file.mode & 0o777) || 0o644;
            await writeFile(target, data, { flag: deps.overwrite ? "w" : "wx", mode });
            await chmod(target, mode).catch(() => { });
            const when = new Date(file.mtime);
            await utimes(target, when, when).catch(() => { });
            written += 1;
        }
    }
    // The config, once the files are in: this computer's saved first, then the merged one.
    if (configMode === "merged" && merged !== null) {
        if (currentText !== null) {
            let saved = `${deps.configPath}.before-restore`;
            if (exists(saved))
                saved = `${saved}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            await copyFile(deps.configPath, saved);
            await chmod(saved, 0o600).catch(() => { });
        }
        await mkdir(path.dirname(deps.configPath), { recursive: true });
        await writeFile(deps.configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    }
    else if (configMode === "staged" && merged !== null) {
        const staged = path.join(deps.stateDir, "octopus-restore", "openclaw.json");
        await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
        await writeFile(staged, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    }
    // The automations.
    const stateDb = manifest.files.find((file) => file.special === "state-db");
    let automations = { names: manifest.automations, imported: 0, importable: false, staged: null };
    if (stateDb) {
        const db = assemble(stateDb, await download([...new Set(stateDb.chunks)]));
        try {
            const restored = await restoreStateDb(db, deps.stateDir);
            automations = { names: restored.automations, imported: restored.imported, importable: restored.importable, staged: restored.staged };
        }
        catch (error) {
            notes.push("The automations could not be imported; the sanitized copy was not kept.");
            log.warn(`the automations were not imported: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // The rebuild kit, in the main workspace.
    const signIn = signInChecklist(manifest);
    // The first agent's workspace here, else the root that held it, else any workspace, else the default one.
    const mainAgent = manifest.agents[0];
    const mainRoot = manifest.roots.find((root) => root.kind === "workspace" && root.agents.includes(mainAgent ?? ""))
        ?? manifest.roots.find((root) => root.kind === "workspace");
    const kitDir = (merged !== null && deps.resolveWorkspace && mainAgent ? deps.resolveWorkspace(merged, mainAgent) : null)
        ?? (mainRoot ? rootDirs.get(mainRoot.label) : undefined) ?? path.join(deps.stateDir, "workspace");
    let kit = path.join(kitDir, REBUILD_KIT_FILE);
    try {
        await mkdir(kitDir, { recursive: true });
        await writeFile(kit, rebuildKit({
            manifest, pointMadeAt: deps.pointMadeAt ?? manifest.made_at, rootDirs, signIn,
            automations: { names: automations.names, imported: automations.imported, importable: automations.importable },
        }), { mode: 0o600 });
    }
    catch (error) {
        log.warn(`the rebuild kit was not written: ${error instanceof Error ? error.message : String(error)}`);
        kit = null;
    }
    const rebuild = {
        repos: manifest.repos.length,
        plugins: manifest.plugins.filter((plugin) => plugin.name !== "@octopusprime/openclaw-channel-plugin").length,
        packages: manifest.packages.length,
        skipped: manifest.skipped.length,
    };
    await deps.call({ type: RESTORED_FRAME, connector_id: deps.connectorId, snapshot_id: deps.snapshotId, sign_in: signIn, rebuild });
    let keysKept = null;
    if (deps.keepKeys) {
        try {
            await deps.call({ type: SETUP_FRAME, keys: envelope });
            await deps.keepKeys.keystore.set(deps.keepKeys.connectorId, dk);
            keysKept = true;
        }
        catch (error) {
            keysKept = false;
            notes.push(`The same keys were not kept for this computer's backups: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { sign_in: signIn, rebuild, files: written, kit, automations, config: configMode, keys_kept: keysKept, notes };
}
