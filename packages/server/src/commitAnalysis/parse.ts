import {
	type ArchitectureImpact,
	type CommitAnalysis,
	isArchitectureImpact,
	isCommitAnalysis,
} from "@thinkrail/contracts";

const LIST_CAP = {
	riskFlags: 50,
	fileNotes: 200,
	modules: 100,
	boundaryViolations: 100,
	edgesChanged: 200,
};
const slash = (path: string) => path.replaceAll("\\", "/");

export function lastFencedJson(text: string | undefined): unknown {
	if (!text) return null;
	const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
	const raw = blocks.at(-1)?.[1];
	if (raw === undefined) return null;
	try {
		return JSON.parse(raw.trim());
	} catch {
		return null;
	}
}

export function parseCommitAnalysis(text: string | undefined): CommitAnalysis | null {
	const v = lastFencedJson(text);
	if (!isCommitAnalysis(v)) return null;
	return {
		intent: v.intent,
		summary: v.summary,
		riskFlags: v.riskFlags.slice(0, LIST_CAP.riskFlags).map((f) => ({
			severity: f.severity,
			title: f.title,
			detail: f.detail,
			...(f.path !== undefined ? { path: slash(f.path) } : {}),
		})),
		fileNotes: v.fileNotes
			.slice(0, LIST_CAP.fileNotes)
			.map((n) => ({ path: slash(n.path), note: n.note })),
	};
}

export function parseArchitectureImpact(text: string | undefined): ArchitectureImpact | null {
	const v = lastFencedJson(text);
	if (!isArchitectureImpact(v)) return null;
	return {
		modules: v.modules.slice(0, LIST_CAP.modules).map((m) => ({
			spec: slash(m.spec),
			module: m.module,
			paths: m.paths.map(slash),
			surfaceChanged: m.surfaceChanged,
		})),
		boundaryViolations: v.boundaryViolations.slice(0, LIST_CAP.boundaryViolations).map((b) => ({
			from: b.from,
			to: b.to,
			path: slash(b.path),
			rule: b.rule,
			detail: b.detail,
		})),
		edgesChanged: v.edgesChanged
			.slice(0, LIST_CAP.edgesChanged)
			.map((e) => ({ from: e.from, to: e.to, change: e.change })),
	};
}
