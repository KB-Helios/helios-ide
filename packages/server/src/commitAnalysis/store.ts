import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CommitAnalysisRecord, isCommitAnalysisRecord } from "@thinkrail/contracts";
import { WORKSPACE_COMMITS_DIR } from "@thinkrail/shared/paths";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type RawSidecar =
	| { status: "missing" }
	| { status: "unreadable" }
	| { status: "ok"; items: Record<string, unknown> };

export function analysisSidecarPath(root: string, workspaceId: string): string {
	if (!SAFE_ID.test(workspaceId)) throw new Error("Invalid workspaceId for the analysis sidecar");
	return join(root, WORKSPACE_COMMITS_DIR, `${workspaceId}.analysis.json`);
}

function readRawSidecar(root: string, workspaceId: string): RawSidecar {
	const path = analysisSidecarPath(root, workspaceId);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "missing" }
			: { status: "unreadable" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: "unreadable" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { status: "unreadable" };
	}
	const items = (parsed as { items?: unknown }).items;
	if (typeof items !== "object" || items === null || Array.isArray(items)) {
		return { status: "unreadable" };
	}
	return { status: "ok", items: items as Record<string, unknown> };
}

export function readAnalyses(
	root: string,
	workspaceId: string,
): Record<string, CommitAnalysisRecord> {
	let raw: RawSidecar;
	try {
		raw = readRawSidecar(root, workspaceId);
	} catch {
		return {};
	}
	if (raw.status !== "ok") return {};
	const out: Record<string, CommitAnalysisRecord> = {};
	for (const [sha, value] of Object.entries(raw.items)) {
		if (isCommitAnalysisRecord(value) && value.sha === sha) out[sha] = value;
	}
	return out;
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
	const raw = readRawSidecar(root, workspaceId);
	if (raw.status === "unreadable") {
		throw new Error("commit analysis sidecar is unreadable; not overwriting it");
	}
	const items = raw.status === "ok" ? raw.items : {};
	if (Object.hasOwn(items, record.sha)) return false;
	const file = { version: 1, items: { ...items, [record.sha]: record } };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
	return true;
}
