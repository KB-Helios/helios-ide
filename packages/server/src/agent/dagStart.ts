import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	DagReplanRequest,
	DagStartFromPlanRequest,
	DagStartRequest,
	DagStartResult,
	FactoryModelChoice,
	FactoryRoleName,
	FactoryRolesView,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type { DagClient, DagDefinition, DagSnapshot } from "pi-dag";
import { getWorkspace } from "../workspaces";
import {
	buildFactoryDefinition,
	buildPlanningDefinition,
	buildReplanTask,
	PLAN_PORT,
	PLANNER_NODE_ID,
	PlanError,
	type PlanRun,
	parseCoderPlans,
	parseFactoryNode,
	parsePlanRun,
	planRunRoles,
	RELEASE_NODE,
} from "./factory";
import { DEFAULT_GATE_RETRIES, MAX_GATE_RETRIES } from "./factory/spec";
import { factoryModels, factoryReviewHook } from "./factoryReview/factoryHook";
import { FINDINGS_PORT, parseFindings, REVIEW_NODE_ID } from "./factoryReview/reviewer";
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
		task,
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
				beforeRelease: factoryReviewHook({ roles: resolved.roles, run }),
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

async function definitionOf(snapshot: DagSnapshot): Promise<DagDefinition | undefined> {
	try {
		return JSON.parse(await readFile(snapshot.definition.localPath, "utf8")) as DagDefinition;
	} catch {
		return undefined;
	}
}

/** The planning settings frozen into the planner, read from the given snapshot's own definition. */
async function planRunOf(snapshot: DagSnapshot): Promise<PlanRun | undefined> {
	const definition = await definitionOf(snapshot);
	const planner = definition?.nodes.find((node) => node.id === PLANNER_NODE_ID);
	return parsePlanRun(planner?.session?.systemPrompt);
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

	// Settings, approval and proposal all come from this one snapshot, so they always belong together.
	const snapshot = unwrapDag(await client.getDag({ dagId: planDagId }));
	const run = await planRunOf(snapshot);
	if (!run) throw new CodedError("DAG_REJECTED", "This DAG is not a planning DAG");
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
			beforeRelease: factoryReviewHook({ roles, run }),
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

type GateRead = DagSnapshot["gates"][number];

/** The latest approval gate of a node (highest attempt, then activation); later in the list wins a tie. */
function latestApproval(snapshot: DagSnapshot, nodeId: string): GateRead | undefined {
	return snapshot.gates
		.filter((gate) => gate.kind === "approval" && gate.target.nodeId === nodeId)
		.sort(
			(a, b) => a.target.attempt - b.target.attempt || a.target.activation - b.target.activation,
		)
		.at(-1);
}

const REPORT_MAX_BYTES = 64 * 1024;
const REASON_MAX = 2000;

async function textOutput(
	client: DagClient,
	dagId: string,
	proposalId: string,
	name: string,
	kind: "text" | "json",
): Promise<string | undefined> {
	try {
		const output = unwrapDag(await client.getOutput({ dagId, proposalId, name }));
		if (output.value.kind !== kind || output.value.file.sizeBytes > REPORT_MAX_BYTES)
			return undefined;
		return await readFile(output.value.file.localPath, "utf8");
	} catch {
		return undefined;
	}
}

const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"];
function severityRank(severity: string): number {
	const index = SEVERITY_RANK.indexOf(severity);
	return index < 0 ? SEVERITY_RANK.length : index;
}

/**
 * `dag.replan`: the decision a person made on a factory DAG's release (or review) gate, sent back to the
 * planner. Preconditions the host checks itself: the DAG is a factory DAG (its `release` node carries the
 * factory marker), the latest approval of the `release` node, else of the `review` node, is a **rejection**
 * a person decided, and the run's settings (roles, target, budget, original task) can be read back from the
 * DAG's own definition. Then a **new planning DAG** is created, paused, whose planner task holds the
 * original task, the person's reason, the reviewer's findings and the per-coder gate verdicts, bounded.
 * Nothing is started: running the planner, like approving its plan, is the person's own next click. Replay
 * with the same rejection returns the same planning DAG; a new rejection after a retry makes a new one.
 */
export async function replanFactory(client: DagClient, params: unknown): Promise<DagStartResult> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid DAG replan request");
	const p = params as Partial<Record<keyof DagReplanRequest, unknown>>;
	if (Object.keys(p).some((key) => key !== "workspaceId" && key !== "dagId"))
		throw new Error("Invalid DAG replan request");
	if (!isHostResourceId(p.workspaceId)) throw new Error("Invalid workspaceId");
	workspaceBranch(p.workspaceId);
	const dagId = p.dagId;
	if (typeof dagId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dagId))
		throw new Error("Invalid dagId");

	const snapshot = unwrapDag(await client.getDag({ dagId }));
	const definition = await definitionOf(snapshot);
	const release = definition?.nodes.find((node) => node.id === RELEASE_NODE);
	if (parseFactoryNode(release?.session?.systemPrompt)?.role !== "release")
		throw new CodedError("DAG_REJECTED", "This DAG is not a factory DAG");

	const rejected = [RELEASE_NODE, REVIEW_NODE_ID]
		.map((nodeId) => ({ nodeId, gate: latestApproval(snapshot, nodeId) }))
		.find(
			(entry) =>
				entry.gate?.disposition === "rejected" && entry.gate.decision?.actor.kind === "human",
		);
	const gate = rejected?.gate;
	if (!rejected || !gate?.decision)
		throw new CodedError("DAG_REJECTED", "No release or review was rejected by a person");

	const review = definition?.nodes.find((node) => node.id === REVIEW_NODE_ID);
	const run = parsePlanRun(review?.session?.systemPrompt);
	if (!run) throw new CodedError("DAG_REJECTED", "The original plan run cannot be recovered");

	let findings: ReturnType<typeof parseFindings> = parseFindings(undefined);
	const reviewNode = snapshot.nodes.find((node) => node.id === REVIEW_NODE_ID);
	if (reviewNode?.proposalId) {
		const text = await textOutput(client, dagId, reviewNode.proposalId, FINDINGS_PORT, "json");
		if (text !== undefined)
			try {
				findings = parseFindings(JSON.parse(text));
			} catch {
				// Unreadable findings are left out rather than guessed.
			}
	}
	const gates: Array<{ id: string; report: string }> = [];
	for (const node of snapshot.nodes) {
		if (!node.id.startsWith("gate-") || !node.proposalId) continue;
		const report = await textOutput(client, dagId, node.proposalId, "report", "text");
		if (report?.trim()) gates.push({ id: node.id, report });
	}

	let resolved: ResolvedRoles;
	try {
		// The stored picks are explicit overrides: the replan runs on what the person chose, and a model that
		// is no longer available is refused plainly. A same-family reviewer was allowed when it was recorded.
		resolved = await resolveFactoryRoles({
			overrides: {
				coder: run.roles.coder.model,
				reviewer: run.roles.reviewer.model,
				scout: run.roles.scout.model,
			},
			allowSameFamilyReviewer: true,
		});
	} catch (error) {
		return reject(error);
	}

	const original = run.task?.trim() || run.title;
	const next: PlanRun = { ...run, task: original, replanOf: dagId };
	let planning: DagDefinition;
	try {
		planning = buildPlanningDefinition({
			task: buildReplanTask(original, {
				reason: gate.decision.reason.slice(0, REASON_MAX),
				gate: rejected.nodeId === RELEASE_NODE ? "release" : "review",
				findings: [...findings.findings].sort(
					(a, b) => severityRank(a.severity) - severityRank(b.severity),
				),
				findingsTotal: findings.total,
				gates,
				factoryDagId: dagId,
			}),
			planner: resolved.roles.planner,
			run: next,
		});
		planning.title = `Replan: ${run.title}`;
	} catch (error) {
		return reject(error instanceof PlanError ? error : new PlanError(errorMessage(error)));
	}
	const receipt = unwrapDag(
		await client.execute({
			// Idempotent per rejection: a double-click replays the same create, while a later rejection (after
			// a retry of the rejected step) is a new decision and gets its own planning DAG.
			commandId: `replan-${createHash("sha256").update(`${dagId}\0${gate.id}`).digest("hex").slice(0, 40)}`,
			command: { kind: "create", definition: planning },
		}),
	);
	return { dagId: receipt.dagId, kind: "plan", notes: run.notes };
}
