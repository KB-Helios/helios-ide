import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CodedError } from "@thinkrail/shared/codedError";
import { createDagExtension, createDagService, type DagService } from "pi-dag";
import { dataDir } from "../persistence";
import { trashFile } from "../trash";
import { liveParentContext } from "./agentSessionManager";
import { dagChanged, waitForDagChange } from "./dagChanges";
import { delegationServiceFor, subagentConcurrencyFor } from "./delegation";
import {
	dropFactorySlots,
	factorySlotsFor,
	isReleaseApprovedByHuman,
	withFactorySlots,
	withFactoryWorkers,
} from "./factory";
import { isHostResourceId } from "./resourceIdentity";

/**
 * Workspace-owned durable DAGs (module-pi-dag, architecture decision 17). One service per workspace
 * over that workspace's delegation service; snapshots live under the host data dir so a sidecar
 * restart reopens them paused. The parent session only controls a DAG — it never owns it.
 */
export function dagRootDir(workspaceId: string): string {
	return join(dataDir(), "dags", workspaceId);
}

/** Where factory coder worktrees live: `<dataDir>/factory-worktrees/<workspaceId>/factory-<dag>/<node>`. */
export function factoryWorktreeRoot(workspaceId: string): string {
	return join(dataDir(), "factory-worktrees", workspaceId);
}

const services = new Map<string, DagService>();
/** In-flight closes: every teardown of the workspace waits on the same one. */
const closing = new Map<string, Promise<void>>();
/** Services whose close failed: the next teardown retries them; no replacement until one succeeds. */
const unclosed = new Map<string, DagService>();

export function dagServiceFor(workspaceId: string): DagService {
	let service = services.get(workspaceId);
	if (!service) {
		if (closing.has(workspaceId) || unclosed.has(workspaceId))
			throw new CodedError(
				"RESOURCE_UNAVAILABLE",
				"This workspace's workflows are closing; try again in a moment",
			);
		// The factory worker extension reaches DAG children only through this wrapper (see agent/factory).
		const created: DagService = createDagService({
			storageRoot: dagRootDir(workspaceId),
			scope: workspaceId,
			onChange: ({ dagId }) => dagChanged(workspaceId, dagId),
			delegation: withFactorySlots(
				withFactoryWorkers(delegationServiceFor(workspaceId), {
					workspaceId,
					worktreeRoot: factoryWorktreeRoot(workspaceId),
					releaseApproved: (dagId, nodeId) => isReleaseApprovedByHuman(created, dagId, nodeId),
				}),
				factorySlotsFor(workspaceId, () => subagentConcurrencyFor(workspaceId)),
				async (dagId) => {
					const result = await created
						.bind({
							caller: { kind: "owner", ownerId: "factory-slots" },
							signal: new AbortController().signal,
						})
						.getDag({ dagId });
					// An unreadable DAG must not strand its turn in the queue: let the inner run decide.
					return !result.ok || result.value.mode === "running";
				},
				(dagId, signal) => waitForDagChange(workspaceId, dagId, signal),
			),
		});
		service = created;
		services.set(workspaceId, service);
	}
	return service;
}

/**
 * The controller adapter for one parent session. Execution runs on the parent's exact retained
 * `ModelRuntime`, never the latest registry, so DAG children stay on that parent's provider
 * generation. A session the host no longer serves projects no context and the command fails loudly.
 */
export function dagExtensionFor(workspaceId: string): ExtensionFactory {
	return createDagExtension({
		service: dagServiceFor(workspaceId),
		executionContext: (ctx) => {
			const parent = liveParentContext(ctx.sessionManager.getSessionId());
			if (!parent?.modelRuntime) return undefined;
			return {
				kind: "runtime",
				modelRuntime: parent.modelRuntime,
				cwd: parent.cwd,
				...(parent.model
					? { model: { provider: parent.model.provider, id: parent.model.id } }
					: {}),
				thinkingLevel: parent.thinkingLevel,
				...(parent.isProjectTrusted ? { isProjectTrusted: parent.isProjectTrusted } : {}),
			};
		},
	});
}

/** Settles live DAG work and releases process ownership; durable state stays resumable. */
export function closeWorkspaceDag(workspaceId: string): Promise<void> {
	const inflight = closing.get(workspaceId);
	if (inflight) return inflight;
	const service = services.get(workspaceId) ?? unclosed.get(workspaceId);
	if (!service) return Promise.resolve();
	services.delete(workspaceId);
	const close = (async () => {
		try {
			await service.close();
			unclosed.delete(workspaceId);
			// Only a clean close frees the slot pool: a failed one may still have turns holding slots.
			dropFactorySlots(workspaceId);
		} catch (error) {
			unclosed.set(workspaceId, service);
			throw error;
		} finally {
			closing.delete(workspaceId);
		}
	})();
	closing.set(workspaceId, close);
	return close;
}

/**
 * Host shutdown: closes every live service and retries every failed one; in-flight workspace closes are
 * awaited too. It does not gate `dagServiceFor` (the host is going down, and tests reuse workspaces).
 */
export async function closeAllDags(): Promise<void> {
	const pending = [...services, ...unclosed];
	services.clear();
	unclosed.clear();
	for (const [workspaceId] of pending) dropFactorySlots(workspaceId);
	const settling = [...pending.map(([, service]) => service.close()), ...closing.values()];
	const failures = (await Promise.allSettled(settling)).filter(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failures.length)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"DAG shutdown failed",
		);
}

/**
 * A close that failed (live work or durable cleanup did not settle) stops the removal: the store is the
 * recovery evidence, so it is deleted or trashed only after the service closed cleanly.
 */
export async function removeWorkspaceDag(workspaceId: string): Promise<void> {
	assertWorkspaceStorageId(workspaceId);
	await closeWorkspaceDag(workspaceId);
	rmSync(dagRootDir(workspaceId), { recursive: true, force: true });
}

/** Recoverable twin of `removeWorkspaceDag`: the store goes to the Trash. */
export async function trashWorkspaceDag(workspaceId: string): Promise<void> {
	assertWorkspaceStorageId(workspaceId);
	await closeWorkspaceDag(workspaceId);
	const store = dagRootDir(workspaceId);
	if (existsSync(store)) await trashFile(store);
}

function assertWorkspaceStorageId(value: string): void {
	if (!isHostResourceId(value)) throw new Error("Invalid workspaceId: not a plain id");
}
