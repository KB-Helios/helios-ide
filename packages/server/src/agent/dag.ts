import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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

export function dagServiceFor(workspaceId: string): DagService {
	let service = services.get(workspaceId);
	if (!service) {
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
export async function closeWorkspaceDag(workspaceId: string): Promise<void> {
	const service = services.get(workspaceId);
	services.delete(workspaceId);
	try {
		await service?.close();
	} finally {
		dropFactorySlots(workspaceId);
	}
}

export async function closeAllDags(): Promise<void> {
	const ids = [...services.keys()];
	const closing = [...services.values()].map((service) => service.close());
	services.clear();
	for (const workspaceId of ids) dropFactorySlots(workspaceId);
	const failures = (await Promise.allSettled(closing)).filter(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failures.length)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"DAG shutdown failed",
		);
}

export async function removeWorkspaceDag(workspaceId: string): Promise<void> {
	assertWorkspaceStorageId(workspaceId);
	await closeWorkspaceDag(workspaceId).catch(() => {});
	rmSync(dagRootDir(workspaceId), { recursive: true, force: true });
}

/** Recoverable twin of `removeWorkspaceDag`: the store goes to the Trash. */
export async function trashWorkspaceDag(workspaceId: string): Promise<void> {
	assertWorkspaceStorageId(workspaceId);
	await closeWorkspaceDag(workspaceId).catch(() => {});
	const store = dagRootDir(workspaceId);
	if (existsSync(store)) await trashFile(store);
}

function assertWorkspaceStorageId(value: string): void {
	if (!isHostResourceId(value)) throw new Error("Invalid workspaceId: not a plain id");
}
