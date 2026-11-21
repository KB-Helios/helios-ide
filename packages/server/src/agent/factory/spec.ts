import { Type } from "typebox";
import { Check } from "typebox/value";

/**
 * The factory role of one DAG node. It travels in the node's frozen system prompt as a
 * `<factory-node>` JSON block, so it is part of the definition a controller or human wrote: a worker
 * cannot edit it, and a node without the block is an ordinary DAG worker that the factory extension
 * refuses to serve.
 */
const GlobList = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 });
const NodeId = Type.String({ minLength: 1, maxLength: 128 });
const Sources = Type.Array(NodeId, { minItems: 1, maxItems: 32 });

/** Failed-gate corrections a coder gets per attempt unless the plan says otherwise. */
export const DEFAULT_GATE_RETRIES = 2;
/** The most a plan may grant; the loop is always bounded. */
export const MAX_GATE_RETRIES = 5;

export const FactoryNodeSchema = Type.Union([
	Type.Object(
		{
			role: Type.Literal("coder"),
			owns: GlobList,
			avoid: GlobList,
			/** Host-enforced gate corrections per attempt; absent (an older definition) means none. */
			retries: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GATE_RETRIES })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ role: Type.Literal("gate"), source: NodeId }, { additionalProperties: false }),
	Type.Object(
		{
			role: Type.Literal("integration"),
			sources: Sources,
			/** The branch whose tip the sources are merged onto for the combined gate run. */
			target: Type.String({ minLength: 1, maxLength: 256 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			role: Type.Literal("release"),
			sources: Sources,
			/** The integration node whose verdict the report includes; absent in older definitions. */
			integration: Type.Optional(NodeId),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			role: Type.Literal("inspector"),
			sources: Sources,
			integration: Type.Optional(NodeId),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			role: Type.Literal("land"),
			sources: Sources,
			/** The integration node whose passing record landing requires; absent in older definitions: not enforced. */
			integration: Type.Optional(NodeId),
			/** The node whose human approval releases this landing. */
			release: NodeId,
			/** The branch the main checkout must have checked out for anything to land. */
			target: Type.String({ minLength: 1, maxLength: 256 }),
		},
		{ additionalProperties: false },
	),
]);

export type FactoryNode =
	| { role: "coder"; owns: string[]; avoid: string[]; retries?: number }
	| { role: "gate"; source: string }
	| { role: "integration"; sources: string[]; target: string }
	| { role: "release"; sources: string[]; integration?: string }
	| { role: "inspector"; sources: string[]; integration?: string }
	| { role: "land"; sources: string[]; release: string; target: string; integration?: string };

export type FactoryRole = FactoryNode["role"];

export const FACTORY_TOOL = {
	read: "factory_read",
	list: "factory_list",
	write: "factory_write",
	edit: "factory_edit",
	gates: "factory_run_gates",
	report: "factory_report",
	diff: "factory_diff",
	land: "factory_land",
} as const;

/** The only tools a role may call; the template also uses this as the node's `tools` allowlist. */
export const ROLE_TOOLS: Record<FactoryRole, readonly string[]> = {
	coder: [
		FACTORY_TOOL.read,
		FACTORY_TOOL.list,
		FACTORY_TOOL.write,
		FACTORY_TOOL.edit,
		FACTORY_TOOL.gates,
		FACTORY_TOOL.report,
	],
	gate: [FACTORY_TOOL.read, FACTORY_TOOL.list, FACTORY_TOOL.gates, FACTORY_TOOL.report],
	integration: [FACTORY_TOOL.report, FACTORY_TOOL.gates, FACTORY_TOOL.diff],
	release: [FACTORY_TOOL.read, FACTORY_TOOL.list, FACTORY_TOOL.report, FACTORY_TOOL.diff],
	inspector: [FACTORY_TOOL.read, FACTORY_TOOL.list, FACTORY_TOOL.report, FACTORY_TOOL.diff],
	land: [FACTORY_TOOL.report, FACTORY_TOOL.land],
};

const OPEN = "<factory-node>";
const CLOSE = "</factory-node>";

export function encodeFactoryNode(node: FactoryNode): string {
	// No "<" in the payload, so a value containing a marker cannot cut the frame; JSON.parse restores it.
	return `${OPEN}${JSON.stringify(node).replace(/</g, "\\u003c")}${CLOSE}`;
}

/** The factory role of a frozen system prompt; undefined when it carries none or an invalid one. */
export function parseFactoryNode(systemPrompt: string | undefined): FactoryNode | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.lastIndexOf(OPEN);
	if (start < 0) return undefined;
	const end = systemPrompt.indexOf(CLOSE, start);
	if (end < 0) return undefined;
	try {
		const value: unknown = JSON.parse(systemPrompt.slice(start + OPEN.length, end));
		return Check(FactoryNodeSchema, value) ? (value as FactoryNode) : undefined;
	} catch {
		return undefined;
	}
}

/** Files a coder must not touch unless its `owns` names them: they decide what the gates execute. */
export const PROTECTED_BASENAMES: readonly string[] = [
	"package.json",
	"bun.lock",
	"bun.lockb",
	"bunfig.toml",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	".npmrc",
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"Makefile",
];

const PROTECTED = new Set(PROTECTED_BASENAMES.map((name) => name.toLowerCase()));

/** A build/gate input, compared case-insensitively: `PACKAGE.JSON` is `package.json` on Windows and macOS. */
export function isProtectedBasename(name: string): boolean {
	return PROTECTED.has(name.toLowerCase().replace(/[. ]+$/, ""));
}
