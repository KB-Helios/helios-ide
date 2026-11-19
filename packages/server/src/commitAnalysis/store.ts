import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CommitAnalysisRecord, isCommitAnalysisRecord } from "@thinkrail/contracts";
import { WORKSPACE_COMMITS_DIR } from "@thinkrail/shared/paths";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface SidecarFile {
	version: 1;
	items: Record<string, CommitAnalysisRecord>;
}

export function analysisSidecarPath(root: string, workspaceId: string): string {
	if (!SAFE_ID.test(workspaceId)) throw new Error("Invalid workspaceId for the analysis sidecar");
	return join(root, WORKSPACE_COMMITS_DIR, `${workspaceId}.analysis.json`);
}

export function readAnalyses(
	root: string,
	workspaceId: string,
): Record<string, CommitAnalysisRecord> {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(analysisSidecarPath(root, workspaceId), "utf8"),
		);
		const items = (parsed as { items?: unknown } | null)?.items;
		if (typeof items !== "object" || items === null) return {};
		const out: Record<string, CommitAnalysisRecord> = {};
		for (const [sha, value] of Object.entries(items)) {
			if (isCommitAnalysisRecord(value) && value.sha === sha) out[sha] = value;
		}
		return out;
	} catch {
		return {};
	}
}

export function readAnalysis(
	root: string,
	workspaceId: string,
	sha: string,
): CommitAnalysisRecord | null {
	return readAnalyses(root, workspaceId)[sha] ?? null;
}

export function writeAnalysisOnce(
	root: string,
	workspaceId: string,
	record: CommitAnalysisRecord,
): boolean {
	const path = analysisSidecarPath(root, workspaceId);
	const items = readAnalyses(root, workspaceId);
	if (items[record.sha]) return false;
	items[record.sha] = record;
	const file: SidecarFile = { version: 1, items };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
	return true;
}
