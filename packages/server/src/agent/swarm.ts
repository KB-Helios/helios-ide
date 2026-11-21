import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SwarmChanged, SwarmDiff, SwarmSnapshot } from "@thinkrail/contracts";
import { createFileSwarmStore, createSwarm, type SwarmOwner, type SwarmStore } from "pi-swarm";
import { logger } from "../log";
import { dataDir } from "../persistence";
import { trashFile } from "../trash";
import { delegationServiceFor } from "./delegation";
import { isHostResourceId, isPiSessionId } from "./resourceIdentity";

const log = logger("swarm");
const owners = new Map<string, { workspaceId: string; owner: SwarmOwner }>();
let publish: (payload: SwarmChanged) => void = () => {};

export function setSwarmPublisher(next: ((payload: SwarmChanged) => void) | null): void {
	publish = next ?? (() => {});
}

export function swarmWorktreeRoot(workspaceId: string): string {
	return join(dataDir(), "swarm-worktrees", workspaceId);
}

/** Where a workspace's swarm boards live: `<dataDir>/swarms/<workspaceId>/<sessionId>.json`. */
export function swarmStoreDir(workspaceId: string): string {
	return join(dataDir(), "swarms", workspaceId);
}

function swarmStoreFor(workspaceId: string, sessionId: string): SwarmStore | undefined {
	if (!isHostResourceId(workspaceId) || !isPiSessionId(sessionId)) return undefined;
	return createFileSwarmStore(join(swarmStoreDir(workspaceId), `${sessionId}.json`));
}

/**
 * The per-session swarm owner: its coordinator tools live in the session, its members are delegation children.
 * The board is kept under the data dir and restored, paused, when this session starts again after a restart.
 */
export function swarmFor(
	workspaceId: string,
	sessionId: string,
	canDeliver: () => boolean,
): SwarmOwner {
	const store = swarmStoreFor(workspaceId, sessionId);
	const owner = createSwarm({
		service: delegationServiceFor(workspaceId),
		worktreeRoot: swarmWorktreeRoot(workspaceId),
		canDeliver,
		onChange: (snapshot) => publish({ workspaceId, sessionId, snapshot }),
		...(store
			? {
					store,
					onStoreError: (error: unknown) =>
						log.warn("the swarm board was not saved or restored", error),
				}
			: {}),
	});
	owners.set(sessionId, { workspaceId, owner });
	return owner;
}

export async function disposeSessionSwarm(sessionId: string): Promise<void> {
	const entry = owners.get(sessionId);
	owners.delete(sessionId);
	await entry?.owner.dispose().catch(() => {});
}

function assertWorkspaceStorageId(value: string): void {
	if (!isHostResourceId(value)) throw new Error("Invalid workspaceId: not a plain id");
}

function forgetWorkspaceOwners(workspaceId: string): void {
	for (const [sessionId, entry] of owners)
		if (entry.workspaceId === workspaceId) owners.delete(sessionId);
}

/**
 * Archive twin of the DAG and delegation removals: the boards go with the workspace. Run it after the
 * workspace's sessions closed (each disposed owner has already written its last board), so none can
 * write a board back afterwards.
 */
export function removeWorkspaceSwarm(workspaceId: string): void {
	assertWorkspaceStorageId(workspaceId);
	forgetWorkspaceOwners(workspaceId);
	rmSync(swarmStoreDir(workspaceId), { recursive: true, force: true });
}

/** Recoverable twin of `removeWorkspaceSwarm`: the boards go to the Trash. */
export async function trashWorkspaceSwarm(workspaceId: string): Promise<void> {
	assertWorkspaceStorageId(workspaceId);
	forgetWorkspaceOwners(workspaceId);
	const store = swarmStoreDir(workspaceId);
	if (existsSync(store)) await trashFile(store);
}

function ownedSwarm(workspaceId: string, sessionId: string) {
	const entry = owners.get(sessionId);
	return entry?.workspaceId === workspaceId ? entry.owner.current() : undefined;
}

export function readSessionSwarm(workspaceId: string, sessionId: string): SwarmSnapshot | null {
	return ownedSwarm(workspaceId, sessionId)?.snapshot() ?? null;
}

const MAX_PATCH = 400_000;

export async function readSwarmMemberDiff(
	workspaceId: string,
	sessionId: string,
	member: string,
): Promise<SwarmDiff> {
	const swarm = ownedSwarm(workspaceId, sessionId);
	if (!swarm) throw new Error("No swarm in this chat");
	const { patch, stat } = await swarm.diff(member);
	return patch.length > MAX_PATCH
		? { member, stat, patch: patch.slice(0, MAX_PATCH), truncated: true }
		: { member, stat, patch, truncated: false };
}
