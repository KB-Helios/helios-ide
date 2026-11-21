/** One coder row of the start form; `owns` and `avoid` are one glob per line. */
export interface CoderDraft {
	/** Stable row identity for the list; never sent. */
	key: string;
	id: string;
	task: string;
	owns: string;
	avoid: string;
}

/** The host's limits (`packages/server/src/agent/factory/plan.ts`), mirrored so the form refuses what the host would. */
export const MAX_PLAN_CODERS = 8;
export const MAX_GLOBS = 64;
export const MAX_CODER_TASK = 8000;
const MAX_GLOB_CHARS = 512;
const CODER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS: ReadonlySet<string> = new Set(["release", "land", "review", "planner"]);

export const newCoder = (key: string, id = ""): CoderDraft => ({
	key,
	id,
	task: "",
	owns: "",
	avoid: "",
});

/** The globs of a one-per-line field: trimmed, blank lines dropped. */
export function parseGlobs(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function literalPrefix(glob: string): string {
	const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	const wildcard = normalized.search(/[*?]/);
	return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

/** Port of the host's conservative `mayOverlap` (`factory/template.ts`): keep the two in step. */
export function mayOverlap(a: readonly string[], b: readonly string[]): boolean {
	if (a.length === 0 || b.length === 0) return true;
	return a.some((left) =>
		b.some((right) => {
			const l = literalPrefix(left);
			const r = literalPrefix(right);
			return l.startsWith(r) || r.startsWith(l);
		}),
	);
}

function globsInvalid(globs: readonly string[]): boolean {
	if (globs.length > MAX_GLOBS) return true;
	return globs.some((glob) => {
		const normalized = glob.replace(/\\/g, "/");
		return (
			glob.length > MAX_GLOB_CHARS ||
			normalized.includes("\0") ||
			normalized.startsWith("/") ||
			/^[A-Za-z]:/.test(normalized) ||
			normalized.split("/").includes("..")
		);
	});
}

export type CoderIssueCode =
	| "id-invalid"
	| "id-reserved"
	| "id-duplicate"
	| "task-missing"
	| "task-long"
	| "owns-required"
	| "owns-invalid"
	| "avoid-invalid"
	| "overlap";

export interface CoderIssue {
	key: string;
	code: CoderIssueCode;
	/** The earlier coder's id, for `overlap`. */
	other?: string;
}

/**
 * Why the coders cannot be sent, by row, using the host's rules (`parseCoderPlans`): ids plain, unique and
 * not reserved; a task each (a sole coder may leave it empty and take the run's task); globs inside the
 * repository; `owns` given and disjoint once several coders run. The host re-checks all of it.
 */
export function coderIssues(coders: readonly CoderDraft[], runTask: string): CoderIssue[] {
	const issues: CoderIssue[] = [];
	const seen = new Set<string>();
	const owned = coders.map((coder) => parseGlobs(coder.owns));
	for (const [index, coder] of coders.entries()) {
		const id = coder.id.trim();
		const add = (code: CoderIssueCode) => issues.push({ key: coder.key, code });
		if (!CODER_ID.test(id)) add("id-invalid");
		else if (RESERVED_IDS.has(id) || id.startsWith("gate-")) add("id-reserved");
		else if (seen.has(id)) add("id-duplicate");
		seen.add(id);
		const task = coder.task.trim() || (coders.length === 1 ? runTask.trim() : "");
		if (task.length === 0) add("task-missing");
		else if (task.length > MAX_CODER_TASK) add("task-long");
		const own = owned[index] ?? [];
		if (globsInvalid(own)) add("owns-invalid");
		else if (coders.length > 1 && own.length === 0) add("owns-required");
		if (globsInvalid(parseGlobs(coder.avoid))) add("avoid-invalid");
	}
	for (const [index, coder] of coders.entries())
		for (const [offset, later] of coders.slice(index + 1).entries()) {
			const left = owned[index] ?? [];
			const right = owned[index + 1 + offset] ?? [];
			if (left.length && right.length && mayOverlap(left, right))
				issues.push({ key: later.key, code: "overlap", other: coder.id.trim() });
		}
	return issues;
}
