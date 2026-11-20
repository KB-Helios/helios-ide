import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DagService } from "pi-dag";
import type { DelegationService, ResourceChildHandle } from "pi-delegation";
import { registerGateTools } from "./gateTools";
import { registerLandTool } from "./landTools";
import { FactoryRun, type FactoryRunOptions } from "./run";
import { parseFactoryNode } from "./spec";
import { registerWorktreeTools } from "./worktreeTools";

export { landFactory } from "./landTools";
export { FactoryRun } from "./run";
export {
	DEFAULT_FACTORY_SLOTS,
	dropFactorySlots,
	type FactoryQueue,
	FactorySlots,
	factoryQueueOf,
	factorySlotsFor,
	setFactorySlotLimit,
	withFactorySlots,
} from "./slots";
export {
	encodeFactoryNode,
	FACTORY_TOOL,
	type FactoryNode,
	type FactoryRole,
	parseFactoryNode,
	ROLE_TOOLS,
} from "./spec";
export {
	type BeforeRelease,
	type BeforeReleaseContext,
	buildFactoryDefinition,
	type FactoryCoderPlan,
	type FactoryPlan,
	factoryInspector,
	factoryNodeIds,
	type RoleModel,
	type TemplateRole,
} from "./template";

/** The tools a factory node may use; each refuses unless the calling session is a factory node of this DAG. */
export function factoryWorkerExtension(run: FactoryRun): ExtensionFactory {
	return (pi) => {
		registerWorktreeTools(pi, run);
		registerGateTools(pi, run);
		registerLandTool(pi, run);
	};
}

/**
 * True when `nodeId` has an approved human release gate in the DAG's own state and has completed.
 * A read only: the caller binding cannot decide anything.
 */
export async function isReleaseApprovedByHuman(
	service: DagService,
	dagId: string,
	nodeId: string,
): Promise<boolean> {
	const client = service.bind({
		caller: { kind: "owner", ownerId: "factory-land" },
		signal: new AbortController().signal,
	});
	const result = await client.getDag({ dagId });
	if (!result.ok) return false;
	const node = result.value.nodes.find((item) => item.id === nodeId);
	if (node?.status !== "completed") return false;
	const gates = result.value.gates
		.filter((gate) => gate.kind === "approval" && gate.target.nodeId === nodeId)
		.sort(
			(a, b) => a.target.attempt - b.target.attempt || a.target.activation - b.target.activation,
		);
	const latest = gates.at(-1);
	return latest?.disposition === "approved" && latest.decision?.actor.kind === "human";
}

export interface FactoryHostOptions {
	workspaceId: string;
	/** `<dataDir>/factory-worktrees/<workspaceId>`. */
	worktreeRoot: string;
	releaseApproved: FactoryRunOptions["releaseApproved"];
}

/**
 * Wraps a workspace's delegation service for one DAG service so that DAG children, and only they, get
 * the factory worker extension. `registerResource` is the one place pi-dag lets a host add child
 * extensions (the DAG id is the resource id), so ordinary subagents and swarm members never see these
 * tools. Sessions are mapped to their node from the frozen `<factory-node>` block in the system prompt
 * pi-dag passes at `createChild`/`reopenChild`; coder sessions also start with their worktree as cwd.
 */
export function withFactoryWorkers(
	delegation: DelegationService,
	host: FactoryHostOptions,
): DelegationService {
	return new Proxy(delegation, {
		get(target, property) {
			if (property !== "registerResource") {
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			const register: DelegationService["registerResource"] = async (id, context, options) => {
				const run = new FactoryRun({
					workspaceId: host.workspaceId,
					dagId: id,
					cwd: context.cwd,
					worktreeRoot: host.worktreeRoot,
					isTrusted: () => context.isProjectTrusted?.() === true,
					releaseApproved: host.releaseApproved,
				});
				const resource = await target.registerResource(id, context, {
					...options,
					childExtensionFactories: [
						...(options?.childExtensionFactories ?? []),
						factoryWorkerExtension(run),
					],
				});
				const track = (handle: ResourceChildHandle, systemPrompt: string | undefined) => {
					const node = parseFactoryNode(systemPrompt);
					const nodeId = handle.record.info.roleName;
					if (!node || !nodeId) return handle;
					run.bind(handle.sessionId, { nodeId, node });
					return {
						...handle,
						dispose: async () => {
							run.unbind(handle.sessionId);
							await handle.dispose();
						},
					};
				};
				return {
					...resource,
					createChild: async (spec) => {
						const node = parseFactoryNode(spec.session?.systemPrompt);
						const nodeId = spec.info.roleName;
						const prepared =
							node?.role === "coder" && nodeId && !spec.workspace
								? { ...spec, workspace: run.workspaceProvider(nodeId, node) }
								: spec;
						return track(await resource.createChild(prepared), spec.session?.systemPrompt);
					},
					reopenChild: async (spec) =>
						track(await resource.reopenChild(spec), spec.session.systemPrompt),
				};
			};
			return register;
		},
	});
}
