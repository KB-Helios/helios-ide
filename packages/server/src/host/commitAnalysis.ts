import type { CommitAnalyzedPayload } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { liveSessionIdsOf, runReviewSubagent } from "../agent";
import {
	type CommitAnalyzer,
	type CommitSubagentRunner,
	createCommitAnalyzer,
	isMergeCommit,
	readCommitPackage,
} from "../commitAnalysis";
import { gitHeadSha, resolveListedCommit } from "../git";
import { loadWorkspaces } from "../persistence";
import { getConfig } from "../settings";
import { resolveNewChatModel } from "./newChatModel";

let publish: (payload: CommitAnalyzedPayload) => void = () => {};
let runner: CommitSubagentRunner = runReviewSubagent;
let analyzer: CommitAnalyzer | null = null;

export function setCommitAnalyzedPublisher(
	fn: ((payload: CommitAnalyzedPayload) => void) | null,
): void {
	publish = fn ?? (() => {});
}

export function installCommitAnalysisRunnerForTests(fn: CommitSubagentRunner): void {
	runner = fn;
	analyzer = null;
}

export function commitAnalyzer(): CommitAnalyzer {
	analyzer ??= createCommitAnalyzer({
		runSubagent: (...args) => runner(...args),
		async resolveModel() {
			const cfg = getConfig();
			const def = await resolveNewChatModel({});
			const model = cfg.reviewModel ?? def.model;
			return {
				...(model ? { model: { provider: model.provider, id: model.id } } : {}),
				thinkingLevel: cfg.reviewEffort ?? def.thinkingLevel,
			};
		},
		worktreeOf: (workspaceId) =>
			loadWorkspaces().find((w) => w.id === workspaceId)?.worktreePath ?? null,
		readCommit: readCommitPackage,
		isMerge: isMergeCommit,
		resolveParent: (workspaceId, preferred) => {
			const live = liveSessionIdsOf(workspaceId);
			return live.includes(preferred) ? preferred : (live[0] ?? null);
		},
		headOf: gitHeadSha,
		publish: (payload) => publish(payload),
		now: Date.now,
	});
	return analyzer;
}

export function requestCommitAnalysis(
	workspaceId: string,
	sha: string,
	sessionId?: string,
	liveSessions: (workspaceId: string) => string[] = liveSessionIdsOf,
): { status: "stored" | "queued" } {
	const canonical = resolveListedCommit(workspaceId, sha);
	if (!canonical)
		throw new CodedError("COMMIT_ANALYSIS_NOT_LISTED", "That commit is not on this branch");
	if (commitAnalyzer().get(workspaceId, canonical)) return { status: "stored" };
	const live = liveSessions(workspaceId);
	const parent = sessionId && live.includes(sessionId) ? sessionId : live[0];
	if (!parent)
		throw new CodedError(
			"COMMIT_ANALYSIS_NO_SESSION",
			"Open a chat in this workspace to analyze commits",
		);
	void commitAnalyzer().analyzeCommit(workspaceId, canonical, parent, "manual");
	return { status: "queued" };
}

export function disposeCommitAnalysis(): void {
	analyzer = null;
	runner = runReviewSubagent;
	publish = () => {};
}
