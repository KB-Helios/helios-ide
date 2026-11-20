import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	DagStartFromPlanRequest,
	DagStartRequest,
	DagStartResult,
	FactoryModelChoice,
	FactoryRoleName,
	FactoryRolesView,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type { DagClient, DagDefinition } from "pi-dag";
import { getWorkspace } from "../workspaces";
import {
	buildFactoryDefinition,
	buildPlanningDefinition,
	PLAN_PORT,
	PLANNER_NODE_ID,
	PlanError,
	type PlanRun,
	parseCoderPlans,
	parsePlanRun,
	planRunRoles,
} from "./factory";
import { DEFAULT_GATE_RETRIES, MAX_GATE_RETRIES } from "./factory/spec";
import { factoryModels, factoryReviewHook } from "./factoryReview/factoryHook";
import {
	availableFactoryModels,
	FACTORY_ROLES,
	FactoryRoleError,
	modelFamily,
	type ResolvedRoles,
	resolveFactoryRoles,
} from "./factoryReview/roles";
import { isHostResourceId } from "./resourceIdentity";

const TASK_MAX = 8000;
const TITLE_MAX = 80;
const PLAN_MAX_BYTES = 256 * 1024;
const MODELS_MAX = 500;

function reject(error: unknown): never {
	if (error instanceof FactoryRoleError || error instanceof PlanError)
		throw new CodedError("DAG_REJECTED", error.message);
	throw error;
}

function workspaceBranch(workspaceId: string): string {
	if (!isHostResourceId(workspaceId)) throw new Error("Invalid workspaceId");
	try {
		const { branch } = getWorkspace(workspaceId);
		if (!branch) throw new Error("no branch");
		return branch;
	} catch {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Workspace unavailable");
	}
}

function choice(value: unknown, role: string): FactoryModelChoice {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid ${role} model`);
	const { provider, id, ...rest } = value as Record<string, unknown>;
	if (
		Object.keys(rest).length ||
		typeof provider !== "string" ||
		typeof id !== "string" ||
		!provider ||
		!id ||
		provider.length > 128 ||
		id.length > 256
	)
		throw new Error(`Invalid ${role} model`);
	return { provider, id };
}

function overrides(value: unknown): Partial<Record<FactoryRoleName, FactoryModelChoice>> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid roles");
	const result: Partial<Record<FactoryRoleName, FactoryModelChoice>> = {};
	for (const [role, model] of Object.entries(value)) {
		if (!(FACTORY_ROLES as readonly string[]).includes(role)) throw new Error("Invalid roles");
		result[role as FactoryRoleName] = choice(model, role);
	}
	return result;
}

/** The models a person may pick per role, and what the host would choose by itself. */
export async function readFactoryRoles(workspaceId: string): Promise<FactoryRolesView> {
	workspaceBranch(workspaceId);
	const models = await availableFactoryModels();
	let resolved: ResolvedRoles;
	try {
		resolved = await resolveFactoryRoles({ allowSameFamilyReviewer: true });
	} catch (error) {
		return reject(error);
	}
	const defaults = Object.fromEntries(
		FACTORY_ROLES.map((role) => [role, { ...resolved.roles[role].model }]),
	) as Record<FactoryRoleName, FactoryModelChoice>;
	return {
		models: models.slice(0, MODELS_MAX).map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			family: modelFamily(model),
			reasoning: model.reasoning === true,
		})),
		defaults,
		sameFamilyOnly: resolved.notes.length > 0,
	};
}

function titleOf(task: string): string {
	const line = task.trim().split(/\r?\n/, 1)[0] ?? "";
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Starts a factory run for a person. The caller binding is the human one (set by the wire), the DAG is
 * created paused, and every model, glob and budget is validated here: a person's pick must be available
 * and the reviewer must be another family than the coder unless they explicitly allowed it, in which case
 * the departure is recorded in the DAG (the release question) and returned.
 */
export async function startFactory(client: DagClient, params: unknown): Promise<DagStartResult> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid DAG start request");
	const p = params as Partial<Record<keyof DagStartRequest, unknown>>;
	const allowed = [
		"workspaceId",
		"commandId",
		"task",
		"coders",
		"roles",
		"allowSameFamilyReviewer",
		"gateRetries",
	];
	if (Object.keys(p).some((key) => !allowed.includes(key)))
		throw new Error("Invalid DAG start request");
	if (!isHostResourceId(p.workspaceId)) throw new Error("Invalid workspaceId");
	const workspaceId = p.workspaceId;
	const target = workspaceBranch(workspaceId);
	if (typeof p.commandId !== "string" || !p.commandId || p.commandId.length > 128)
		throw new Error("Invalid commandId");
	if (typeof p.task !== "string" || !p.task.trim() || p.task.length > TASK_MAX)
		throw new Error("Invalid task");
	if (p.allowSameFamilyReviewer !== undefined && typeof p.allowSameFamilyReviewer !== "boolean")
		throw new Error("Invalid allowSameFamilyReviewer");
	// Only an absent field defaults; `null` or any other non-number is an invalid request (0 stays valid).
	const gateRetries = p.gateRetries === undefined ? DEFAULT_GATE_RETRIES : p.gateRetries;
	if (
		typeof gateRetries !== "number" ||
		!Number.isInteger(gateRetries) ||
		gateRetries < 0 ||
		gateRetries > MAX_GATE_RETRIES
	)
		throw new Error("Invalid gateRetries");
	const task = p.task.trim();
	const picked = overrides(p.roles);

	let resolved: ResolvedRoles;
	try {
		resolved = await resolveFactoryRoles({
			overrides: picked,
			allowSameFamilyReviewer: p.allowSameFamilyReviewer === true,
		});
	} catch (error) {
		return reject(error);
	}
	const notes = resolved.notes.map((note) => note.message);
	const title = titleOf(task);
	const run: PlanRun = {
		title,
		target,
		gateRetries,
		notes,
		roles: planRunRoles(resolved.roles),
	};

	let definition: DagDefinition;
	let kind: DagStartResult["kind"];
	try {
		if (p.coders !== undefined) {
			definition = buildFactoryDefinition({
				title: `Factory: ${title}`,
				target,
				coders: parseCoderPlans(p.coders),
				gateRetries,
				notes,
				models: factoryModels(resolved.roles),
				beforeRelease: factoryReviewHook({ roles: resolved.roles }),
			});
			kind = "factory";
		} else {
			definition = buildPlanningDefinition({ task, planner: resolved.roles.planner, run });
			kind = "plan";
		}
	} catch (error) {
		return reject(error instanceof PlanError ? error : new PlanError(errorMessage(error)));
	}
	const receipt = unwrapDag(
		await client.execute({ commandId: p.commandId, command: { kind: "create", definition } }),
	);
	return { dagId: receipt.dagId, kind, notes };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unwrapDag<T>(
	result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
	if (result.ok) return result.value;
	throw new CodedError("DAG_REJECTED", result.error.message);
}

/** The roles, target and budget frozen into a planning DAG's planner node, from its stored definition. */
async function planRunOf(client: DagClient, dagId: string): Promise<PlanRun | undefined> {
	const snapshot = unwrapDag(await client.getDag({ dagId }));
	try {
		const raw = await readFile(snapshot.definition.localPath, "utf8");
		const definition = JSON.parse(raw) as DagDefinition;
		const planner = definition.nodes.find((node) => node.id === PLANNER_NODE_ID);
		return parsePlanRun(planner?.session?.systemPrompt);
	} catch {
		return undefined;
	}
}

/**
 * Creates the factory DAG from an approved plan. Preconditions the host checks itself, whatever the UI
 * showed: the DAG is a planning DAG made by `startFactory`, its planner has completed, and the latest
 * approval of that node was given by a **human** (a controller or owner cannot). The plan is read from the
 * planner's `plan` output and validated again as if a person had typed it; the roles, target and gate
 * budget are the ones frozen at start. The result is a paused factory DAG with its own human release.
 * Replaying with the same plan DAG returns the same factory DAG.
 */
export async function startFactoryFromPlan(
	client: DagClient,
	params: unknown,
): Promise<DagStartResult> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid DAG start request");
	const p = params as Partial<Record<keyof DagStartFromPlanRequest, unknown>>;
	if (Object.keys(p).some((key) => key !== "workspaceId" && key !== "planDagId"))
		throw new Error("Invalid DAG start request");
	if (!isHostResourceId(p.workspaceId)) throw new Error("Invalid workspaceId");
	const workspaceId = p.workspaceId;
	workspaceBranch(workspaceId);
	const planDagId = p.planDagId;
	if (typeof planDagId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planDagId))
		throw new Error("Invalid dagId");

	const run = await planRunOf(client, planDagId);
	if (!run) throw new CodedError("DAG_REJECTED", "This DAG is not a planning DAG");
	const snapshot = unwrapDag(await client.getDag({ dagId: planDagId }));
	const planner = snapshot.nodes.find((node) => node.id === PLANNER_NODE_ID);
	if (planner?.status !== "completed" || !planner.proposalId)
		throw new CodedError("DAG_REJECTED", "The plan has not been completed yet");
	// The approval must come from the same snapshot and name the very proposal that is read below, so a
	// retry that replaces the planner's proposal can never promote a plan no person approved.
	const approval = snapshot.gates
		.filter((gate) => gate.kind === "approval" && gate.target.nodeId === PLANNER_NODE_ID)
		.sort(
			(a, b) => a.target.attempt - b.target.attempt || a.target.activation - b.target.activation,
		)
		.at(-1);
	if (
		approval?.disposition !== "approved" ||
		approval.decision?.actor.kind !== "human" ||
		approval.proposalId !== planner.proposalId
	)
		throw new CodedError("DAG_REJECTED", "The plan has not been approved by a person");

	const output = unwrapDag(
		await client.getOutput({ dagId: planDagId, proposalId: planner.proposalId, name: PLAN_PORT }),
	);
	let plan: unknown;
	try {
		if (output.value.kind !== "json" || output.value.file.sizeBytes > PLAN_MAX_BYTES)
			throw new PlanError("The plan is missing or too large");
		plan = JSON.parse(await readFile(output.value.file.localPath, "utf8"));
	} catch (error) {
		return reject(error instanceof PlanError ? error : new PlanError("The plan could not be read"));
	}

	let definition: DagDefinition;
	try {
		const coders = parseCoderPlans(plan);
		const roles = {
			coder: { ...run.roles.coder, family: "" },
			reviewer: { ...run.roles.reviewer, family: "" },
			scout: { ...run.roles.scout, family: "" },
		};
		definition = buildFactoryDefinition({
			title: `Factory: ${run.title}`,
			target: run.target,
			coders,
			gateRetries: run.gateRetries,
			notes: run.notes,
			models: factoryModels(roles),
			beforeRelease: factoryReviewHook({ roles }),
		});
	} catch (error) {
		return reject(error instanceof PlanError ? error : new PlanError(errorMessage(error)));
	}
	const receipt = unwrapDag(
		await client.execute({
			// Idempotent per approved proposal: a double-click replays the same create, while a corrected
			// plan approved after a planner retry builds a new factory DAG instead of returning the old one.
			commandId: `factory-from-${createHash("sha256").update(`${planDagId}\0${planner.proposalId}`).digest("hex").slice(0, 40)}`,
			command: { kind: "create", definition },
		}),
	);
	return { dagId: receipt.dagId, kind: "factory", notes: run.notes };
}
