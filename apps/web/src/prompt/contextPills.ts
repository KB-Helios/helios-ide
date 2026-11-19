export type ContextKind = "file" | "dir" | "artifact" | "spec" | "skill";

export interface ContextToken {
	readonly kind: ContextKind;
	readonly start: number;
	readonly end: number;
}

export interface ContextKnowledge {
	readonly specIds: ReadonlySet<string>;
	/** Full slash-command names of the skills that can be invoked, e.g. `skill:review`. */
	readonly skillCommands: ReadonlySet<string>;
}

export const NO_CONTEXT_KNOWLEDGE: ContextKnowledge = {
	specIds: new Set(),
	skillCommands: new Set(),
};

export const CONTEXT_ARTIFACT_DIR = ".thinkrail/context/";

function classify(
	text: string,
	first: boolean,
	known: ContextKnowledge,
): ContextToken["kind"] | null {
	if (text.startsWith("@") && text.length > 1) {
		const path = text.slice(1);
		if (path.startsWith(CONTEXT_ARTIFACT_DIR)) return "artifact";
		return path.endsWith("/") ? "dir" : "file";
	}
	if (text.startsWith("#") && known.specIds.has(text.slice(1))) return "spec";
	if (first && text.startsWith("/") && known.skillCommands.has(text.slice(1))) return "skill";
	return null;
}

/** Every context reference in `value`, in order. A reference is a whole whitespace-delimited token. */
export function findContextTokens(value: string, known: ContextKnowledge): ContextToken[] {
	const tokens: ContextToken[] = [];
	let first = true;
	for (const match of value.matchAll(/\S+/g)) {
		const kind = classify(match[0], first, known);
		first = false;
		if (kind) {
			tokens.push({ kind, start: match.index, end: match.index + match[0].length });
		}
	}
	return tokens;
}

/** How many distinct context references the draft carries. */
export function contextTokenCount(value: string, known: ContextKnowledge): number {
	return new Set(
		findContextTokens(value, known).map((token) => value.slice(token.start, token.end)),
	).size;
}

export type ContextTriggerChar = "@" | "#";

export interface ContextTrigger {
	readonly trigger: ContextTriggerChar;
	readonly query: string;
	/** Offset of the trigger character; the token to replace runs from here to the caret. */
	readonly start: number;
}

/** The `@` or `#` token the caret is at the end of, or `null`. */
export function activeContextTrigger(value: string, caret: number): ContextTrigger | null {
	const match = /(\S+)$/.exec(value.slice(0, caret));
	if (!match) return null;
	const token = match[0];
	const trigger = token[0];
	if (trigger !== "@" && trigger !== "#") return null;
	return { trigger, query: token.slice(1), start: caret - token.length };
}

export type ContextCandidate =
	| { readonly kind: "file" | "dir" | "artifact"; readonly path: string; readonly name: string }
	| {
			readonly kind: "spec";
			readonly id: string;
			readonly title: string;
			readonly path: string;
	  }
	| { readonly kind: "skill"; readonly command: string; readonly description?: string };

export function contextCandidateKey(candidate: ContextCandidate): string {
	switch (candidate.kind) {
		case "spec":
			return `spec:${candidate.id}`;
		case "skill":
			return `skill:${candidate.command}`;
		default:
			return `${candidate.kind}:${candidate.path}`;
	}
}

/** What picking `candidate` at `trigger` turns the draft into, and where the caret lands. */
export function insertContextCandidate(
	value: string,
	caret: number,
	trigger: ContextTrigger,
	candidate: ContextCandidate,
	known: ContextKnowledge,
): { value: string; caret: number } {
	const before = value.slice(0, trigger.start);
	const after = value.slice(caret);
	if (candidate.kind === "skill") {
		const rest = `${before}${after}`;
		const leading = /^(\s*)(\S+)/.exec(rest);
		const hasSkill = leading?.[2]?.startsWith("/") && known.skillCommands.has(leading[2].slice(1));
		const body = hasSkill && leading ? rest.slice(leading[0].length).replace(/^\s+/, "") : rest;
		const head = `/${candidate.command} `;
		return { value: `${head}${body}`, caret: head.length };
	}
	if (candidate.kind === "spec") {
		const insert = `#${candidate.id} `;
		return { value: `${before}${insert}${after}`, caret: before.length + insert.length };
	}
	const insert = candidate.kind === "dir" ? `@${candidate.path}/` : `@${candidate.path} `;
	return { value: `${before}${insert}${after}`, caret: before.length + insert.length };
}
