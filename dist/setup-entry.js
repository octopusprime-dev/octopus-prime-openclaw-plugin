/**
 * Lightweight setup-time entry. OpenClaw loads this (instead of the full
 * runtime) during onboarding / when the channel is unconfigured.
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { octopusPrimeChannel } from "./src/channel.js";
export default defineSetupPluginEntry(octopusPrimeChannel);
