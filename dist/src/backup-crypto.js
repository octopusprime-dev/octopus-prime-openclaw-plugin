import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCallback, timingSafeEqual, } from "node:crypto";
import { promisify } from "node:util";
import { deflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";
/**
 * Agent Backup's encryption (1.38.0, docs/AGENT-BACKUP.md §4). Everything is
 * encrypted here, on the computer, with Node's own node:crypto, before it
 * leaves; the server and R2 only ever hold what this module sealed.
 *
 * - Data key (DK): 32 random bytes made at setup. Its subkeys come from
 *   HKDF-SHA256 with an empty salt and the info strings
 *   "octopus-backup v1 chunk-id", "… chunk-key", "… manifest-key" and
 *   "… key-id".
 * - key_id: the first 32 hex digits of HMAC-SHA256(K_key-id, "key-id"). It
 *   lets the plugin check that the keychain's key is the envelope's key; it
 *   says nothing about DK.
 * - Passphrase wrap: scrypt(passphrase as NFC UTF-8, 16-byte salt, N=2^17,
 *   r=8, p=1) gives a 32-byte key, which seals DK with AES-256-GCM, AAD
 *   "octopus-backup v1 dk-wrap".
 * - Recovery key: 32 random bytes shown once (formatRecoveryKey). HKDF-SHA256
 *   (recovery key, its own 16-byte salt, info "octopus-backup v1 recovery-wrap")
 *   gives the key that seals DK the same way.
 * - Key envelope (what backup.setup sends; backend/agent_backup.checked_keys):
 *   {v:1, key_id, kdf:{name:"scrypt", n, r, p, salt}, passphrase:{nonce, data},
 *   recovery:{salt, nonce, data}}, standard base64, `data` the ciphertext and
 *   its 16-byte tag.
 * - Chunk: a file piece of at most 4 MiB, raw DEFLATE, then
 *   0x01 | 12-byte nonce | AES-256-GCM(K_chunk) | 16-byte tag, AAD the chunk id
 *   (ASCII). Chunk id = hex HMAC-SHA256(K_chunk-id, piece): the same piece is
 *   stored once, and the id can't be checked against a guessed file without DK.
 * - Manifest: JSON, raw DEFLATE, the same format with K_manifest, AAD the
 *   snapshot id.
 *
 * Opening a chunk checks its tag and then its id again (HMAC of what came out
 * must be the id it was asked for), so a swapped, cut or corrupted object is
 * refused, never written.
 */
export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const DATA_KEY_BYTES = 32;
export const RECOVERY_KEY_BYTES = 32;
/** A file piece: the most one chunk holds before it is compressed and sealed. */
export const PIECE_MAX_BYTES = 4 * 1024 * 1024;
export const PASSPHRASE_MIN_CHARS = 12;
const WRAP_AAD = Buffer.from("octopus-backup v1 dk-wrap", "utf8");
const INFO_CHUNK_ID = "octopus-backup v1 chunk-id";
const INFO_CHUNK_KEY = "octopus-backup v1 chunk-key";
const INFO_MANIFEST_KEY = "octopus-backup v1 manifest-key";
const INFO_KEY_ID = "octopus-backup v1 key-id";
const INFO_RECOVERY = "octopus-backup v1 recovery-wrap";
const RECOVERY_CHECK = "octopus-backup v1 recovery-check";
const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
// What an opened manifest may inflate to (its sealed form is at most 64 MiB).
const MANIFEST_PLAIN_MAX = 1024 * 1024 * 1024;
/** The passphrase or the recovery key does not open this envelope. */
export class BackupKeyError extends Error {
    constructor(message = "That's the wrong passphrase or recovery key for this backup.") {
        super(message);
    }
}
/** An object that was swapped, cut or changed: refused, never written. */
export class BackupIntegrityError extends Error {
}
const b64 = (bytes) => bytes.toString("base64");
const deflateRawAsync = promisify(deflateRaw);
function subkey(key, info, salt = Buffer.alloc(0)) {
    return Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info, "utf8"), 32));
}
function checkDataKey(dk) {
    if (!Buffer.isBuffer(dk) || dk.length !== DATA_KEY_BYTES)
        throw new Error("A backup data key is 32 bytes");
}
export function newDataKey() {
    return randomBytes(DATA_KEY_BYTES);
}
export function keyIdOf(dk) {
    checkDataKey(dk);
    return createHmac("sha256", subkey(dk, INFO_KEY_ID)).update("key-id").digest("hex").slice(0, 32);
}
export function deriveKeys(dk) {
    checkDataKey(dk);
    return Object.freeze({
        chunkId: subkey(dk, INFO_CHUNK_ID),
        chunkKey: subkey(dk, INFO_CHUNK_KEY),
        manifestKey: subkey(dk, INFO_MANIFEST_KEY),
        keyId: keyIdOf(dk),
    });
}
export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
// AES-256-GCM: nonce | ciphertext | tag.
function seal(key, plain, aad) {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
function unseal(key, nonce, body, tag, aad) {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
}
// The sealed object format: 0x01 | nonce | ciphertext | tag.
function sealCompressed(key, compressed, aad) {
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), seal(key, compressed, aad)]);
}
function sealObject(key, plain, aad) {
    return sealCompressed(key, deflateRawSync(plain), aad);
}
function openObject(key, sealed, aad, maxPlain, what) {
    if (!Buffer.isBuffer(sealed) || sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== FORMAT_VERSION) {
        throw new BackupIntegrityError(`${what} is not in a format this plugin reads`);
    }
    let compressed;
    try {
        compressed = unseal(key, sealed.subarray(1, 1 + NONCE_BYTES), sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES), sealed.subarray(sealed.length - TAG_BYTES), aad);
    }
    catch {
        throw new BackupIntegrityError(`${what} failed its integrity check (changed, swapped or cut)`);
    }
    try {
        return inflateRawSync(compressed, { maxOutputLength: maxPlain });
    }
    catch {
        throw new BackupIntegrityError(`${what} could not be unpacked`);
    }
}
/** A piece's chunk id: hex HMAC-SHA256 with the chunk-id subkey. */
export function chunkIdOf(keys, piece) {
    return createHmac("sha256", keys.chunkId).update(piece).digest("hex");
}
/** Seals one piece: its id, the sealed bytes, and their size and SHA-256 (what the server signs the upload for). */
export function encryptChunk(keys, piece, id = chunkIdOf(keys, piece)) {
    if (piece.length > PIECE_MAX_BYTES)
        throw new Error("A backup piece is at most 4 MiB");
    const bytes = sealObject(keys.chunkKey, piece, Buffer.from(id, "ascii"));
    return { id, bytes, size: bytes.length, sha256: sha256Hex(bytes) };
}
/**
 * encryptChunk for a backup run inside the Gateway: the same sealed chunk, but
 * the compression (most of the work) runs on Node's thread pool, so the
 * Gateway's event loop is not held while a piece is packed.
 */
export async function sealChunk(keys, piece, id = chunkIdOf(keys, piece)) {
    if (piece.length > PIECE_MAX_BYTES)
        throw new Error("A backup piece is at most 4 MiB");
    const bytes = sealCompressed(keys.chunkKey, await deflateRawAsync(piece), Buffer.from(id, "ascii"));
    return { id, bytes, size: bytes.length, sha256: sha256Hex(bytes) };
}
/** Opens a chunk asked for by `id`; refuses it unless its tag and its id both check. */
export function decryptChunk(keys, id, sealed) {
    const piece = openObject(keys.chunkKey, sealed, Buffer.from(id, "ascii"), PIECE_MAX_BYTES, "A backup piece");
    const again = Buffer.from(chunkIdOf(keys, piece), "ascii");
    const asked = Buffer.from(id, "ascii");
    if (again.length !== asked.length || !timingSafeEqual(again, asked)) {
        throw new BackupIntegrityError("A backup piece is not the one asked for");
    }
    return piece;
}
export function encryptManifest(keys, snapshotId, plain) {
    return sealObject(keys.manifestKey, plain, Buffer.from(snapshotId, "utf8"));
}
export function decryptManifest(keys, snapshotId, sealed) {
    return openObject(keys.manifestKey, sealed, Buffer.from(snapshotId, "utf8"), MANIFEST_PLAIN_MAX, "The backup's file list");
}
// -- passphrase and recovery key ---------------------------------------------------------
/** Why a passphrase can't be used, or null. */
export function passphraseProblem(passphrase) {
    if ([...passphrase.normalize("NFC")].length < PASSPHRASE_MIN_CHARS) {
        return `A backup passphrase needs at least ${PASSPHRASE_MIN_CHARS} characters.`;
    }
    return null;
}
function scryptKey(passphrase, salt, n, r, p) {
    return new Promise((resolve, reject) => {
        scryptCallback(Buffer.from(passphrase.normalize("NFC"), "utf8"), salt, 32, { N: n, r, p, maxmem: 256 * n * r * p + 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
    });
}
function recoveryWrapKey(recoveryKey, salt) {
    if (!Buffer.isBuffer(recoveryKey) || recoveryKey.length !== RECOVERY_KEY_BYTES)
        throw new Error("A recovery key is 32 bytes");
    return subkey(recoveryKey, INFO_RECOVERY, salt);
}
function wrap(key, dk) {
    const sealed = seal(key, dk, WRAP_AAD);
    return { nonce: b64(sealed.subarray(0, NONCE_BYTES)), data: b64(sealed.subarray(NONCE_BYTES)) };
}
function unwrap(key, wrapped) {
    const nonce = Buffer.from(wrapped.nonce, "base64");
    const data = Buffer.from(wrapped.data, "base64");
    if (nonce.length !== NONCE_BYTES || data.length !== DATA_KEY_BYTES + TAG_BYTES)
        throw new BackupKeyError();
    try {
        return unseal(key, nonce, data.subarray(0, DATA_KEY_BYTES), data.subarray(DATA_KEY_BYTES), WRAP_AAD);
    }
    catch {
        throw new BackupKeyError();
    }
}
export async function passphraseWrap(dk, passphrase, options = {}) {
    checkDataKey(dk);
    const problem = passphraseProblem(passphrase);
    if (problem)
        throw new Error(problem);
    const n = options.n ?? SCRYPT_N;
    const salt = randomBytes(SALT_BYTES);
    const key = await scryptKey(passphrase, salt, n, SCRYPT_R, SCRYPT_P);
    return { kdf: { name: "scrypt", n, r: SCRYPT_R, p: SCRYPT_P, salt: b64(salt) }, passphrase: wrap(key, dk) };
}
export function recoveryWrap(dk, recoveryKey) {
    checkDataKey(dk);
    const salt = randomBytes(SALT_BYTES);
    return { salt: b64(salt), ...wrap(recoveryWrapKey(recoveryKey, salt), dk) };
}
/** The key envelope for backup.setup: DK wrapped by the passphrase and by the recovery key. */
export async function buildEnvelope(dk, passphrase, recoveryKey, options = {}) {
    const byPassphrase = await passphraseWrap(dk, passphrase, options);
    return { v: 1, key_id: keyIdOf(dk), ...byPassphrase, recovery: recoveryWrap(dk, recoveryKey) };
}
/** A new passphrase for the same DK: the recovery wrap stays as it was unless a new recovery key is given. */
export async function rewrapEnvelope(envelope, dk, passphrase, options = {}) {
    if (keyIdOf(dk) !== envelope.key_id)
        throw new BackupKeyError("This key isn't the backup's key.");
    const byPassphrase = await passphraseWrap(dk, passphrase, options);
    return {
        v: 1, key_id: envelope.key_id, ...byPassphrase,
        recovery: options.recoveryKey ? recoveryWrap(dk, options.recoveryKey) : { ...envelope.recovery },
    };
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
/** The envelope as a value this plugin can open, or an error saying it can't be read. */
export function checkedEnvelope(value) {
    const bad = () => new Error("This backup's key envelope can't be read");
    if (!isRecord(value) || value.v !== 1 || typeof value.key_id !== "string" || !/^[0-9a-f]{32}$/.test(value.key_id))
        throw bad();
    const { kdf, passphrase, recovery } = value;
    if (!isRecord(kdf) || kdf.name !== "scrypt" || !isText(kdf.salt))
        throw bad();
    for (const [name, low, high] of [["n", 2 ** 10, 2 ** 20], ["r", 1, 32], ["p", 1, 16]]) {
        const number = kdf[name];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < low || number > high)
            throw bad();
    }
    if (!Number.isInteger(Math.log2(kdf.n)))
        throw bad();
    if (!isRecord(passphrase) || !isText(passphrase.nonce) || !isText(passphrase.data))
        throw bad();
    if (!isRecord(recovery) || !isText(recovery.salt) || !isText(recovery.nonce) || !isText(recovery.data))
        throw bad();
    return {
        v: 1, key_id: value.key_id,
        kdf: { name: "scrypt", n: kdf.n, r: kdf.r, p: kdf.p, salt: kdf.salt },
        passphrase: { nonce: passphrase.nonce, data: passphrase.data },
        recovery: { salt: recovery.salt, nonce: recovery.nonce, data: recovery.data },
    };
}
/**
 * DK from the envelope, opened with the passphrase or the recovery key. A
 * wrong one throws BackupKeyError; a DK whose key_id is not the envelope's
 * (a swapped envelope) is refused too.
 */
export async function openEnvelope(value, secret) {
    const envelope = checkedEnvelope(value);
    let dk;
    if ("passphrase" in secret) {
        const salt = Buffer.from(envelope.kdf.salt, "base64");
        const key = await scryptKey(secret.passphrase, salt, envelope.kdf.n, envelope.kdf.r, envelope.kdf.p);
        dk = unwrap(key, envelope.passphrase);
    }
    else {
        dk = unwrap(recoveryWrapKey(secret.recoveryKey, Buffer.from(envelope.recovery.salt, "base64")), envelope.recovery);
    }
    if (keyIdOf(dk) !== envelope.key_id)
        throw new BackupKeyError("This backup's key doesn't match its key id.");
    return dk;
}
/**
 * DK from what a person typed: a recovery key if it reads as one (tried
 * first), else the passphrase. Either way a wrong one throws BackupKeyError.
 */
export async function openEnvelopeWithTyped(value, typed) {
    if (looksLikeRecoveryKey(typed)) {
        try {
            return await openEnvelope(value, { recoveryKey: parseRecoveryKey(typed) });
        }
        catch (error) {
            if (!(error instanceof BackupKeyError) && !(error instanceof RecoveryKeyFormatError))
                throw error;
        }
    }
    return openEnvelope(value, { passphrase: typed });
}
// -- the recovery key's text ----------------------------------------------------------------
/**
 * `OPRK1-` then 14 groups of 4 Crockford base32 characters: 13 groups carry
 * the 32 bytes (256 bits, padded with 4 zero bits), the last group is a
 * 20-bit checksum (the first bits of SHA-256 of a fixed label and the key),
 * which catches a typo before anything is tried. Read back in any case, with
 * or without spaces and dashes, I and L read as 1 and O as 0.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_PREFIX = "OPRK1";
const DATA_CHARS = 52;
const CHECK_CHARS = 4;
export class RecoveryKeyFormatError extends Error {
    constructor(message = "That isn't a recovery key: check it for typos.") {
        super(message);
    }
}
function base32(bytes, chars) {
    let bits = 0, value = 0, out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += CROCKFORD[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0)
        out += CROCKFORD[(value << (5 - bits)) & 31];
    return out.slice(0, chars);
}
function checksum(key) {
    const digest = createHash("sha256").update(RECOVERY_CHECK, "utf8").update(key).digest();
    return base32(digest.subarray(0, 3), CHECK_CHARS);
}
export function newRecoveryKey() {
    return randomBytes(RECOVERY_KEY_BYTES);
}
export function formatRecoveryKey(key) {
    if (!Buffer.isBuffer(key) || key.length !== RECOVERY_KEY_BYTES)
        throw new Error("A recovery key is 32 bytes");
    const text = base32(key, DATA_CHARS) + checksum(key);
    return [RECOVERY_PREFIX, ...text.match(/.{4}/g)].join("-");
}
function normalizedRecoveryText(text) {
    let squeezed = text.toUpperCase().replace(/[\s\-_.]/g, "");
    if (squeezed.length === RECOVERY_PREFIX.length + DATA_CHARS + CHECK_CHARS && /^[O0]PRK[1IL]/.test(squeezed)) {
        squeezed = squeezed.slice(RECOVERY_PREFIX.length);
    }
    return squeezed.replace(/[IL]/g, "1").replace(/O/g, "0");
}
export function looksLikeRecoveryKey(text) {
    return /^[0-9A-HJKMNP-TV-Z]{56}$/.test(normalizedRecoveryText(text));
}
export function parseRecoveryKey(text) {
    const normalized = normalizedRecoveryText(text);
    if (!/^[0-9A-HJKMNP-TV-Z]{56}$/.test(normalized))
        throw new RecoveryKeyFormatError();
    let bits = 0, value = 0;
    const bytes = [];
    for (const char of normalized.slice(0, DATA_CHARS)) {
        value = (value << 5) | CROCKFORD.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
            value &= (1 << bits) - 1;
        }
    }
    if (bytes.length !== RECOVERY_KEY_BYTES || value !== 0)
        throw new RecoveryKeyFormatError();
    const key = Buffer.from(bytes);
    if (checksum(key) !== normalized.slice(DATA_CHARS))
        throw new RecoveryKeyFormatError();
    return key;
}
/** The last group of a formatted recovery key: what the owner types back at setup. */
export function recoveryKeyLastGroup(formatted) {
    return formatted.slice(-CHECK_CHARS);
}
/** Whether what the owner typed back is the recovery key's last group (any case, I/L/O read as 1/1/0). */
export function confirmsLastGroup(formatted, typed) {
    const want = recoveryKeyLastGroup(formatted);
    const got = typed.toUpperCase().replace(/[\s\-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
    return got === want;
}
