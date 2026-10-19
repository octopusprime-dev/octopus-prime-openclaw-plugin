import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
function parseJson(value, label) {
    if (value === null)
        throw new Error(`Missing ${label}`);
    return JSON.parse(value);
}
function optionalJson(value) {
    return value === null ? undefined : JSON.parse(value);
}
function finiteInteger(value, fallback) {
    return Number.isSafeInteger(value) ? value : fallback;
}
/**
 * External-plugin durable ingress queue.
 *
 * OpenClaw 2026.9.7 exposes its host queue only to bundled/trusted-official
 * plugins. This implementation preserves the public ChannelIngressQueue
 * contract for a normal third-party install using Node's built-in SQLite.
 */
export class SqliteIngressQueue {
    #db;
    #channelId;
    #accountId;
    #queueName;
    #now;
    constructor(options) {
        this.#channelId = options.channelId.trim();
        this.#accountId = options.accountId?.trim() || "default";
        if (!this.#channelId)
            throw new Error("channelId is required");
        this.#queueName = JSON.stringify([this.#channelId, this.#accountId]);
        this.#now = options.now ?? Date.now;
        mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
        this.#db = new DatabaseSync(options.path);
        // Install the lock wait before the journal-mode write. Concurrent Gateway
        // workers may open the same queue at startup; the reverse order races.
        this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ingress_events (
        queue_name TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','failed')),
        payload_json TEXT,
        metadata_json TEXT,
        completed_metadata_json TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lane_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_error TEXT,
        claim_token TEXT,
        claim_owner TEXT,
        claimed_at INTEGER,
        terminal_at INTEGER,
        terminal_reason TEXT,
        terminal_message TEXT,
        PRIMARY KEY (queue_name, event_id)
      );
      CREATE INDEX IF NOT EXISTS ingress_events_pending_order
        ON ingress_events(queue_name, status, received_at, event_id);
      CREATE INDEX IF NOT EXISTS ingress_events_claim_age
        ON ingress_events(queue_name, status, claimed_at);
      CREATE INDEX IF NOT EXISTS ingress_events_terminal_age
        ON ingress_events(queue_name, status, terminal_at);
    `);
        chmodSync(options.path, 0o600);
    }
    close() {
        this.#db.close();
    }
    #transaction(run) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const value = run();
            this.#db.exec("COMMIT");
            return value;
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    #ref(value) {
        if (typeof value === "string")
            return { id: value };
        return { id: value.id, ...value.claim?.token ? { token: value.claim.token } : {} };
    }
    #row(id) {
        return this.#db.prepare("SELECT * FROM ingress_events WHERE queue_name = ? AND event_id = ?")
            .get(this.#queueName, id);
    }
    #pending(row) {
        const metadata = optionalJson(row.metadata_json);
        return {
            id: row.event_id,
            channelId: row.channel_id,
            accountId: row.account_id,
            queueName: row.queue_name,
            payload: parseJson(row.payload_json, `payload for ${row.event_id}`),
            ...(metadata === undefined ? {} : { metadata }),
            receivedAt: row.received_at,
            updatedAt: row.updated_at,
            ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
            attempts: row.attempts,
            ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
            ...(row.last_error === null ? {} : { lastError: row.last_error }),
        };
    }
    #claim(row) {
        if (!row.claim_token || !row.claim_owner || row.claimed_at === null) {
            throw new Error(`Corrupt claim identity for ${row.event_id}`);
        }
        return {
            ...this.#pending(row),
            claim: {
                token: row.claim_token,
                ownerId: row.claim_owner,
                claimedAt: row.claimed_at,
            },
        };
    }
    #completed(row) {
        const metadata = optionalJson(row.completed_metadata_json);
        return {
            id: row.event_id,
            channelId: row.channel_id,
            accountId: row.account_id,
            queueName: row.queue_name,
            completedAt: row.terminal_at ?? row.updated_at,
            ...(metadata === undefined ? {} : { metadata }),
        };
    }
    #failed(row) {
        return {
            id: row.event_id,
            channelId: row.channel_id,
            accountId: row.account_id,
            queueName: row.queue_name,
            failedAt: row.terminal_at ?? row.updated_at,
            reason: row.terminal_reason ?? "unknown",
            ...(row.terminal_message === null ? {} : { message: row.terminal_message }),
        };
    }
    #deadLetter(row) {
        let payload;
        let metadata;
        try {
            payload = optionalJson(row.payload_json);
        }
        catch { /* retained as unrecoverable */ }
        try {
            metadata = optionalJson(row.metadata_json);
        }
        catch { /* retained as unrecoverable */ }
        return {
            ...this.#failed(row),
            ...(payload === undefined ? {} : { payload }),
            ...(metadata === undefined ? {} : { metadata }),
            receivedAt: row.received_at,
            updatedAt: row.updated_at,
            ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
            attempts: row.attempts,
            ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
        };
    }
    async enqueue(id, payload, options = {}) {
        const eventId = id.trim();
        if (!eventId)
            throw new Error("event id is required");
        return this.#transaction(() => {
            const at = finiteInteger(options.receivedAt ?? this.#now(), this.#now());
            const result = this.#db.prepare(`
        INSERT OR IGNORE INTO ingress_events (
          queue_name, event_id, channel_id, account_id, status,
          payload_json, metadata_json, received_at, updated_at, lane_key
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(this.#queueName, eventId, this.#channelId, this.#accountId, JSON.stringify(payload), options.metadata === undefined ? null : JSON.stringify(options.metadata), at, at, options.laneKey ?? null);
            const row = this.#row(eventId);
            if (!row)
                throw new Error(`Queue insert vanished for ${eventId}`);
            if (Number(result.changes) === 1)
                return { kind: "accepted", duplicate: false, record: this.#pending(row) };
            if (row.status === "pending")
                return { kind: "pending", duplicate: true, record: this.#pending(row) };
            if (row.status === "claimed")
                return { kind: "claimed", duplicate: true, record: this.#claim(row) };
            if (row.status === "completed")
                return { kind: "completed", duplicate: true, record: this.#completed(row) };
            return { kind: "failed", duplicate: true, record: this.#failed(row) };
        });
    }
    async listPending(options = {}) {
        const order = options.orderBy === "id" ? "event_id" : "received_at, event_id";
        const rows = this.#db.prepare(`SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'pending' ORDER BY ${order}`)
            .all(this.#queueName);
        const limit = options.limit === undefined || options.limit === "all" ? rows.length : Math.max(0, options.limit);
        return rows.slice(0, limit).map((row) => this.#pending(row));
    }
    async listClaims() {
        return this.#db.prepare("SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'claimed' ORDER BY claimed_at, event_id")
            .all(this.#queueName).map((row) => this.#claim(row));
    }
    async listUnsettled(options = {}) {
        return this.#transaction(() => ({
            pending: this.#db.prepare(`SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'pending' ORDER BY ${options.orderBy === "id" ? "event_id" : "received_at, event_id"}`)
                .all(this.#queueName).map((row) => this.#pending(row)),
            claims: this.#db.prepare("SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'claimed' ORDER BY claimed_at, event_id")
                .all(this.#queueName).map((row) => this.#claim(row)),
        }));
    }
    async listFailed(options = {}) {
        const rows = this.#db.prepare("SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'failed' ORDER BY terminal_at, event_id")
            .all(this.#queueName);
        const limit = options.limit === undefined || options.limit === "all" ? rows.length : Math.max(0, options.limit);
        return rows.slice(0, limit).map((row) => this.#deadLetter(row));
    }
    async claimNext(options = {}) {
        if (options.staleMs !== undefined)
            await this.recoverStaleClaims({ staleMs: options.staleMs });
        return this.#transaction(() => {
            const candidateIds = options.candidateIds === undefined ? null : new Set([...options.candidateIds]);
            if (candidateIds?.size === 0)
                return null;
            const blocked = new Set(options.blockedLaneKeys ?? []);
            const rows = this.#db.prepare(`SELECT * FROM ingress_events WHERE queue_name = ? AND status = 'pending' ORDER BY ${options.orderBy === "id" ? "event_id" : "received_at, event_id"}`)
                .all(this.#queueName);
            const scanLimit = Math.max(1, options.scanLimit ?? rows.length);
            for (const row of rows.slice(0, scanLimit)) {
                if (candidateIds && !candidateIds.has(row.event_id))
                    continue;
                const record = this.#pending(row);
                const derived = options.deriveLaneKey?.(record);
                let laneKey = record.laneKey ?? derived;
                if (record.laneKey && derived && record.laneKey !== derived && options.reconcileStoredLaneKey?.(record, record.laneKey, derived))
                    laneKey = derived;
                if (laneKey && blocked.has(laneKey))
                    continue;
                return this.#claimRow(row, options.ownerId, laneKey);
            }
            return null;
        });
    }
    async claim(id, options = {}) {
        return this.#transaction(() => {
            const row = this.#row(id);
            return !row || row.status !== "pending" ? null : this.#claimRow(row, options.ownerId, row.lane_key ?? undefined);
        });
    }
    #claimRow(row, ownerId = `octopus:${process.pid}`, laneKey) {
        const token = randomUUID();
        const at = this.#now();
        const changed = this.#db.prepare(`
      UPDATE ingress_events
      SET status = 'claimed', claim_token = ?, claim_owner = ?, claimed_at = ?, updated_at = ?, lane_key = ?
      WHERE queue_name = ? AND event_id = ? AND status = 'pending'
    `).run(token, ownerId, at, at, laneKey ?? null, this.#queueName, row.event_id);
        if (Number(changed.changes) !== 1)
            throw new Error(`Claim race for ${row.event_id}`);
        const claimed = this.#row(row.event_id);
        if (!claimed)
            throw new Error(`Claim vanished for ${row.event_id}`);
        return this.#claim(claimed);
    }
    async refreshClaim(claim, options = {}) {
        const at = options.refreshedAt ?? this.#now();
        const result = this.#db.prepare(`
      UPDATE ingress_events SET claimed_at = ?, updated_at = ?
      WHERE queue_name = ? AND event_id = ? AND status = 'claimed' AND claim_token = ?
    `).run(at, at, this.#queueName, claim.id, claim.claim.token);
        return Number(result.changes) === 1;
    }
    async complete(idOrClaim, options = {}) {
        const ref = this.#ref(idOrClaim);
        const at = options.completedAt ?? this.#now();
        const result = this.#db.prepare(`
      UPDATE ingress_events SET
        status = 'completed', updated_at = ?, terminal_at = ?, completed_metadata_json = ?,
        claim_token = NULL, claim_owner = NULL, claimed_at = NULL,
        terminal_reason = NULL, terminal_message = NULL
      WHERE queue_name = ? AND event_id = ? AND status IN ('pending','claimed')
        AND (? IS NULL OR claim_token = ?)
    `).run(at, at, options.metadata === undefined ? null : JSON.stringify(options.metadata), this.#queueName, ref.id, ref.token ?? null, ref.token ?? null);
        return Number(result.changes) === 1;
    }
    async release(idOrClaim, options = {}) {
        const ref = this.#ref(idOrClaim);
        const at = options.releasedAt ?? this.#now();
        const recordAttempt = options.recordAttempt !== false;
        const result = this.#db.prepare(`
      UPDATE ingress_events SET
        status = 'pending', updated_at = ?,
        attempts = attempts + ?, last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
        last_error = COALESCE(?, last_error),
        claim_token = NULL, claim_owner = NULL, claimed_at = NULL
      WHERE queue_name = ? AND event_id = ? AND status = 'claimed'
        AND (? IS NULL OR claim_token = ?)
    `).run(at, recordAttempt ? 1 : 0, recordAttempt ? 1 : 0, at, options.lastError ?? null, this.#queueName, ref.id, ref.token ?? null, ref.token ?? null);
        return Number(result.changes) === 1;
    }
    async fail(idOrClaim, options) {
        const ref = this.#ref(idOrClaim);
        const at = options.failedAt ?? this.#now();
        const result = this.#db.prepare(`
      UPDATE ingress_events SET
        status = 'failed', updated_at = ?, terminal_at = ?, terminal_reason = ?, terminal_message = ?,
        claim_token = NULL, claim_owner = NULL, claimed_at = NULL
      WHERE queue_name = ? AND event_id = ? AND status = 'claimed'
        AND (? IS NULL OR claim_token = ?)
    `).run(at, at, options.reason, options.message ?? null, this.#queueName, ref.id, ref.token ?? null, ref.token ?? null);
        return Number(result.changes) === 1;
    }
    async delete(idOrClaim) {
        const ref = this.#ref(idOrClaim);
        const result = this.#db.prepare(`
      DELETE FROM ingress_events WHERE queue_name = ? AND event_id = ?
        AND (? IS NULL OR (status = 'claimed' AND claim_token = ?))
    `).run(this.#queueName, ref.id, ref.token ?? null, ref.token ?? null);
        return Number(result.changes) === 1;
    }
    async recoverStaleClaims(options = {}) {
        const now = options.now ?? this.#now();
        const cutoff = now - Math.max(0, options.staleMs ?? 0);
        const rows = this.#db.prepare(`
      SELECT * FROM ingress_events
      WHERE queue_name = ? AND status = 'claimed' AND claimed_at <= ?
      ORDER BY claimed_at, event_id
    `).all(this.#queueName, cutoff);
        let recovered = 0;
        for (const row of rows) {
            let allowed = true;
            try {
                const claim = this.#claim(row);
                if (options.shouldRecover)
                    allowed = await options.shouldRecover(claim);
            }
            catch {
                if (options.shouldRecoverCorrupt) {
                    allowed = await options.shouldRecoverCorrupt({
                        id: row.event_id,
                        channelId: row.channel_id,
                        accountId: row.account_id,
                        queueName: row.queue_name,
                        ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
                        reason: "corrupt_payload",
                        claim: {
                            token: row.claim_token ?? "",
                            ownerId: row.claim_owner ?? "",
                            claimedAt: row.claimed_at ?? 0,
                        },
                    });
                }
                else if (options.shouldRecover)
                    allowed = false;
            }
            if (!allowed || !row.claim_token)
                continue;
            const result = this.#db.prepare(`
        UPDATE ingress_events SET status = 'pending', updated_at = ?, claim_token = NULL, claim_owner = NULL, claimed_at = NULL
        WHERE queue_name = ? AND event_id = ? AND status = 'claimed' AND claim_token = ? AND claimed_at <= ?
      `).run(now, this.#queueName, row.event_id, row.claim_token, cutoff);
            recovered += Number(result.changes);
        }
        return recovered;
    }
    async prune(options = {}) {
        const now = options.now ?? this.#now();
        const protectedIds = new Set(options.protectIds ?? []);
        return this.#transaction(() => {
            const rows = this.#db.prepare("SELECT * FROM ingress_events WHERE queue_name = ? ORDER BY updated_at, event_id")
                .all(this.#queueName);
            const ttlFor = (row) => row.status === "completed" ? options.completedTtlMs : row.status === "failed" ? options.failedTtlMs : options.pendingTtlMs;
            const maxFor = (status) => status === "completed" ? options.completedMaxEntries : status === "failed" ? options.failedMaxEntries : options.pendingMaxEntries;
            const remove = new Set();
            for (const row of rows) {
                const ttl = ttlFor(row);
                if (ttl !== undefined && now - row.updated_at >= ttl && !protectedIds.has(row.event_id))
                    remove.add(row.event_id);
            }
            for (const status of ["pending", "claimed", "completed", "failed"]) {
                const max = maxFor(status);
                if (max === undefined)
                    continue;
                const eligible = rows.filter((row) => row.status === status && !remove.has(row.event_id) && !protectedIds.has(row.event_id));
                for (const row of eligible.slice(0, Math.max(0, eligible.length - max)))
                    remove.add(row.event_id);
            }
            let deleted = 0;
            for (const id of remove)
                deleted += Number(this.#db.prepare("DELETE FROM ingress_events WHERE queue_name = ? AND event_id = ?").run(this.#queueName, id).changes);
            return deleted;
        });
    }
    async resubmit(id, options = {}) {
        return this.#transaction(() => {
            const row = this.#row(id);
            if (!row)
                return { kind: "not-found" };
            if (row.status === "completed")
                return { kind: "completed", record: this.#completed(row) };
            if (row.status === "pending" || row.status === "claimed")
                return { kind: "active", status: row.status };
            const previous = this.#deadLetter(row);
            if (previous.payload === undefined)
                return { kind: "unrecoverable", record: previous };
            const at = options.resubmittedAt ?? this.#now();
            this.#db.prepare(`
        UPDATE ingress_events SET status = 'pending', updated_at = ?, terminal_at = NULL,
          terminal_reason = NULL, terminal_message = NULL, last_error = NULL
        WHERE queue_name = ? AND event_id = ? AND status = 'failed'
      `).run(at, this.#queueName, id);
            const pending = this.#row(id);
            if (!pending)
                throw new Error(`Resubmitted event vanished for ${id}`);
            return { kind: "resubmitted", record: this.#pending(pending), previous };
        });
    }
    async purge(options = {}) {
        options.signal?.throwIfAborted();
        const result = this.#db.prepare("DELETE FROM ingress_events WHERE queue_name = ?").run(this.#queueName);
        options.signal?.throwIfAborted();
        return Number(result.changes);
    }
}
