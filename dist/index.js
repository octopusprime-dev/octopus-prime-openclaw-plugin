/**
 * Octopus Prime — OpenClaw Channel Plugin
 * Entry point. Registers the channel plugin with the OpenClaw host.
 *
 * Architecture: this plugin runs INSIDE the customer's self-hosted OpenClaw
 * Gateway. It opens a secure OUTBOUND WSS connection to the hosted Octopus
 * Prime AI backend (the Gateway needs no public inbound port). One connector
 * is scoped to exactly one Octopus Prime organization; since 1.5.0 each
 * channel account is one connector, so one Gateway can be in several
 * organizations (src/accounts.ts).
 */
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { CALENDAR_TOOL, PROJECTS_TOOL, TASKS_TOOL } from "./src/agent-work.js";
import { createAgentWorkTool } from "./src/agent-work-tool.js";
import { AUDIT_TOOL } from "./src/audited-workspace.js";
import { createAuditTool } from "./src/audited-workspace-tool.js";
import { BACKUP_TOOL } from "./src/backup.js";
import { createBackupTool } from "./src/backup-tool.js";
import { octopusPrimeChannel } from "./src/channel.js";
import { CHANNEL_HISTORY_TOOL } from "./src/channel-history.js";
import { createChannelHistoryTool } from "./src/channel-history-tool.js";
import { bindGatewayHost, stopAccountTransport } from "./src/gateway.js";
import { LOG_BOOK_TOOL } from "./src/log-book.js";
import { createLogBookTool } from "./src/log-book-tool.js";
import { FOLDER_TOOL } from "./src/project-folder.js";
import { createFolderTool } from "./src/project-folder-tool.js";
import { SESSION_TITLE_TOOL } from "./src/session-title.js";
import { createSessionTitleTool } from "./src/session-title-tool.js";
export default defineChannelPluginEntry({
    id: "octopus-prime",
    name: "Octopus Prime",
    description: "Secure outbound connector to the Octopus Prime communication backend.",
    plugin: octopusPrimeChannel,
    registerCliMetadata(api) {
        // `openclaw octopus-prime backup <setup|status|now|estimate|restore|passphrase>`
        // (src/backup-cli.ts, 1.38.0), loaded only when the CLI asks for the command.
        api.registerCli(async ({ program, config }) => {
            const { cliEnvironment, registerOctopusCli } = await import("./src/backup-cli.js");
            registerOctopusCli(program, () => cliEnvironment(config));
        }, {
            descriptors: [
                { name: "octopus-prime", description: "Octopus Prime connector management", hasSubcommands: true },
            ],
        });
    },
    registerFull(api) {
        // The project log book's tool (src/log-book-tool.ts), in tool discovery too;
        // its factory offers it only in a turn in a project's channel.
        api.registerTool((ctx) => createLogBookTool(ctx), { name: LOG_BOOK_TOOL });
        // The audited workspace's tool (src/audited-workspace-tool.ts), likewise;
        // its factory offers it only in a turn of an audited workspace.
        api.registerTool((ctx) => createAuditTool(ctx), { name: AUDIT_TOOL });
        // The project folder's tool (src/project-folder-tool.ts, 1.14.0), likewise;
        // its factory offers it only in a turn in a project's channel, on a
        // connection whose backend offered the project folder.
        api.registerTool((ctx) => createFolderTool(ctx), { name: FOLDER_TOOL });
        // The channel history's tool (src/channel-history-tool.ts, 1.15.0), likewise;
        // its factory offers it only in a turn of a conversation the plugin
        // dispatched, on a connection whose backend offered channel history.
        api.registerTool((ctx) => createChannelHistoryTool(ctx), { name: CHANNEL_HISTORY_TOOL });
        // The session title's tool (src/session-title-tool.ts, 1.21.0), likewise;
        // its factory offers it only in a turn of a session (a separate
        // conversation a person started with the agent), on a connection whose
        // backend offered session titles.
        api.registerTool((ctx) => createSessionTitleTool(ctx), { name: SESSION_TITLE_TOOL });
        // The tools for tasks, calendar events and projects (src/agent-work-tool.ts,
        // 1.28.0), likewise; their factories offer them only in a turn of a
        // conversation the plugin dispatched, on a connection whose backend
        // offered agent-work.
        api.registerTool((ctx) => createAgentWorkTool("tasks", ctx), { name: TASKS_TOOL });
        api.registerTool((ctx) => createAgentWorkTool("calendar", ctx), { name: CALENDAR_TOOL });
        api.registerTool((ctx) => createAgentWorkTool("projects", ctx), { name: PROJECTS_TOOL });
        // Agent Backup's tool (src/backup-tool.ts, 1.38.0): its estimate works on
        // any Gateway with a config, before any plan is bought; its status asks
        // the account's backend, on a connection that offered agent-backup.
        api.registerTool((ctx) => createBackupTool(ctx), { name: BACKUP_TOOL });
        if (api.registrationMode !== "full")
            return;
        bindGatewayHost(api);
        api.lifecycle.registerRuntimeLifecycle({
            id: "octopus-prime-transport",
            dispose: stopAccountTransport,
            cleanup: ({ reason, sessionKey, runId }) => {
                if (sessionKey === undefined && runId === undefined && (reason === "disable" || reason === "restart")) {
                    return stopAccountTransport();
                }
            },
        });
    },
});
