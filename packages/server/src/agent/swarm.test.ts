import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFileSwarmStore, SWARM_STATE_VERSION, type SwarmState } from "pi-swarm";
import { setTrashImplementationForTests } from "../trash";
import { removeWorkspaceSessions } from "./agentSessionManager";
import { delegationServiceFor, removeWorkspaceDelegation } from "./delegation";
import {
	disposeSessionSwarm,
	readSessionSwarm,
	removeWorkspaceSwarm,
	swarmFor,
	swarmStoreDir,
	trashWorkspaceSwarm,
} from "./swarm";

const root = mkdtempSync(join(tmpdir(), "trswarm-"));
const cwd = join(root, "project");
let priorDataDir: string | undefined;
let serial = 0;

beforeAll(() => {
	priorDataDir = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	mkdirSync(cwd, { recursive: true });
});

afterAll(() => {
	if (priorDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = priorDataDir;
	rmSync(root, { recursive: true, force: true });
});

function ids() {
	serial += 1;
	return {
		workspaceId: `ws-swarm-${serial}`,
		sessionId: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
	};
}

function boardFile(workspaceId: string, sessionId: string): string {
	return join(swarmStoreDir(workspaceId), `${sessionId}.json`);
}

function storedBoard(sessionId: string): SwarmState {
	const member = (name: string, status: "active" | "waiting", phase: "working" | "done") => ({
		name,
		kind: "scout" as const,
		status,
		phase,
		brief: { task: `Look into ${name}`, owns: [], avoid: [] },
		readCursor: 0,
		fixRounds: 0,
		activity: "reading",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return {
		version: SWARM_STATE_VERSION,
		id: "22222222-2222-4222-8222-222222222222",
		parentSessionId: sessionId,
		title: "Survive a restart",
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		savedAt: "2026-01-01T00:00:00.000Z",
		config: {
			title: "Survive a restart",
			gates: [],
			review: false,
			isolation: "shared",
			setup: [],
			maxFixRounds: 3,
		},
		members: [member("alpha", "active", "working"), member("beta", "waiting", "done")],
		posts: [
			{
				seq: 1,
				from: "coordinator",
				to: ["alpha"],
				kind: "brief",
				text: "@alpha look",
				at: "2026-01-01T00:00:00.000Z",
			},
		],
		coordinatorCursor: 1,
	};
}

/** Plays pi's part: hands the extension its API and fires `session_start` for the session. */
async function startSession(
	owner: ReturnType<typeof swarmFor>,
	sessionId: string,
	startCwd = cwd,
): Promise<void> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			void handlers.set(event, handler),
		registerCommand: () => {},
		registerTool: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [],
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	await owner.extension(pi);
	const ctx = {
		cwd: startCwd,
		sessionManager: { getSessionId: () => sessionId },
		isProjectTrusted: () => false,
		isIdle: () => true,
		modelRegistry: { getAvailable: () => [] },
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
}

test("a stored board comes back paused when its chat session starts, and nothing runs", async () => {
	const { workspaceId, sessionId } = ids();
	createFileSwarmStore(boardFile(workspaceId, sessionId)).save(storedBoard(sessionId));

	const owner = swarmFor(workspaceId, sessionId, () => true);
	expect(readSessionSwarm(workspaceId, sessionId)).toBeNull();
	await startSession(owner, sessionId);

	const snapshot = readSessionSwarm(workspaceId, sessionId);
	expect(snapshot?.id).toBe("22222222-2222-4222-8222-222222222222");
	expect(snapshot?.title).toBe("Survive a restart");
	expect(snapshot?.members.map((m) => [m.name, m.status, m.restored])).toEqual([
		["alpha", "paused", true],
		["beta", "paused", true],
	]);
	expect(snapshot?.members[0]?.activity).toBeUndefined();
	expect(snapshot?.members[1]?.phase).toBe("done");
	expect(snapshot?.posts.at(-1)?.text).toContain("Restored after a host restart");
	expect(
		owner
			.current()
			?.restoredMembers()
			.map((m) => m.name),
	).toEqual(["alpha", "beta"]);
	// No member turn was started: the workspace has no child session for this chat.
	expect(delegationServiceFor(workspaceId).childrenOf(sessionId)).toEqual([]);

	await disposeSessionSwarm(sessionId);
	removeWorkspaceSwarm(workspaceId);
	removeWorkspaceDelegation(workspaceId);
});

test("a board that is corrupt or belongs to another chat is not restored and the host keeps going", async () => {
	const corrupt = ids();
	mkdirSync(swarmStoreDir(corrupt.workspaceId), { recursive: true });
	await Bun.write(boardFile(corrupt.workspaceId, corrupt.sessionId), '{"version":1,"id":');
	const ownerA = swarmFor(corrupt.workspaceId, corrupt.sessionId, () => true);
	await startSession(ownerA, corrupt.sessionId);
	expect(readSessionSwarm(corrupt.workspaceId, corrupt.sessionId)).toBeNull();
	expect(existsSync(`${boardFile(corrupt.workspaceId, corrupt.sessionId)}.corrupt`)).toBe(true);

	const foreign = ids();
	createFileSwarmStore(boardFile(foreign.workspaceId, foreign.sessionId)).save(
		storedBoard("another-session"),
	);
	const ownerB = swarmFor(foreign.workspaceId, foreign.sessionId, () => true);
	await startSession(ownerB, foreign.sessionId);
	expect(readSessionSwarm(foreign.workspaceId, foreign.sessionId)).toBeNull();

	await disposeSessionSwarm(corrupt.sessionId);
	await disposeSessionSwarm(foreign.sessionId);
	removeWorkspaceSwarm(corrupt.workspaceId);
	removeWorkspaceSwarm(foreign.workspaceId);
});

test("a restored board is saved again as it changes and when its owner is disposed", async () => {
	const { workspaceId, sessionId } = ids();
	const file = boardFile(workspaceId, sessionId);
	createFileSwarmStore(file).save(storedBoard(sessionId));
	const owner = swarmFor(workspaceId, sessionId, () => true);
	await startSession(owner, sessionId);
	owner.current()?.post("coordinator", "after the restart", "message", []);
	await Promise.resolve();
	expect(readFileSync(file, "utf8")).toContain("after the restart");
	await disposeSessionSwarm(sessionId);
	const stored = JSON.parse(readFileSync(file, "utf8")) as SwarmState;
	expect(stored.posts.at(-1)?.text).toBe("after the restart");
	removeWorkspaceSwarm(workspaceId);
	removeWorkspaceDelegation(workspaceId);
});

test("archiving a workspace removes its boards, and a disposed owner cannot write one back", async () => {
	const { workspaceId, sessionId } = ids();
	const file = boardFile(workspaceId, sessionId);
	createFileSwarmStore(file).save(storedBoard(sessionId));
	const owner = swarmFor(workspaceId, sessionId, () => true);
	await startSession(owner, sessionId);
	expect(existsSync(file)).toBe(true);

	// Closing the workspace's sessions disposes each owner (its last write) before the teardown deletes.
	await disposeSessionSwarm(sessionId);
	expect(existsSync(file)).toBe(true);
	await removeWorkspaceSessions(workspaceId);
	expect(existsSync(swarmStoreDir(workspaceId))).toBe(false);
	owner.current()?.post("coordinator", "too late", "message", []);
	await Promise.resolve();
	expect(existsSync(file)).toBe(false);
	removeWorkspaceDelegation(workspaceId);
});

test("deleting a chat trashes the boards instead of deleting them", async () => {
	const { workspaceId, sessionId } = ids();
	createFileSwarmStore(boardFile(workspaceId, sessionId)).save(storedBoard(sessionId));
	const trashed: string[] = [];
	setTrashImplementationForTests(async (input) => {
		trashed.push(...(typeof input === "string" ? [input] : input));
	});
	try {
		await trashWorkspaceSwarm(workspaceId);
	} finally {
		setTrashImplementationForTests(undefined);
	}
	expect(trashed).toEqual([swarmStoreDir(workspaceId)]);
	await trashWorkspaceSwarm("ws-without-boards");
	await expect(trashWorkspaceSwarm("../escape")).rejects.toThrow("Invalid workspaceId");
	expect(() => removeWorkspaceSwarm("../escape")).toThrow("Invalid workspaceId");
	rmSync(swarmStoreDir(workspaceId), { recursive: true, force: true });
});
