import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDependencies, runCommand, unlinkDependencies } from "pi-swarm";
import { logger } from "../../log";

const log = logger("factory");

const IDENTITY = ["-c", "user.name=ThinkRail", "-c", "user.email=agents@thinkrail.invalid"];
/** What a snapshot leaves out: dependency links are the host's, never the worker's content. */
const CONTENT = ["--", ".", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/node_modules"];

/** Raw stdout: NUL-delimited path lists keep every byte, including leading or trailing spaces. */
async function gitRaw(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	const result = await runCommand("git", args, { cwd, ...(env ? { env } : {}) });
	if (result.code !== 0)
		throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

/** Trimmed stdout, for scalar answers such as object ids. */
async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	return (await gitRaw(cwd, args, env)).trim();
}

/** Builds the worktree's current content into a throwaway index; the worktree and its index stay untouched. */
async function withContentIndex<T>(path: string, use: (env: Record<string, string>) => Promise<T>) {
	const env = { GIT_INDEX_FILE: join(tmpdir(), `factory-index-${randomUUID()}`) };
	try {
		await git(path, ["read-tree", "HEAD"], env);
		await git(path, ["add", "-A", ...CONTENT], env);
		return await use(env);
	} finally {
		rmSync(env.GIT_INDEX_FILE, { force: true });
	}
}

/**
 * The identity of the worktree's exact content (tracked and untracked files, never `node_modules`): the
 * git tree id. A gate record names the tree it tested, so any difference — even one undone later — is a
 * different tree only if the content differs now, and the record is fresh exactly when the content is.
 */
export function contentTree(path: string): Promise<string> {
	return withContentIndex(path, (env) => git(path, ["write-tree"], env));
}

/** The content as an immutable commit on top of the worktree's HEAD, plus its tree id. */
export function snapshotCommit(
	path: string,
	message: string,
): Promise<{ tree: string; commit: string }> {
	return withContentIndex(path, async (env) => {
		const tree = await git(path, ["write-tree"], env);
		const head = await git(path, ["rev-parse", "HEAD"]);
		const configured =
			(await runCommand("git", ["config", "user.email"], { cwd: path })).code === 0;
		const commit = await git(path, [
			...(configured ? [] : IDENTITY),
			"commit-tree",
			tree,
			"-p",
			head,
			"-m",
			message,
		]);
		return { tree, commit };
	});
}

/** Files the snapshot changes against its parent, as repository-relative paths with forward slashes. */
export async function snapshotFiles(path: string, commit: string): Promise<string[]> {
	const out = await gitRaw(path, [
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		"-z",
		`${commit}^`,
		commit,
	]);
	return out.split("\0").filter(Boolean);
}

/** Paths whose content differs between commit-ish `base` and `tree`, from one captured tree. */
export async function treeFiles(path: string, base: string, tree: string): Promise<string[]> {
	const out = await gitRaw(path, ["diff-tree", "--name-only", "-r", "-z", base, tree]);
	return out.split("\0").filter(Boolean);
}

/** The diff stat between `base` and `tree`. */
export function treeStat(path: string, base: string, tree: string): Promise<string> {
	return git(path, ["diff", "--stat", base, tree]);
}

/** A file's blob id in `commit`, or undefined when the commit has no such file. */
export async function blobAt(
	path: string,
	commit: string,
	file: string,
): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "-q", "--verify", `${commit}:${file}`], {
		cwd: path,
	});
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The blob id the working-tree file would have, or undefined when it does not exist. */
export async function workingBlob(path: string, file: string): Promise<string | undefined> {
	const result = await runCommand("git", ["hash-object", "--", file], { cwd: path });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Runs `use` in a throwaway detached checkout of `commit`, with the repository's dependency folders linked
 * in, then removes it. Gate processes therefore see exactly the snapshot and can never change the worker's
 * own worktree — whatever they write lands in the throwaway copy.
 */
export async function inSnapshotCheckout<T>(
	repo: string,
	root: string,
	commit: string,
	use: (path: string) => Promise<T>,
): Promise<T> {
	const path = join(root, ".gate-runs", randomUUID());
	mkdirSync(join(root, ".gate-runs"), { recursive: true });
	await git(repo, ["worktree", "add", "--detach", path, commit]);
	try {
		linkDependencies(repo, path);
		return await use(path);
	} finally {
		unlinkDependencies(path);
		const removed = await runCommand("git", ["worktree", "remove", "--force", path], {
			cwd: repo,
		}).catch(() => undefined);
		// Neither cleanup step may mask the gate result or an earlier gate error: failures are only logged.
		let leftover = false;
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (error) {
			leftover = true;
			log.warn(`could not delete the gate checkout ${path}`, error);
		}
		// A registration git could not remove is pruned once its directory is gone.
		if (removed?.code !== 0 || leftover) {
			const pruned = await runCommand("git", ["worktree", "prune"], { cwd: repo }).catch(
				() => undefined,
			);
			if (pruned?.code !== 0)
				log.warn(`could not remove the gate checkout ${path}; run "git worktree prune"`);
		}
	}
}

/** Whether `commit` exists in the repository. */
export async function hasCommit(path: string, commit: string): Promise<boolean> {
	return (
		(await runCommand("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: path })).code === 0
	);
}
