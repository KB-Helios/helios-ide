import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** fsmonitor daemons detach but inherit our pipes; never start one from a host-driven git call. */
export const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "core.fsmonitor",
	GIT_CONFIG_VALUE_0: "false",
} as const;

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export function run(
	command: string,
	args: readonly string[],
	options: {
		cwd: string;
		input?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		shell?: boolean;
	},
): Promise<ExecResult> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(options.signal.reason);
			return;
		}
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			shell: options.shell ?? false,
			windowsHide: true,
			detached: process.platform !== "win32",
			env: { ...process.env, ...GIT_ENV },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		let killing: Promise<void> | undefined;
		const stop = () => {
			killing ??= killTree(child.pid);
		};
		const timer = options.timeoutMs !== undefined ? setTimeout(stop, options.timeoutMs) : undefined;
		options.signal?.addEventListener("abort", stop, { once: true });
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", stop);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		let settled = false;
		const finish = async (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (killing) await killing;
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				durationMs: Date.now() - started,
			});
		};
		child.on("close", finish);
		child.on("exit", (code) => {
			setTimeout(() => finish(code), 500).unref?.();
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
		else child.stdin?.end();
	});
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Stops a command and everything it started (a gate's shell spawns the real test/build processes). */
async function killTree(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			killer.on("close", () => resolve());
			killer.on("error", () => resolve());
		});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return;
	}
	for (let waited = 0; waited < 3000 && groupAlive(pid); waited += 100)
		await new Promise((resolve) => setTimeout(resolve, 100));
	if (groupAlive(pid))
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
	const result = await run("git", args, { cwd, ...(input !== undefined ? { input } : {}) });
	if (result.code !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => undefined);
	return result?.code === 0 ? result.stdout.trim() : undefined;
}

export function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "swarm"
	);
}

export interface Worktree {
	path: string;
	branch: string;
	base: string;
	repo: string;
}

/** A fresh worktree on a new branch from HEAD, with the repository's dependency folders linked in. */
export async function createWorktree(options: {
	repo: string;
	root: string;
	/** Display title; truncated in names, so `swarmId` keeps them unique. */
	swarm: string;
	swarmId: string;
	member: string;
}): Promise<Worktree> {
	const base = (await git(options.repo, ["rev-parse", "HEAD"])).trim();
	const dir = `${slug(options.swarm)}-${slug(options.swarmId)}`;
	const path = join(options.root, dir, options.member);
	const branch = `swarm/${dir}/${options.member}`;
	mkdirSync(dirname(path), { recursive: true });
	await git(options.repo, ["worktree", "add", "-b", branch, path, base]);
	linkDependencies(options.repo, path);
	return { path, branch, base, repo: options.repo };
}

const SKIP = new Set([".git", "node_modules", ".turbo", "dist", "build", "target", ".venv"]);

/** Links every `node_modules` within three levels of the repo root into the same place in the worktree. */
export function linkDependencies(repo: string, worktree: string): void {
	const visit = (dir: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = join(dir, entry.name);
			if (entry.name === "node_modules") {
				const target = join(worktree, relative(repo, full));
				if (!existsSync(target) && existsSync(dirname(target))) {
					try {
						symlinkSync(full, target, process.platform === "win32" ? "junction" : "dir");
					} catch {}
				}
			} else if (depth < 3 && !SKIP.has(entry.name) && !entry.name.startsWith("."))
				visit(full, depth + 1);
		}
	};
	visit(repo, 0);
}

/** Removes the dependency links `linkDependencies` made, never what they point to. */
export function unlinkDependencies(worktree: string): void {
	const visit = (dir: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.name === "node_modules") {
				try {
					if (lstatSync(full).isSymbolicLink()) {
						if (process.platform === "win32") rmdirSync(full);
						else unlinkSync(full);
					}
				} catch {}
			} else if (
				entry.isDirectory() &&
				depth < 3 &&
				!SKIP.has(entry.name) &&
				!entry.name.startsWith(".")
			)
				visit(full, depth + 1);
		}
	};
	visit(worktree, 0);
}

export async function changedFiles(cwd: string): Promise<string[]> {
	const out = await git(cwd, ["status", "--porcelain", "-z", "-uall", "--no-renames"]);
	return out
		.split("\0")
		.filter((record) => record.length > 3)
		.map((record) => record.slice(3))
		.filter((file) => !file.split("/").includes("node_modules"));
}

/** Uncommitted changes plus untracked files as a binary-safe patch against the worktree's base. */
export async function worktreeDiff(cwd: string): Promise<{ patch: string; stat: string }> {
	await git(cwd, ["add", "-A", "-N", "--", ".", ":!**/node_modules"]).catch(() =>
		git(cwd, ["add", "-A", "-N"]),
	);
	const patch = await git(cwd, ["diff", "HEAD", "--binary"]);
	const stat = await git(cwd, ["diff", "HEAD", "--stat"]);
	return { patch, stat: stat.trim() };
}

/** All-or-nothing: never `--3way`, which leaves conflict markers and staged entries on failure. */
export async function applyPatch(
	target: string,
	patch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!patch.trim()) return { ok: true };
	const applied = await run("git", ["apply", "--whitespace=nowarn", "-"], {
		cwd: target,
		input: patch,
	});
	return applied.code === 0
		? { ok: true }
		: { ok: false, error: (applied.stderr || applied.stdout).trim() };
}

/** Commits everything in the worktree to its branch (used where the result is a branch, e.g. A2A). */
export async function commitWorktree(cwd: string, message: string): Promise<string | undefined> {
	if ((await changedFiles(cwd)).length === 0) return undefined;
	await git(cwd, ["add", "-A"]);
	const identity =
		(await run("git", ["config", "user.email"], { cwd })).code === 0
			? []
			: ["-c", "user.name=ThinkRail", "-c", "user.email=agents@thinkrail.invalid"];
	await git(cwd, [...identity, "commit", "--no-verify", "-m", message]);
	return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function removeWorktree(
	worktree: Pick<Worktree, "path" | "branch" | "repo">,
	options: { deleteBranch: boolean },
): Promise<void> {
	unlinkDependencies(worktree.path);
	await git(worktree.repo, ["worktree", "remove", "--force", worktree.path]).catch(() => {});
	if (options.deleteBranch)
		await git(worktree.repo, ["branch", "-D", worktree.branch]).catch(() => {});
}

function globToRegExp(glob: string): RegExp {
	let pattern = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (pattern.endsWith("/")) pattern += "**";
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") {
				out += "(?:.*/)?";
				i += 2;
			} else {
				out += ".*";
				i++;
			}
		} else if (char === "*") out += "[^/]*";
		else if (char === "?") out += "[^/]";
		else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const isPrefix = !/[*?]/.test(pattern);
	return new RegExp(isPrefix ? `^${out}(/.*)?$` : `^${out}$`);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
	const normalized = file.split(sep).join("/");
	return globs.some((glob) => globToRegExp(glob).test(normalized));
}

/** Files outside `owns` (when set) or inside `avoid`. */
export function ownershipViolations(
	files: readonly string[],
	brief: { owns: readonly string[]; avoid: readonly string[] },
): string[] {
	return files.filter(
		(file) =>
			(brief.owns.length > 0 && !matchesAny(file, brief.owns)) || matchesAny(file, brief.avoid),
	);
}
