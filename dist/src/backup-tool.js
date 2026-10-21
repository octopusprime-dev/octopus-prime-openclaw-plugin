import { defaultConnectorAccountId } from "./accounts.js";
import { BACKUP_PARAMETERS, BACKUP_TOOL, BACKUP_TOOL_DESCRIPTION, BackupRefusedError, sizeText, STATUS_FRAME, statusOf, } from "./backup.js";
import { estimateBackup, estimateText } from "./backup-engine.js";
import { placeFromConfig } from "./backup-gateway.js";
import { OCTOPUS_CHANNEL_ID } from "./runtime-config.js";
import { backupOffered, requestBackup } from "./transport.js";
export { estimateText };
function statusText(frame) {
    const status = statusOf(frame);
    if (!status.plan)
        return "This Gateway has no Backup plan. An Owner adds one in Billing on the web.";
    const parts = [`Plan: ${status.plan.name}.`];
    parts.push(!status.enabled ? "Backups are off for this Gateway." : !status.set_up
        ? "Backups are on but not set up on this computer yet (`openclaw octopus-prime backup setup`)." : "Backups are on.");
    parts.push(status.last_backup_at ? `Last backup: ${status.last_backup_at}.` : "No backup has been made yet.");
    parts.push(`Stored: ${sizeText(status.stored_bytes)} of ${sizeText(status.storage_bytes)}.`);
    if (status.enabled && status.set_up && status.due)
        parts.push("A backup is due.");
    return parts.join(" ");
}
function toolConfig(ctx) {
    try {
        return ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    }
    catch {
        return ctx.config;
    }
}
/**
 * The agent tool `octopus_backup` (1.38.0, src/backup.ts). `estimate` works on
 * any Gateway with a config, even with no plan and no Octopus Prime account:
 * it walks this computer's files exactly as a backup would and uploads
 * nothing. `status` asks this Gateway's Octopus Prime account (the turn's
 * account when it came from Octopus Prime, else the default one), on a
 * connection whose backend offers Agent Backup.
 */
export function createBackupTool(ctx) {
    const config = toolConfig(ctx);
    if (!config)
        return null;
    return {
        name: BACKUP_TOOL,
        label: "Agent Backup",
        description: BACKUP_TOOL_DESCRIPTION,
        parameters: BACKUP_PARAMETERS,
        async execute(_toolCallId, params, signal) {
            const action = params && typeof params === "object" ? params.action : undefined;
            if (action === "estimate") {
                const estimate = await estimateBackup(placeFromConfig(toolConfig(ctx) ?? config));
                return { content: [{ type: "text", text: estimateText(estimate) }], details: { ok: true, action, ...estimate } };
            }
            if (action !== "status")
                throw new Error("action must be estimate or status");
            let accountId;
            try {
                accountId = ctx.messageChannel === OCTOPUS_CHANNEL_ID && ctx.agentAccountId
                    ? ctx.agentAccountId : defaultConnectorAccountId(toolConfig(ctx) ?? config);
            }
            catch {
                accountId = "default";
            }
            if (!backupOffered(accountId)) {
                throw new Error("This Gateway's Octopus Prime connection doesn't offer Agent Backup right now (not connected, or the server doesn't have it).");
            }
            let frame;
            try {
                frame = await requestBackup({ type: STATUS_FRAME }, { accountId, signal });
            }
            catch (error) {
                if (error instanceof BackupRefusedError)
                    throw new Error(error.message);
                throw error;
            }
            return { content: [{ type: "text", text: statusText(frame) }], details: { ok: true, action, ...statusOf(frame) } };
        },
    };
}
