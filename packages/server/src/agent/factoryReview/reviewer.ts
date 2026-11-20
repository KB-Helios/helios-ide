import type { DagReviewFinding, DagReviewSeverity } from "@thinkrail/contracts";
import type { DagConnection, DagNodeSpec } from "pi-dag";
import type { RoleSelection } from "./roles";

/**
 * The reviewer piece of the AI factory (ai-factory.md step 4): one read-only node on a model family
 * other than the coder's, plus the human approval that blocks release until its findings are answered.
 * It is a standalone builder — it returns node specs and connections for a template to insert, and
 * never owns the DAG.
 */
export const REVIEW_NODE_ID = "review";
/** The one reviewer output port; `dag.review` reads this port and nothing else. */
export const FINDINGS_PORT = "findings";
export const DIFF_PORT = "diff";
/** Read-only pi tools: no write, edit or bash (bash can mutate), so the reviewer cannot change code. */
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

export const SEVERITIES: readonly DagReviewSeverity[] = [
	"critical",
	"high",
	"medium",
	"low",
	"info",
];

export const REVIEWER_SYSTEM_PROMPT = [
	"You are an independent code reviewer. You read; you never change anything.",
	"You have read-only tools. Judge the merged diff you are given, opening files only to understand context.",
	"Report only concrete problems in the diff: bugs, regressions, missing tests, security or data-loss risks.",
	"Do not praise, summarise or restate the change.",
].join("\n");

function reviewTask(focus: string | undefined): string {
	return [
		`Review the merged diff in your \`${DIFF_PORT}\` input. It is the combined result of the parallel coders, not a single branch.`,
		focus ? `Focus: ${focus}` : "",
		`Submit exactly one output, \`${FINDINGS_PORT}\`, as {kind:'json'} with this shape:`,
		'{"findings":[{"severity":"critical|high|medium|low|info","file":"path/relative/to/repo","summary":"one concrete sentence"}]}',
		'Submit {"findings":[]} when you found nothing. A person decides on release either way; your findings are what they read first.',
	]
		.filter(Boolean)
		.join("\n");
}

export interface ReviewerPieceOptions {
	/** The reviewer role resolved by `resolveRoleModels`; its model is written into the node. */
	reviewer: RoleSelection;
	/** Where the merged diff comes from: the join node's output port. */
	diff: { nodeId: string; output: string; kind?: "text" | "artifact" };
	/** The node that must not start before a human has answered the findings (the release node). */
	release: string;
	/** Node id; defaults to `review`. Also the prefix of the connection ids. */
	nodeId?: string;
	/** An extra line telling the reviewer what to weigh most. */
	focus?: string;
}

export interface ReviewerPiece {
	nodeId: string;
	nodes: DagNodeSpec[];
	connections: DagConnection[];
}

/**
 * The reviewer node, its `diff` data connection and the control connection that holds `release` behind
 * it. Release is always a person's: the node carries a human-authority approval, so it completes (and
 * releases `release`) only after the human approves, whether or not it found anything. A reject keeps
 * the node, and with it the release, blocked. The gate question is static pi-dag text, so the findings
 * count is not in it: the pane shows the count from the findings output beside the gate.
 */
export function buildReviewerPiece(options: ReviewerPieceOptions): ReviewerPiece {
	const nodeId = options.nodeId ?? REVIEW_NODE_ID;
	const node: DagNodeSpec = {
		id: nodeId,
		task: reviewTask(options.focus),
		session: {
			model: options.reviewer.model,
			thinkingLevel: options.reviewer.thinkingLevel,
			tools: [...REVIEWER_TOOLS],
			systemPrompt: REVIEWER_SYSTEM_PROMPT,
		},
		inputs: { [DIFF_PORT]: { kind: options.diff.kind ?? "text" } },
		outputs: { [FINDINGS_PORT]: { kind: "json" } },
		approval: {
			authority: "human",
			question:
				"The independent reviewer has submitted its findings. Approve to release only when each finding is answered or accepted; reject with the reason to keep the release blocked.",
		},
	};
	return {
		nodeId,
		nodes: [node],
		connections: [
			{
				id: `${nodeId}-diff`,
				kind: "data",
				from: { nodeId: options.diff.nodeId, output: options.diff.output },
				to: { nodeId, input: DIFF_PORT },
			},
			{
				id: `${nodeId}-before-release`,
				kind: "control",
				from: nodeId,
				to: options.release,
				allowSkipped: false,
			},
		],
	};
}

/** A reviewer node declares exactly one output, the json `findings` port. */
export function isReviewerNode(outputs: Record<string, { kind: string }>): boolean {
	const ports = Object.keys(outputs);
	return (
		ports.length === 1 && ports[0] === FINDINGS_PORT && outputs[FINDINGS_PORT]?.kind === "json"
	);
}

const PAGE = 50;
const FILE_MAX = 512;
const SUMMARY_MAX = 500;

export interface ParsedFindings {
	/** `false`: the reviewer submitted something other than the findings shape; the count is unknown. */
	valid: boolean;
	total: number;
	findings: DagReviewFinding[];
	truncated: boolean;
}

/**
 * Reads a reviewer's `findings` value into the bounded wire shape. Strict on purpose: one malformed
 * entry invalidates the whole value, so a broken review is never shown as a clean or partial one.
 */
export function parseFindings(value: unknown): ParsedFindings {
	const invalid: ParsedFindings = { valid: false, total: 0, findings: [], truncated: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
	const list = (value as { findings?: unknown }).findings;
	if (!Array.isArray(list)) return invalid;
	const findings: DagReviewFinding[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid;
		const { severity, file, summary } = entry as Record<string, unknown>;
		if (
			typeof severity !== "string" ||
			!SEVERITIES.includes(severity as DagReviewSeverity) ||
			typeof file !== "string" ||
			typeof summary !== "string"
		)
			return invalid;
		if (findings.length < PAGE)
			findings.push({
				severity: severity as DagReviewSeverity,
				file: file.slice(0, FILE_MAX),
				summary: summary.slice(0, SUMMARY_MAX),
			});
	}
	return { valid: true, total: list.length, findings, truncated: list.length > findings.length };
}
