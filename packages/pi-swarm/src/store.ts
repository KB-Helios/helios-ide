import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Member, Post } from "./board.ts";
import type { SwarmConfig } from "./swarm.ts";

export const SWARM_STATE_VERSION = 1;

/** Everything a person needs after a restart; live sessions, timers and in-flight runs are not part of it. */
export interface SwarmState {
	version: typeof SWARM_STATE_VERSION;
	id: string;
	parentSessionId: string;
	title: string;
	status: "running" | "finished";
	summary?: string;
	createdAt: string;
	savedAt: string;
	config: SwarmConfig;
	members: Member[];
	posts: Post[];
	coordinatorCursor: number;
}

export type SwarmLoad =
	| { kind: "missing" }
	| { kind: "ok"; state: SwarmState }
	| { kind: "corrupt"; reason: string };

/** Where one parent's board lives. The embedder injects it; synchronous so a write is never half done. */
export interface SwarmStore {
	load(): SwarmLoad;
	/** Replaces the stored board atomically: readers see the old board or the new one, never a mix. */
	save(state: SwarmState): void;
	clear(): void;
}

const MEMBER_KINDS = new Set(["worker", "verifier", "reviewer", "scout", "custom", "a2a"]);
const MEMBER_STATUSES = new Set(["active", "waiting", "paused", "killed"]);
const MEMBER_PHASES = new Set(["working", "gating", "reviewing", "needs-fixes", "done"]);
const POST_KINDS = new Set(["brief", "message", "report", "gate", "review", "system"]);
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

function fail(what: string): never {
	throw new Error(what);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, what: string): string {
	return typeof value === "string" ? value : fail(`${what} is not a string`);
}

function int(value: unknown, what: string): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: fail(`${what} is not a non-negative integer`);
}

function strings(value: unknown, what: string): string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? (value as string[])
		: fail(`${what} is not a list of strings`);
}

function oneOf(value: unknown, allowed: ReadonlySet<string>, what: string): string {
	return typeof value === "string" && allowed.has(value) ? value : fail(`${what} is not valid`);
}

function parseMember(raw: unknown, index: number): Member {
	const at = `members[${index}]`;
	if (!isRecord(raw)) return fail(`${at} is not an object`);
	const name = str(raw.name, `${at}.name`);
	if (!NAME.test(name)) fail(`${at}.name is not a member name`);
	oneOf(raw.kind, MEMBER_KINDS, `${at}.kind`);
	oneOf(raw.status, MEMBER_STATUSES, `${at}.status`);
	oneOf(raw.phase, MEMBER_PHASES, `${at}.phase`);
	int(raw.readCursor, `${at}.readCursor`);
	int(raw.fixRounds, `${at}.fixRounds`);
	str(raw.createdAt, `${at}.createdAt`);
	const brief = raw.brief;
	if (!isRecord(brief)) return fail(`${at}.brief is not an object`);
	str(brief.task, `${at}.brief.task`);
	strings(brief.owns, `${at}.brief.owns`);
	strings(brief.avoid, `${at}.brief.avoid`);
	if (raw.worktree !== undefined) {
		const tree = raw.worktree;
		if (!isRecord(tree)) return fail(`${at}.worktree is not an object`);
		str(tree.path, `${at}.worktree.path`);
		str(tree.branch, `${at}.worktree.branch`);
		str(tree.base, `${at}.worktree.base`);
	}
	if (raw.landed !== undefined && typeof raw.landed !== "boolean")
		fail(`${at}.landed is not a boolean`);
	if (raw.a2a !== undefined && !(isRecord(raw.a2a) && typeof raw.a2a.agent === "string"))
		fail(`${at}.a2a is not valid`);
	if (raw.gates !== undefined && !Array.isArray(raw.gates)) fail(`${at}.gates is not a list`);
	if (raw.changedFiles !== undefined) strings(raw.changedFiles, `${at}.changedFiles`);
	if (raw.ownershipViolations !== undefined)
		strings(raw.ownershipViolations, `${at}.ownershipViolations`);
	return raw as unknown as Member;
}

function parsePost(raw: unknown, index: number): Post {
	const at = `posts[${index}]`;
	if (!isRecord(raw)) return fail(`${at} is not an object`);
	int(raw.seq, `${at}.seq`);
	str(raw.from, `${at}.from`);
	strings(raw.to, `${at}.to`);
	oneOf(raw.kind, POST_KINDS, `${at}.kind`);
	str(raw.text, `${at}.text`);
	str(raw.at, `${at}.at`);
	return raw as unknown as Post;
}

/** Validates a stored board. Throws with the first problem found; never returns a partly valid state. */
export function parseSwarmState(text: string): SwarmState {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return fail("not valid JSON");
	}
	if (!isRecord(raw)) return fail("not an object");
	if (raw.version !== SWARM_STATE_VERSION) fail(`unsupported version ${String(raw.version)}`);
	str(raw.id, "id");
	str(raw.parentSessionId, "parentSessionId");
	str(raw.title, "title");
	str(raw.createdAt, "createdAt");
	str(raw.savedAt, "savedAt");
	oneOf(raw.status, new Set(["running", "finished"]), "status");
	const cursor = int(raw.coordinatorCursor, "coordinatorCursor");
	const config = raw.config;
	if (!isRecord(config)) return fail("config is not an object");
	str(config.title, "config.title");
	strings(config.gates, "config.gates");
	strings(config.setup, "config.setup");
	if (typeof config.review !== "boolean") fail("config.review is not a boolean");
	oneOf(config.isolation, new Set(["worktree", "shared"]), "config.isolation");
	int(config.maxFixRounds, "config.maxFixRounds");
	if (!Array.isArray(raw.members)) return fail("members is not a list");
	if (!Array.isArray(raw.posts)) return fail("posts is not a list");
	const members = raw.members.map(parseMember);
	if (new Set(members.map((m) => m.name)).size !== members.length) fail("duplicate member names");
	const posts = raw.posts.map(parsePost);
	posts.forEach((post, i) => {
		if (post.seq !== i + 1) fail(`posts[${i}].seq breaks the board order`);
	});
	if (cursor > posts.length) fail("coordinatorCursor is past the last post");
	return raw as unknown as SwarmState;
}

let beforeRename: ((file: string) => void) | undefined;

/** Test seam: runs after the temp file is written and before it is renamed over the board. */
export function setSwarmWriteSeamForTests(seam: typeof beforeRename): void {
	beforeRename = seam;
}

/**
 * A board file replaced with write-temp-then-rename, so a stop mid-write leaves the previous board intact.
 * A file that fails validation is moved aside to `<file>.corrupt` (kept as evidence) and reads as corrupt.
 */
export function createFileSwarmStore(file: string): SwarmStore {
	return {
		load() {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
				return { kind: "corrupt", reason: `unreadable: ${(error as Error).message}` };
			}
			try {
				return { kind: "ok", state: parseSwarmState(text) };
			} catch (error) {
				const reason = (error as Error).message;
				try {
					rmSync(`${file}.corrupt`, { force: true });
					renameSync(file, `${file}.corrupt`);
				} catch {}
				return { kind: "corrupt", reason };
			}
		},
		save(state) {
			mkdirSync(dirname(file), { recursive: true });
			const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
			try {
				writeFileSync(temp, JSON.stringify(state));
				beforeRename?.(file);
				renameSync(temp, file);
			} catch (error) {
				rmSync(temp, { force: true });
				throw error;
			}
		},
		clear() {
			rmSync(file, { force: true });
		},
	};
}
