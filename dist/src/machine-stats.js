import os from "node:os";
import { readFile, readdir, statfs } from "node:fs/promises";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { channelSection } from "./runtime-config.js";
// The macOS programs read, by absolute path; each must answer within this long.
const VM_STAT = ["/usr/bin/vm_stat"];
const PS = ["/bin/ps", "-A", "-o", "pid=,ppid=,rss="];
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_OUTPUT_MAX = 2 * 1024 * 1024;
/**
 * OpenClaw's command runner (api.runtime.system.runCommandWithTimeout), or
 * undefined where the host has none. A program that fails, times out or
 * cannot start gives undefined.
 */
export function hostCommandRunner(system) {
    const run = system?.runCommandWithTimeout;
    if (typeof run !== "function")
        return undefined;
    return async (argv) => {
        try {
            const result = await run.call(system, argv, { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_OUTPUT_MAX });
            return result.code === 0 && (result.termination ?? "exit") === "exit" && typeof result.stdout === "string"
                ? result.stdout
                : undefined;
        }
        catch {
            return undefined;
        }
    };
}
// Heavy load: memory above HEAVY_MEMORY_ABOVE or CPU above HEAVY_CPU_ABOVE in
// every reading for HEAVY_FOR_MS at least (the backend's rule too).
export const HEAVY_MEMORY_ABOVE = 85;
export const HEAVY_CPU_ABOVE = 90;
export const HEAVY_FOR_MS = 3 * 60_000;
// Heartbeats come every 25 seconds; a reading is taken at most this often.
export const SAMPLE_EVERY_MS = 20_000;
// A reading older than this says nothing about the load now.
export const STALE_MS = 2 * 60_000;
// The most processes counted as the Gateway's (Linux).
const MAX_PROCESSES = 256;
export function nodeProbe(run) {
    const available = process.availableMemory;
    return {
        ...(run ? { run } : {}),
        platform: process.platform,
        loadavg: () => os.loadavg(),
        cpuCount: () => os.availableParallelism?.() ?? os.cpus().length,
        totalmem: () => os.totalmem(),
        freemem: () => os.freemem(),
        ...(typeof available === "function" ? { availableMemory: () => available.call(process) } : {}),
        readText: (path) => readFile(path, "utf8"),
        listDir: (path) => readdir(path),
        statfs: async (path) => {
            const stats = await statfs(path);
            return { bavail: Number(stats.bavail), blocks: Number(stats.blocks) };
        },
        stateDir: () => resolveStateDir(),
        pid: process.pid,
        rss: () => process.memoryUsage.rss(),
    };
}
const whole = (value, max = 100) => Math.min(max, Math.max(0, Math.round(value)));
// The `<Key>: <n> kB` lines of /proc/meminfo or /proc/<pid>/status, in bytes.
function kilobytes(text) {
    const values = new Map();
    for (const line of text.split("\n")) {
        const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
        if (match)
            values.set(match[1], Number(match[2]) * 1024);
    }
    return values;
}
async function optional(read) {
    try {
        return await read();
    }
    catch {
        return undefined;
    }
}
// Linux: this process and its descendants, through /proc/<pid>/task/<tid>/children.
async function linuxGatewayProcesses(probe) {
    const seen = new Set();
    const queue = [probe.pid];
    let bytes = 0;
    while (queue.length && seen.size < MAX_PROCESSES) {
        const pid = queue.shift();
        if (seen.has(pid))
            continue;
        seen.add(pid);
        const status = await optional(() => probe.readText(`/proc/${pid}/status`));
        bytes += (status && kilobytes(status).get("VmRSS")) || 0;
        const tasks = await optional(() => probe.listDir(`/proc/${pid}/task`)) ?? [];
        for (const tid of tasks) {
            const children = await optional(() => probe.readText(`/proc/${pid}/task/${tid}/children`)) ?? "";
            for (const child of children.split(/\s+/)) {
                if (/^\d+$/.test(child))
                    queue.push(Number(child));
            }
        }
    }
    return bytes > 0 ? { count: seen.size, bytes } : undefined;
}
/**
 * macOS: the memory in use as Activity Monitor counts it (app memory, that is
 * anonymous less purgeable pages, plus wired and compressed), from vm_stat's
 * output, in bytes; undefined when it does not say all of them.
 */
export function vmStatUsedBytes(text) {
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
    const pages = new Map();
    for (const line of text.split("\n")) {
        const match = /^"?([A-Za-z][A-Za-z -]*?)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
        if (match)
            pages.set(match[1], Number(match[2]));
    }
    const anonymous = pages.get("Anonymous pages");
    const wired = pages.get("Pages wired down");
    const compressed = pages.get("Pages occupied by compressor");
    if (!(pageSize > 0) || anonymous === undefined || wired === undefined || compressed === undefined)
        return undefined;
    const app = Math.max(0, anonymous - (pages.get("Pages purgeable") ?? 0));
    return (app + wired + compressed) * pageSize;
}
/**
 * macOS: this process and its descendants from `ps -o pid=,ppid=,rss=`
 * (numbers only; rss in KiB), or undefined when this process is not listed.
 */
export function psGatewayProcesses(text, pid) {
    const rss = new Map();
    const children = new Map();
    for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match)
            continue;
        const [child, parent, kib] = [Number(match[1]), Number(match[2]), Number(match[3])];
        rss.set(child, kib * 1024);
        children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    if (!rss.has(pid))
        return undefined;
    const seen = new Set();
    const queue = [pid];
    let bytes = 0;
    while (queue.length && seen.size < MAX_PROCESSES) {
        const next = queue.shift();
        if (seen.has(next))
            continue;
        seen.add(next);
        bytes += rss.get(next) ?? 0;
        queue.push(...(children.get(next) ?? []));
    }
    return { count: seen.size, bytes };
}
async function macGatewayProcesses(probe) {
    const text = probe.run ? await optional(() => probe.run(PS)) : undefined;
    const gateway = text ? psGatewayProcesses(text, probe.pid) : undefined;
    return gateway && gateway.bytes > 0 ? gateway : undefined;
}
/** One reading of the machine, or undefined where the platform is not supported (Windows). */
export async function readMachineStats(probe = nodeProbe()) {
    if (probe.platform !== "darwin" && probe.platform !== "linux")
        return undefined;
    const cores = Math.max(1, probe.cpuCount() || 1);
    const total = probe.totalmem();
    if (!(total > 0))
        return undefined;
    const stats = {
        cpu_percent: whole(((probe.loadavg()[0] ?? 0) / cores) * 100),
        memory_percent: 0,
    };
    let available;
    if (probe.platform === "linux") {
        const meminfo = await optional(async () => kilobytes(await probe.readText("/proc/meminfo")));
        available = meminfo?.get("MemAvailable");
        const swapTotal = meminfo?.get("SwapTotal");
        const swapFree = meminfo?.get("SwapFree");
        if (swapTotal && swapTotal > 0 && swapFree !== undefined) {
            stats.swap_used_percent = whole(((swapTotal - swapFree) / swapTotal) * 100);
        }
    }
    else {
        const vmStat = probe.run ? await optional(() => probe.run(VM_STAT)) : undefined;
        const used = vmStat ? vmStatUsedBytes(vmStat) : undefined;
        available = used !== undefined && used <= total ? total - used : optionalNumber(() => probe.availableMemory?.());
    }
    // What is available is never more than all of it, nor less than what is free.
    const free = optionalNumber(() => probe.freemem()) ?? 0;
    if (available === undefined || !(available > 0) || available > total || available < free)
        available = free;
    stats.memory_percent = whole(((total - available) / total) * 100);
    const disk = await optional(() => probe.statfs(probe.stateDir()));
    if (disk && disk.blocks > 0)
        stats.disk_free_percent = whole((disk.bavail / disk.blocks) * 100);
    const gateway = probe.platform === "linux" ? await linuxGatewayProcesses(probe) : await macGatewayProcesses(probe);
    if (gateway) {
        stats.gateway_memory_bytes = whole(gateway.bytes, Number.MAX_SAFE_INTEGER);
        stats.gateway_processes = gateway.count;
    }
    else {
        const rss = optionalNumber(() => probe.rss());
        if (rss !== undefined && rss > 0)
            stats.gateway_memory_bytes = whole(rss, Number.MAX_SAFE_INTEGER);
    }
    return stats;
}
function optionalNumber(read) {
    try {
        const value = read();
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
export const isHot = (stats) => stats.memory_percent > HEAVY_MEMORY_ABOVE || stats.cpu_percent > HEAVY_CPU_ABOVE;
/**
 * The Gateway's readings, shared by its accounts: the latest, and since when
 * every reading was hot. A reading is taken at most every SAMPLE_EVERY_MS,
 * one at a time; one that fails keeps the last. Timed on the monotonic clock,
 * so a change of the computer's time never makes or ends 3 minutes.
 */
export function createMachineSampler(probe = nodeProbe(), now = () => performance.now()) {
    let latest;
    let hotSince;
    let running;
    const fresh = () => (latest && now() - latest.at < STALE_MS ? latest : undefined);
    return {
        /** Takes a reading unless one was taken within SAMPLE_EVERY_MS. Never rejects. */
        refresh() {
            if (running)
                return running;
            if (latest && now() - latest.at < SAMPLE_EVERY_MS)
                return Promise.resolve(latest.stats);
            running = readMachineStats(probe).catch(() => undefined).then((stats) => {
                if (stats) {
                    const at = now();
                    latest = { at, stats };
                    if (!isHot(stats))
                        hotSince = undefined;
                    else
                        hotSince ??= at;
                }
                return fresh()?.stats;
            }).finally(() => { running = undefined; });
            return running;
        },
        /** The latest reading while it is fresh. */
        latest() {
            return fresh()?.stats;
        },
        /** The latest reading while the machine has been under heavy load for HEAVY_FOR_MS at least. */
        heavy() {
            const current = fresh();
            return current && hotSince !== undefined && current.at - hotSince >= HEAVY_FOR_MS ? current.stats : undefined;
        },
    };
}
// The Gateway process's one sampler; `run` is OpenClaw's command runner
// (hostCommandRunner), taken from the first account that starts.
let shared;
export function machineSampler(run) {
    shared ??= createMachineSampler(nodeProbe(run));
    return shared;
}
/** Whether the Gateway's owner lets the plugin send the machine's load (on unless false). */
export function machineStatsShared(cfg) {
    return channelSection(cfg).shareMachineStats !== false;
}
/** The line an agent's turn carries while the computer is under heavy load. */
export const machineLoadLine = (stats) => (`The computer running you is under heavy load (memory ${stats.memory_percent}%, CPU ${stats.cpu_percent}%). `
    + "Prefer light work, close tabs/processes you opened, and avoid starting parallel jobs.");
