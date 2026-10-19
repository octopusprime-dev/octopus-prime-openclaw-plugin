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
import { AUDIT_TOOL } from "./src/audited-workspace.js";
import { createAuditTool } from "./src/audited-workspace-tool.js";
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
        api.registerCli(({ program }) => {
            program
                .command("octopus-prime")
                .description("Octopus Prime connector management");
        }, {
            descriptors: [
                { name: "octopus-prime", description: "Octopus Prime connector management", hasSubcommands: false },
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
