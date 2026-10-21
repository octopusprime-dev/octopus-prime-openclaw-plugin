import { existsSync } from "node:fs";
import { lstat as fsLstat, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * What Agent Backup takes from this computer (1.38.0, docs/AGENT-BACKUP.md §5).
 * ONE walk, used by a real backup and by the size estimate alike, so the
 * estimate counts exactly what a backup would send.
 *
 * Roots: OpenClaw's state dir (OPENCLAW_STATE_DIR, else ~/.openclaw, or
 * ~/.openclaw-<profile> with OPENCLAW_PROFILE, under OPENCLAW_HOME when set)
 * and every agent workspace configured outside it. Paths are kept relative to
 * their root, with the root's label ("state", "workspace:<agent>"), so nothing
 * that describes a file names this machine's folders.
 *
 * Never taken: credentials/, .env files, secrets.json, auth profiles
 * (auth-profiles.json, auth.json, each agent's openclaw-agent.sqlite and the
 * rest of its runtime folder agents/<id>/agent/), sessions and transcripts,
 * cookies and browser profiles, SSH/GPG/TLS keys and other key files, .npmrc,
 * .netrc, .git-credentials, node_modules, virtualenvs, caches, the state
 * dir's tools/, npm/, tmp/, media/ and the like, this plugin's own queue
 * database, copies of openclaw.json other than the config itself, logs older
 * than 7 days, files over 100 MB (listed as skipped), symbolic links (not
 * followed). A git repository with a remote is recorded (path, remotes without
 * credentials, branch, head), not copied; the workspace roots themselves are
 * always copied, their .git folder excepted, and a repository without a
 * remote is copied like any folder. Plugins in extensions/ are recorded by
 * name and version, their code not copied. The config itself
 * (`openclaw.json`) and the automations database (`state/openclaw.sqlite`) are
 * marked special: a backup redacts and sanitizes them (src/backup-config.ts,
 * src/backup-sqlite.ts).
 */
export const FILE_MAX_BYTES = 100 * 1000 * 1000;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// -- the roots -----------------------------------------------------------------------------
/**
 * OpenClaw's state dir as the docs give it (help/environment.md): what
 * OPENCLAW_STATE_DIR names, else ~/.openclaw (~/.openclaw-<profile> with
 * OPENCLAW_PROFILE), with OPENCLAW_HOME standing for the home folder. The
 * plugin prefers the SDK's resolveStateDir; this is the same rule, for tests
 * and as a fallback.
 */
export function defaultStateDir(env = process.env, home = os.homedir) {
    const explicit = env.OPENCLAW_STATE_DIR?.trim();
    if (explicit)
        return path.resolve(explicit.replace(/^~(?=$|[\\/])/, home()));
    const base = env.OPENCLAW_HOME?.trim() ? path.resolve(env.OPENCLAW_HOME.trim()) : home();
    const profile = env.OPENCLAW_PROFILE?.trim();
    return path.join(base, profile && profile !== "default" ? `.openclaw-${profile}` : ".openclaw");
}
const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const label = (agentId) => `workspace:${agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "agent"}`;
/**
 * The roots to back up: the state dir, then each configured agent workspace
 * that is not inside it or inside another root. `workspaceDirs` lists every
 * workspace (nested ones too), whose .git folder is never a reason to skip it.
 */
export function backupRoots(stateDir, workspaces) {
    const state = path.resolve(stateDir);
    const roots = [{ label: "state", dir: state, kind: "state", agents: [] }];
    const workspaceDirs = [];
    const sorted = [...workspaces].map((w) => ({ agentId: w.agentId, dir: path.resolve(w.dir) }))
        .sort((a, b) => a.dir.length - b.dir.length || a.agentId.localeCompare(b.agentId));
    for (const workspace of sorted) {
        if (!workspaceDirs.includes(workspace.dir))
            workspaceDirs.push(workspace.dir);
        const holder = roots.find((root) => inside(root.dir, workspace.dir));
        if (holder) {
            if (holder.dir === workspace.dir && !holder.agents.includes(workspace.agentId))
                holder.agents.push(workspace.agentId);
            continue;
        }
        let name = label(workspace.agentId);
        for (let n = 2; roots.some((root) => root.label === name); n += 1)
            name = `${label(workspace.agentId)}-${n}`;
        roots.push({ label: name, dir: workspace.dir, kind: "workspace", agents: [workspace.agentId] });
    }
    return { roots, workspaceDirs };
}
// -- what is left out ------------------------------------------------------------------------
const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", ".pnpm-store", "bower_components", "jspm_packages"]);
const CACHE_DIRS = new Set([".cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".parcel-cache",
    ".turbo", ".gradle", ".npm", ".tox", ".nyc_output", ".sass-cache"]);
const SECRET_DIRS = new Set(["credentials", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".azure", "gcloud", ".password-store"]);
const BROWSER_DIR = /^(?:browser(?:-profiles?)?|(?:chrome|chromium|firefox|browser)[-_]?(?:profiles?|data|user[-_]?data))$/i;
// The state dir's own folders that are tools, downloads, scratch space or runtime state.
const STATE_DIRS = {
    tools: "state_internal", npm: "state_internal", "npm-runtime": "state_internal", tmp: "state_internal",
    media: "state_internal", dev: "state_internal", git: "state_internal", sandboxes: "state_internal",
    cache: "cache", "plugin-skills": "state_internal", "octopus-restore": "state_internal", browser: "browser_profile",
};
const SECRET_FILE = [
    /^\.env(?:\..+)?$/i, /^secrets\.json$/i, /^auth-profiles\.json$/i, /^auth\.json$/i,
    /^openclaw-agent\.sqlite(?:-wal|-shm|-journal)?$/i, /\.(?:pem|key|p12|pfx|jks|keystore|ppk|gpg|kdbx)$/i,
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^_netrc$/i, /^\.git-credentials$/i,
    /^\.pgpass$/i, /^\.pypirc$/i, /^credentials(?:\.json)?$/i, /^tokens?\.(?:json|pickle)$/i,
    /^cookies?(?:\.(?:sqlite|txt|json))?$/i, /^service[-_]?account.*\.json$/i,
];
function directoryExclusion(root, rel, name, abs) {
    const segments = rel.split("/");
    if (DEPENDENCY_DIRS.has(name))
        return "dependencies";
    if ((name === "venv" || name === "env") && existsSync(path.join(abs, "pyvenv.cfg")))
        return "dependencies";
    if (CACHE_DIRS.has(name) || (name === "cache" && segments.at(-2) === ".next"))
        return "cache";
    if (SECRET_DIRS.has(name))
        return "secrets";
    if (BROWSER_DIR.test(name) && name !== "browser")
        return "browser_profile";
    if (root.kind !== "state")
        return null;
    if (segments.length === 1 && STATE_DIRS[name])
        return STATE_DIRS[name];
    if (segments[0] === "state")
        return "state_internal";
    if (segments[0] === "plugins" && segments[1] === "octopus-prime")
        return "plugin_queue";
    if (segments[0] === "cron" && segments[1] === "runs")
        return "run_history";
    if (segments[0] === "agents" && segments.length === 3) {
        if (name === "sessions")
            return "sessions";
        if (name === "agent")
            return "auth_profiles";
        if (name === "tmp" || name === ".tmp")
            return "state_internal";
    }
    return null;
}
function fileExclusion(root, rel, name) {
    if (SECRET_FILE.some((pattern) => pattern.test(name)))
        return "secrets";
    if (root.kind === "state" && !rel.includes("/") && /^openclaw\.json.+/i.test(name))
        return "config_copy";
    return null;
}
const isLog = (rel, name) => /\.log(?:\.\d+)?$/i.test(name) || rel.split("/").slice(0, -1).includes("logs");
// -- repositories, packages and plugins -------------------------------------------------------
/** A remote's address without a user name or password. */
export function strippedRemote(url) {
    const trimmed = url.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            if (parsed.username || parsed.password) {
                parsed.username = "";
                parsed.password = "";
                return parsed.toString();
            }
            return trimmed;
        }
        catch {
            return trimmed.replace(/\/\/[^/@]*@/, "//");
        }
    }
    // scp-like user:password@host:path keeps the user only.
    return trimmed.replace(/^([^@/:]+):[^@/]+@/, "$1@");
}
async function gitDirOf(dir) {
    const dotGit = path.join(dir, ".git");
    let stat;
    try {
        stat = await fsLstat(dotGit);
    }
    catch {
        return null;
    }
    if (stat.isDirectory())
        return dotGit;
    if (!stat.isFile())
        return null;
    try {
        const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
        return match ? path.resolve(dir, match[1].trim()) : null;
    }
    catch {
        return null;
    }
}
async function readText(file) {
    try {
        return await readFile(file, "utf8");
    }
    catch {
        return "";
    }
}
/** A repository's remotes, branch and head, from its .git folder (no git program is run). */
export async function readRepository(dir) {
    const gitDir = await gitDirOf(dir);
    if (!gitDir)
        return null;
    const common = (await readText(path.join(gitDir, "commondir"))).trim();
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    const remotes = [];
    let section = null;
    for (const line of (await readText(path.join(commonDir, "config"))).split(/\r?\n/)) {
        const header = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/.exec(line);
        if (header) {
            section = header[1];
            continue;
        }
        if (/^\s*\[/.test(line)) {
            section = null;
            continue;
        }
        const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
        if (section && url && !remotes.some((remote) => remote.name === section)) {
            remotes.push({ name: section.slice(0, 100), url: strippedRemote(url[1]).slice(0, 1000) });
        }
    }
    const headText = (await readText(path.join(gitDir, "HEAD"))).trim();
    const ref = /^ref:\s*(refs\/heads\/(.+))$/.exec(headText);
    let head = /^[0-9a-f]{40,64}$/.test(headText) ? headText : null;
    if (ref) {
        head = (await readText(path.join(commonDir, ref[1]))).trim() || null;
        if (!head) {
            const packed = (await readText(path.join(commonDir, "packed-refs"))).split(/\r?\n/)
                .map((line) => line.split(" ")).find((parts) => parts[1] === ref[1]);
            head = packed?.[0] ?? null;
        }
        if (head && !/^[0-9a-f]{40,64}$/.test(head))
            head = null;
    }
    return { remotes, branch: ref ? ref[2].slice(0, 200) : null, head };
}
async function readPlugins(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const plugins = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        try {
            const pkg = JSON.parse(await readFile(path.join(dir, entry.name, "package.json"), "utf8"));
            if (typeof pkg.name === "string" && /^[@\w./-]{1,214}$/.test(pkg.name)) {
                plugins.push({ name: pkg.name, version: typeof pkg.version === "string" ? pkg.version.slice(0, 64) : "" });
            }
        }
        catch { /* not a plugin folder */ }
    }
    return plugins;
}
const PACKAGE_FILES = { "package.json": "npm", "requirements.txt": "python", "pyproject.toml": "python" };
// -- the walk -----------------------------------------------------------------------------------
export async function walkBackupFiles(roots, options) {
    const lstat = options.lstat ?? fsLstat;
    const maxFileBytes = options.maxFileBytes ?? FILE_MAX_BYTES;
    const workspaceDirs = new Set((options.workspaceDirs ?? []).map((dir) => path.resolve(dir)));
    const rootDirs = new Set(roots.map((root) => path.resolve(root.dir)));
    const state = roots.find((root) => root.kind === "state");
    const configPath = path.resolve(options.configPath ?? (state ? path.join(state.dir, "openclaw.json") : ""));
    const result = { roots: [...roots], files: [], repos: [], packages: [], plugins: [], skipped: [], excluded: {} };
    const exclude = (reason) => { result.excluded[reason] = (result.excluded[reason] ?? 0) + 1; };
    let configSeen = false;
    const addFile = async (root, rel, abs, special) => {
        let stat;
        try {
            stat = await lstat(abs);
        }
        catch {
            exclude("unreadable");
            return;
        }
        if (!stat.isFile()) {
            exclude(stat.isSymbolicLink() ? "symlink" : "not_a_file");
            return;
        }
        const name = path.basename(rel);
        if (!special && isLog(rel, name) && stat.mtimeMs < options.now - LOG_MAX_AGE_MS) {
            exclude("old_log");
            return;
        }
        if (stat.size > maxFileBytes) {
            result.skipped.push({ root: root.label, path: rel, reason: "too_large", size: stat.size });
            exclude("too_large");
            return;
        }
        result.files.push({
            root: root.label, path: rel, abs, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777, ino: stat.ino,
            ...(special ? { special } : {}),
        });
    };
    const walkDir = async (root, abs, rel, isWorkspaceRoot) => {
        let entries;
        try {
            entries = await readdir(abs, { withFileTypes: true });
        }
        catch {
            exclude("unreadable");
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const names = new Set(entries.map((entry) => entry.name));
        if (rel && !isWorkspaceRoot && names.has(".git")) {
            const repo = await readRepository(abs);
            if (repo && repo.remotes.length > 0) {
                result.repos.push({ root: root.label, path: rel, ...repo });
                exclude("repo_with_remote");
                return;
            }
        }
        let skippedDependencies = false;
        for (const entry of entries) {
            const name = entry.name;
            const childRel = rel ? `${rel}/${name}` : name;
            const childAbs = path.join(abs, name);
            if (entry.isSymbolicLink()) {
                if (root.kind === "state" && childRel === "extensions")
                    result.plugins.push(...await readPlugins(childAbs));
                exclude("symlink");
                continue;
            }
            if (entry.isDirectory()) {
                if (name === ".git") {
                    exclude("git_folder");
                    continue;
                }
                if (root.kind === "state" && childRel === "extensions") {
                    result.plugins.push(...await readPlugins(childAbs));
                    exclude("plugin_code");
                    continue;
                }
                // Another root inside this one (the state dir inside a workspace, say) is walked as itself, once.
                if (rootDirs.has(path.resolve(childAbs))) {
                    exclude("other_root");
                    continue;
                }
                const reason = directoryExclusion(root, childRel, name, childAbs);
                if (reason) {
                    if (reason === "dependencies")
                        skippedDependencies = true;
                    exclude(reason);
                    continue;
                }
                await walkDir(root, childAbs, childRel, workspaceDirs.has(path.resolve(childAbs)));
                continue;
            }
            if (!entry.isFile()) {
                exclude("not_a_file");
                continue;
            }
            if (path.resolve(childAbs) === configPath) {
                configSeen = true;
                await addFile(root, root.kind === "state" && !rel ? "openclaw.json" : childRel, childAbs, "config");
                continue;
            }
            if (root.kind === "state" && !rel && name === "openclaw.json") {
                exclude("config_copy");
                continue;
            }
            if (root.kind === "state" && childRel === "state/openclaw.sqlite") {
                await addFile(root, childRel, childAbs, "state-db");
                continue;
            }
            const reason = fileExclusion(root, childRel, name);
            if (reason) {
                exclude(reason);
                continue;
            }
            await addFile(root, childRel, childAbs);
        }
        if (skippedDependencies) {
            const kinds = [...new Set(Object.keys(PACKAGE_FILES).filter((file) => names.has(file)).map((file) => PACKAGE_FILES[file]))];
            if (kinds.length > 0)
                result.packages.push({ root: root.label, path: rel || ".", kinds });
        }
    };
    for (const root of roots) {
        if (root.kind === "state") {
            // Only state/openclaw.sqlite is taken from state/: walked here, never as a folder.
            const stateDb = path.join(root.dir, "state", "openclaw.sqlite");
            await walkDir(root, root.dir, "", true);
            if (!existsSync(path.join(root.dir, "state")))
                continue;
            if (existsSync(stateDb))
                await addFile(root, "state/openclaw.sqlite", stateDb, "state-db");
            continue;
        }
        await walkDir(root, root.dir, "", true);
    }
    // A config kept outside the state dir (OPENCLAW_CONFIG_PATH) is the state root's openclaw.json in the backup.
    if (!configSeen && state && options.configPath && existsSync(configPath)) {
        await addFile(state, "openclaw.json", configPath, "config");
    }
    result.files.sort((a, b) => (a.root === b.root ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.root < b.root ? -1 : 1));
    return result;
}
