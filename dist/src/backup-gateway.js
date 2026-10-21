import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { BackupScheduler, getObject, putObject } from "./backup.js";
import { backupDir, runBackup } from "./backup-engine.js";
import { keyIdOf } from "./backup-crypto.js";
import { systemKeystore } from "./backup-keystore.js";
export function placeFromConfig(cfg, env = process.env, resolvers = {}) {
    const stateDir = (resolvers.stateDir ?? ((e) => resolveStateDir(e)))(env);
    const configPath = (resolvers.configPath ?? ((e, dir) => resolveConfigPath(e, dir)))(env, stateDir);
    const config = cfg ?? {};
    let agents = [];
    try {
        agents = (resolvers.agents ?? listAgentIds)(config);
    }
    catch {
        agents = [];
    }
    const workspaces = [];
    for (const agentId of agents) {
        try {
            const dir = (resolvers.workspace ?? ((c, id, e) => resolveAgentWorkspaceDir(c, id, e)))(config, agentId, env);
            if (typeof dir === "string" && dir)
                workspaces.push({ agentId, dir });
        }
        catch { /* an agent without a workspace here */ }
    }
    return { stateDir, configPath, workspaces, agents };
}
/** This computer's keychain (Windows keeps its DPAPI blobs under the state dir), or null: no backups here. */
export function computerKeystore(stateDir, platform = process.platform) {
    return systemKeystore(platform, { dir: path.join(backupDir(stateDir), "keys") });
}
/** Whether this computer's keychain holds the key with this id under `name`. */
export async function keystoreHolds(keystore, name, keyId) {
    if (!keystore)
        return false;
    try {
        const key = await keystore.get(name);
        return Boolean(key) && keyIdOf(key) === keyId;
    }
    catch {
        return false;
    }
}
/**
 * One account's scheduled backups on a running Gateway: a BackupScheduler
 * whose backups read this computer's places when they run and keep the key in
 * this computer's keychain under the account's connector id.
 */
export function createGatewayBackup(options) {
    let keystore = options.keystore;
    const keychain = () => {
        if (keystore === undefined)
            keystore = computerKeystore(resolveStateDir(process.env));
        return keystore;
    };
    return new BackupScheduler({
        call: options.call,
        log: options.log,
        everyMs: options.everyMs,
        firstMs: options.firstMs,
        hasKey: (keyId) => keystoreHolds(keychain(), options.connectorId(), keyId),
        run: async (kind, status) => {
            if (options.run)
                return options.run(kind);
            const store = keychain();
            if (!store)
                throw new Error("This computer has no keychain the plugin can use, so it can't back up");
            const fetchFn = options.fetch();
            const result = await runBackup({
                ...placeFromConfig(options.config()),
                connectorId: options.connectorId(),
                keystore: store,
                kind,
                status,
                call: options.call,
                put: (url, headers, bytes) => putObject(fetchFn, url, headers, bytes),
                get: (url) => getObject(fetchFn, url),
                log: options.log,
            });
            options.log.info(`backed up ${result.files} files (${result.uploaded} new pieces uploaded)`);
            return result;
        },
    });
}
