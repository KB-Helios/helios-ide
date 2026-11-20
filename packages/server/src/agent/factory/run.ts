import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceProvider } from "pi-delegation";
import {
	changedFiles,
	createWorktree,
	type GateResult,
	matchesAny,
	ownershipViolations,
	repoRoot,
	type Worktree,
	worktreeDiff,
} from "pi-swarm";
import { type FactoryNode, PROTECTED_BASENAMES } from "./spec";

export interface FactoryRunOptions {
	workspaceId: string;
	dagId: string;
	/** The DAG's checkout; the git repository that coder worktrees branch from and landing merges into. */
	cwd: string;
	/** `<dataDir>/factory-worktrees/<workspaceId>`. */
	worktreeRoot: string;
	/** Fail-closed project trust; gates execute the project's own scripts, so untrusted means never. */
	isTrusted: () => boolean;
	/** True only when a human approval gate on `nodeId` was approved in the DAG's own state. */
	releaseApproved: (dagId: string, nodeId: string) => Promise<boolean>;
}

export interface WorktreeMeta extends Worktree {
	nodeId: string;
	owns: string[];
	avoid: string[];
	landed?: boolean;
	/**
	 * The commit landing made from the gated worktree, recorded before its merge. A retried landing
	 * (after a failed merge) merges exactly this commit instead of treating the now-clean worktree as empty.
	 */
	committed?: string;
}

export interface GateRecord {
	ok: boolean;
	/** Why no command ran (untrusted, no gates, ownership), when `results` is empty. */
	reason?: string;
	commands: string[];
	results: GateResult[];
	violations: string[];
	/** SHA-256 of the worktree diff the gates ran against; any later edit makes the record stale. */
	diffHash: string;
	ranAt: string;
}

export interface BoundNode {
	nodeId: string;
	node: FactoryNode;
}

const MAX_TEXT = 256 * 1024;
export const MAX_WRITE = 2 * 1024 * 1024;

export function hashPatch(patch: string): string {
	return createHash("sha256").update(patch).digest("hex");
}

/**
 * One DAG's factory state on the host: which session is which node, where each coder's worktree lives,
 * and the host-written gate records landing trusts instead of anything a model reports.
 */
export class FactoryRun {
	readonly options: FactoryRunOptions;
	private readonly sessions = new Map<string, BoundNode>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private repoPromise: Promise<string> | undefined;

	constructor(options: FactoryRunOptions) {
		this.options = options;
	}

	get dagId(): string {
		return this.options.dagId;
	}

	bind(sessionId: string, bound: BoundNode): void {
		this.sessions.set(sessionId, bound);
	}

	unbind(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	boundNode(sessionId: string): BoundNode | undefined {
		return this.sessions.get(sessionId);
	}

	/** Serializes work per key (a node's worktree, or the landing). */
	serial<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.catch(() => {});
		this.queues.set(key, tail);
		void tail.then(() => {
			if (this.queues.get(key) === tail) this.queues.delete(key);
		});
		return next;
	}

	repo(): Promise<string> {
		this.repoPromise ??= repoRoot(this.options.cwd).then((root) => {
			if (!root) throw new Error(`${this.options.cwd} is not inside a git repository`);
			return root;
		});
		this.repoPromise.catch(() => {
			this.repoPromise = undefined;
		});
		return this.repoPromise;
	}

	private metaFile(nodeId: string): string {
		return join(this.options.worktreeRoot, ".meta", this.options.dagId, `${nodeId}.json`);
	}

	private retryFile(nodeId: string): string {
		return join(this.options.worktreeRoot, ".meta", this.options.dagId, `${nodeId}.retries.json`);
	}

	/** Gate corrections already granted to `sessionId` (one attempt); a new session starts again at 0. */
	gateRetriesUsed(nodeId: string, sessionId: string): number {
		try {
			const saved = JSON.parse(readFileSync(this.retryFile(nodeId), "utf8")) as {
				sessionId?: unknown;
				used?: unknown;
			};
			return saved.sessionId === sessionId && typeof saved.used === "number" ? saved.used : 0;
		} catch {
			return 0;
		}
	}

	/** Persists one more correction before it is granted, so a restart cannot reset the budget. */
	useGateRetry(nodeId: string, sessionId: string): number {
		const used = this.gateRetriesUsed(nodeId, sessionId) + 1;
		const file = this.retryFile(nodeId);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ sessionId, used }));
		return used;
	}

	private gateFile(nodeId: string): string {
		return join(this.options.worktreeRoot, ".meta", this.options.dagId, `${nodeId}.gates.json`);
	}

	readMeta(nodeId: string): WorktreeMeta | undefined {
		try {
			return JSON.parse(readFileSync(this.metaFile(nodeId), "utf8")) as WorktreeMeta;
		} catch {
			return undefined;
		}
	}

	writeMeta(meta: WorktreeMeta): void {
		const file = this.metaFile(meta.nodeId);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(meta, null, 2));
	}

	/**
	 * The coder's worktree, created on first use and reused by a retried attempt so it fixes forward.
	 * The host calls this when the node's session is created; tools only ever read the record.
	 */
	ensureWorktree(nodeId: string, node: { owns: string[]; avoid: string[] }): Promise<WorktreeMeta> {
		return this.serial(`worktree:${nodeId}`, async () => {
			const existing = this.readMeta(nodeId);
			if (existing?.landed) throw new Error(`Node ${nodeId} has already landed`);
			if (existing && existsSync(existing.path)) return existing;
			const repo = await this.repo();
			const worktree = await createWorktree({
				repo,
				root: this.options.worktreeRoot,
				swarm: "factory",
				swarmId: this.options.dagId,
				member: nodeId,
			});
			const meta: WorktreeMeta = { ...worktree, nodeId, owns: node.owns, avoid: node.avoid };
			this.writeMeta(meta);
			rmSync(this.gateFile(nodeId), { force: true });
			rmSync(this.retryFile(nodeId), { force: true });
			return meta;
		});
	}

	/** The child's cwd: fresh coder sessions start inside their own worktree. */
	workspaceProvider(nodeId: string, node: { owns: string[]; avoid: string[] }): WorkspaceProvider {
		return {
			prepare: async () => {
				const meta = await this.ensureWorktree(nodeId, node);
				return { cwd: meta.path, dispose: () => undefined };
			},
		};
	}

	/** A source worktree that exists and has not landed; throws with a plain reason otherwise. */
	activeWorktree(nodeId: string): WorktreeMeta {
		const meta = this.readMeta(nodeId);
		if (!meta) throw new Error(`Node ${nodeId} has no worktree yet`);
		if (meta.landed) throw new Error(`Node ${nodeId} has already landed`);
		if (!existsSync(meta.path)) throw new Error(`The worktree of ${nodeId} no longer exists`);
		return meta;
	}

	/** Changed files outside `owns` (when set), inside `avoid`, or protected build/gate inputs. */
	violations(meta: WorktreeMeta, files: readonly string[]): string[] {
		const bad = new Set(ownershipViolations(files, { owns: meta.owns, avoid: meta.avoid }));
		for (const file of files)
			if (PROTECTED_BASENAMES.includes(basename(file)) && !matchesAny(file, meta.owns))
				bad.add(file);
		return [...bad];
	}

	async changed(meta: WorktreeMeta): Promise<{ files: string[]; violations: string[] }> {
		const files = await changedFiles(meta.path);
		return { files, violations: this.violations(meta, files) };
	}

	async diff(meta: WorktreeMeta): Promise<{ patch: string; stat: string; hash: string }> {
		const { patch, stat } = await worktreeDiff(meta.path);
		return { patch, stat, hash: hashPatch(patch) };
	}

	readGateRecord(nodeId: string): GateRecord | undefined {
		try {
			return JSON.parse(readFileSync(this.gateFile(nodeId), "utf8")) as GateRecord;
		} catch {
			return undefined;
		}
	}

	writeGateRecord(nodeId: string, record: GateRecord): void {
		const file = this.gateFile(nodeId);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(record, null, 2));
	}
}

export function confinedPath(
	root: string,
	input: string,
	options: { root?: boolean } = {},
): string {
	if (!input || input.includes("\0")) throw new Error("A path is required");
	const full = resolve(root, input);
	const sub = relative(root, full);
	if (sub === "") {
		if (options.root) return full;
		throw new Error("A file path inside the worktree is required");
	}
	if (sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub))
		throw new Error("Path escapes the worktree");
	const segments = sub.split(sep);
	if (segments.includes(".git") || segments.includes("node_modules"))
		throw new Error("Paths inside .git or node_modules are not available to factory workers");
	let probe = full;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const back = relative(realpathSync(root), realpathSync(probe));
	if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back))
		throw new Error("Path resolves outside the worktree");
	return full;
}

export function relativeUnix(root: string, full: string): string {
	return relative(root, full).split(sep).join("/");
}

export function clip(text: string): { text: string; truncated: boolean } {
	return text.length > MAX_TEXT
		? { text: text.slice(0, MAX_TEXT), truncated: true }
		: { text, truncated: false };
}
