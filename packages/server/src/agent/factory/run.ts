import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
import type { GateSandbox } from "./sandbox";
import { type FactoryNode, isProtectedBasename } from "./spec";

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
	/**
	 * The OS sandbox every gate process runs in. Unset means the platform's own (`defaultGateSandbox`); when
	 * that is missing, gates are refused rather than run unconfined.
	 */
	sandbox?: GateSandbox;
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
	/** A landing's in-flight move of the branch from `from` onto the gated commit `to` (see landTools). */
	recording?: { from: string; to: string };
}

export interface GateRecord {
	ok: boolean;
	/** Why no command ran (untrusted, no gates, ownership), when `results` is empty. */
	reason?: string;
	commands: string[];
	results: GateResult[];
	violations: string[];
	/**
	 * The git tree id of the immutable snapshot the gates ran against (`contentTree`); the record is fresh
	 * only while the worktree holds exactly that content.
	 */
	diffHash: string;
	/** The snapshot commit itself (content on top of the worktree's HEAD): what landing merges. */
	snapshot?: string;
	ranAt: string;
}

/** The host's verdict on the combined change: the target's tip with every source's landable commit merged in. */
export interface IntegrationRecord {
	ok: boolean;
	/** Why no gate ran or the combined change cannot be judged, when `results` is empty. */
	reason?: string;
	commands: string[];
	results: GateResult[];
	/** The target branch's tip the combined commit was built on; empty when it could not be resolved. */
	targetTip: string;
	/** The landable commit of every non-empty source that went into the combined change. */
	sources: Record<string, string>;
	/** The combined commit the gates ran on, and its tree; empty when none was built. */
	combined: string;
	tree: string;
	ranAt: string;
}

export interface BoundNode {
	nodeId: string;
	node: FactoryNode;
}

export const MAX_TEXT = 256 * 1024;
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
		// Replace atomically: a host stop mid-write must never leave a partial file that reads as 0 used.
		writeAtomically(file, JSON.stringify({ sessionId, used }));
		return used;
	}

	private gateFile(nodeId: string): string {
		return join(this.options.worktreeRoot, ".meta", this.options.dagId, `${nodeId}.gates.json`);
	}

	private integrationFile(nodeId: string): string {
		return join(
			this.options.worktreeRoot,
			".meta",
			this.options.dagId,
			`${nodeId}.integration.json`,
		);
	}

	readIntegrationRecord(nodeId: string): IntegrationRecord | undefined {
		try {
			return JSON.parse(readFileSync(this.integrationFile(nodeId), "utf8")) as IntegrationRecord;
		} catch {
			return undefined;
		}
	}

	writeIntegrationRecord(nodeId: string, record: IntegrationRecord): void {
		writeAtomically(this.integrationFile(nodeId), JSON.stringify(record, null, 2));
	}

	readMeta(nodeId: string): WorktreeMeta | undefined {
		try {
			return JSON.parse(readFileSync(this.metaFile(nodeId), "utf8")) as WorktreeMeta;
		} catch {
			return undefined;
		}
	}

	writeMeta(meta: WorktreeMeta): void {
		writeAtomically(this.metaFile(meta.nodeId), JSON.stringify(meta, null, 2));
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
			if (isProtectedBasename(basename(file)) && !matchesAny(file, meta.owns)) bad.add(file);
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

	private coverageFile(): string {
		return join(this.options.worktreeRoot, ".meta", this.options.dagId, "diff-coverage.json");
	}

	/** Sources whose diff an inspector was ever shown only in part; release and review reports carry it. */
	readPartialDiffs(): string[] {
		try {
			const saved = JSON.parse(readFileSync(this.coverageFile(), "utf8")) as { partial?: unknown };
			return Array.isArray(saved.partial)
				? saved.partial.filter((id): id is string => typeof id === "string")
				: [];
		} catch {
			return [];
		}
	}

	/** Records that `nodeIds`' diffs were cut when shown, so a person sees the review covered only part. */
	notePartialDiffs(nodeIds: readonly string[]): void {
		if (nodeIds.length === 0) return;
		const partial = [...new Set([...this.readPartialDiffs(), ...nodeIds])].sort();
		writeAtomically(this.coverageFile(), JSON.stringify({ partial }));
	}

	writeGateRecord(nodeId: string, record: GateRecord): void {
		writeAtomically(this.gateFile(nodeId), JSON.stringify(record, null, 2));
	}
}

/**
 * Host records are replaced, never rewritten in place: the new content goes to a private temp file that is
 * renamed over the record, so a host stop mid-write leaves the previous record intact and readable.
 */
let beforeRename: ((file: string, content: string) => void) | undefined;

/** Test seam: runs after the temp file is written and before it is renamed over the record. */
export function setRecordWriteSeamForTests(seam: typeof beforeRename): void {
	beforeRename = seam;
}

export function writeAtomically(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, content);
		beforeRename?.(file, content);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
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
	// Case-insensitive file systems (Windows, macOS) treat `.GIT` and `.git.` as `.git`; compare that way.
	const reserved = segments.map((segment) => segment.toLowerCase().replace(/[. ]+$/, ""));
	if (reserved.includes(".git") || reserved.includes("node_modules"))
		throw new Error("Paths inside .git or node_modules are not available to factory workers");
	if (segments.some((segment) => segment.includes(":")))
		throw new Error("Paths with a colon are not available to factory workers");
	// No symbolic link anywhere below the root: a dangling link would let a write land outside the
	// worktree, and a link inside it would alias a path the ownership and reserved-name checks refuse.
	let walk = root;
	for (const segment of segments) {
		walk = join(walk, segment);
		const entry = lstatSync(walk, { throwIfNoEntry: false });
		if (!entry) break;
		if (entry.isSymbolicLink())
			throw new Error("Symbolic links are not available to factory workers");
	}
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

/** The smallest share of `MAX_TEXT` one source's diff gets when several are shown in one call. */
export const MIN_DIFF_SHARE = 32 * 1024;

/**
 * One source's diff cut to `limit` characters, with an explicit marker the reader cannot miss when it was
 * cut: how much is shown and how to see the rest. A cut is never silent.
 */
export function clipDiff(
	nodeId: string,
	patch: string,
	limit: number,
): { text: string; truncated: boolean; shown: number; total: number } {
	const total = patch.length;
	if (total <= limit) return { text: patch, truncated: false, shown: total, total };
	const marker = `
[truncated: showing ${limit} of ${total} characters of ${nodeId}'s diff. Call factory_diff with source="${nodeId}" for a larger share, and open the remaining changed files (factory_report lists them) with factory_read.]
`;
	return { text: patch.slice(0, limit) + marker, truncated: true, shown: limit, total };
}

export function clip(text: string): { text: string; truncated: boolean } {
	return text.length > MAX_TEXT
		? { text: text.slice(0, MAX_TEXT), truncated: true }
		: { text, truncated: false };
}
