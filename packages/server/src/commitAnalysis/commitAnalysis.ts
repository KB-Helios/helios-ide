import type {
	CommitAnalysisRecord,
	CommitAnalyzedPayload,
	ThinkingLevel,
} from "@thinkrail/contracts";
import { logger } from "../log";
import { type CommitPackage, renderCommitTask } from "./commitPackage";
import { parseArchitectureImpact, parseCommitAnalysis } from "./parse";
import {
	ANALYZER_OUTPUT_CONTRACT,
	ANALYZER_SYSTEM_PROMPT,
	ANALYZER_TOOLS,
	MAPPER_OUTPUT_CONTRACT,
	MAPPER_SYSTEM_PROMPT,
	MAPPER_TOOLS,
} from "./roles";
import { readAnalyses, readAnalysis, writeAnalysisOnce } from "./store";

const log = logger("commit-analysis");
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export type CommitSubagentRunner = (
	workspaceId: string,
	parentSessionId: string,
	task: string,
	role: {
		systemPrompt: string;
		tools: string[];
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	},
	signal?: AbortSignal,
	info?: { createdBy: string; roleName: string },
) => Promise<{ status: string; finalText?: string }>;

export interface CommitAnalysisDeps {
	runSubagent: CommitSubagentRunner;
	resolveModel: () => Promise<{
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	}>;
	worktreeOf: (workspaceId: string) => string | null;
	readCommit: (
		workspaceId: string,
		worktreePath: string,
		sha: string,
	) => Promise<CommitPackage | null>;
	publish: (payload: CommitAnalyzedPayload) => void;
	now: () => number;
	timeoutMs?: number;
}

export interface CommitAnalyzer {
	analyzeCommit(
		workspaceId: string,
		sha: string,
		parentSessionId: string,
		source: "auto" | "manual",
	): Promise<CommitAnalysisRecord | null>;
	analyzeNewCommits(
		workspaceId: string,
		parentSessionId: string,
		shas: readonly string[],
	): Promise<void>;
	get(workspaceId: string, sha: string): CommitAnalysisRecord | null;
	list(workspaceId: string): { shas: string[]; pending: string[] };
	isPending(workspaceId: string, sha: string): boolean;
	settle(workspaceId: string): Promise<void>;
	forget(workspaceId: string): void;
}

class AnalysisFailure extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export function createCommitAnalyzer(deps: CommitAnalysisDeps): CommitAnalyzer {
	const chains = new Map<string, Promise<void>>();
	const pending = new Map<string, Set<string>>();
	const attempted = new Map<string, Set<string>>();
	const setOf = (map: Map<string, Set<string>>, key: string) => {
		const existing = map.get(key);
		if (existing) return existing;
		const created = new Set<string>();
		map.set(key, created);
		return created;
	};
	const rootOf = (workspaceId: string): string | null => {
		try {
			return deps.worktreeOf(workspaceId);
		} catch {
			return null;
		}
	};
	const storedOf = (workspaceId: string, sha: string): CommitAnalysisRecord | null => {
		const root = rootOf(workspaceId);
		return root ? readAnalysis(root, workspaceId, sha) : null;
	};

	const enqueue = <T>(workspaceId: string, run: () => Promise<T>): Promise<T> => {
		const result = (chains.get(workspaceId) ?? Promise.resolve()).then(run);
		const next = result.then(
			() => {},
			() => {},
		);
		chains.set(workspaceId, next);
		void next.finally(() => {
			if (chains.get(workspaceId) === next) chains.delete(workspaceId);
		});
		return result;
	};

	async function runOnce(
		workspaceId: string,
		sha: string,
		parentSessionId: string,
	): Promise<CommitAnalysisRecord> {
		const root = deps.worktreeOf(workspaceId);
		if (!root) throw new AnalysisFailure("COMMIT_ANALYSIS_NO_WORKSPACE");
		const stored = readAnalysis(root, workspaceId, sha);
		if (stored) return stored;
		const pkg = await deps.readCommit(workspaceId, root, sha);
		if (!pkg) throw new AnalysisFailure("COMMIT_ANALYSIS_UNKNOWN_COMMIT");
		const existing = readAnalysis(root, workspaceId, pkg.sha);
		if (existing) return existing;
		const { model, thinkingLevel } = await deps.resolveModel();
		const role = (systemPrompt: string, tools: string[]) => ({
			systemPrompt,
			tools,
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
		const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const [analyzerRun, mapperRun] = await Promise.all([
			deps.runSubagent(
				workspaceId,
				parentSessionId,
				renderCommitTask(pkg, ANALYZER_OUTPUT_CONTRACT),
				role(ANALYZER_SYSTEM_PROMPT, ANALYZER_TOOLS),
				signal,
				{ createdBy: "host:commit-analysis", roleName: "commit-analyzer" },
			),
			deps.runSubagent(
				workspaceId,
				parentSessionId,
				renderCommitTask(pkg, MAPPER_OUTPUT_CONTRACT),
				role(MAPPER_SYSTEM_PROMPT, MAPPER_TOOLS),
				signal,
				{ createdBy: "host:commit-analysis", roleName: "architecture-mapper" },
			),
		]);
		if (analyzerRun.status !== "completed" || mapperRun.status !== "completed")
			throw new AnalysisFailure("COMMIT_ANALYSIS_CHILD_FAILED");
		const analysis = parseCommitAnalysis(analyzerRun.finalText);
		const architecture = parseArchitectureImpact(mapperRun.finalText);
		if (!analysis || !architecture) throw new AnalysisFailure("COMMIT_ANALYSIS_INVALID_OUTPUT");
		const record: CommitAnalysisRecord = {
			sha: pkg.sha,
			subject: pkg.subject,
			analyzedAt: deps.now(),
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			analysis,
			architecture,
		};
		writeAnalysisOnce(root, workspaceId, record);
		return readAnalysis(root, workspaceId, pkg.sha) ?? record;
	}

	const publish = (payload: CommitAnalyzedPayload) => {
		try {
			deps.publish(payload);
		} catch (error) {
			log.warn("commit.analyzed publish failed", error);
		}
	};

	const analyzer: CommitAnalyzer = {
		analyzeCommit(workspaceId, sha, parentSessionId, source) {
			const stored = storedOf(workspaceId, sha);
			if (stored) return Promise.resolve(stored);
			if (source === "auto") setOf(attempted, workspaceId).add(sha);
			setOf(pending, workspaceId).add(sha);
			return enqueue(workspaceId, () => runOnce(workspaceId, sha, parentSessionId))
				.then(
					(record) => {
						publish({ workspaceId, sha, status: "completed" });
						return record;
					},
					(error: unknown) => {
						const code = error instanceof AnalysisFailure ? error.code : "COMMIT_ANALYSIS_FAILED";
						if (!(error instanceof AnalysisFailure))
							log.warn(`commit analysis failed (${workspaceId}/${sha})`, error);
						publish({ workspaceId, sha, status: "failed", code });
						return null;
					},
				)
				.finally(() => {
					pending.get(workspaceId)?.delete(sha);
				});
		},
		async analyzeNewCommits(workspaceId, parentSessionId, shas) {
			try {
				const root = rootOf(workspaceId);
				if (!root) return;
				const stored = readAnalyses(root, workspaceId);
				const tried = setOf(attempted, workspaceId);
				const queued = setOf(pending, workspaceId);
				for (const sha of new Set(shas)) {
					if (stored[sha] || tried.has(sha) || queued.has(sha)) continue;
					void analyzer.analyzeCommit(workspaceId, sha, parentSessionId, "auto");
				}
			} catch (error) {
				log.warn(`commit analysis trigger skipped (${workspaceId})`, error);
			}
		},
		get: (workspaceId, sha) => storedOf(workspaceId, sha),
		list(workspaceId) {
			const root = rootOf(workspaceId);
			return {
				shas: root ? Object.keys(readAnalyses(root, workspaceId)) : [],
				pending: [...(pending.get(workspaceId) ?? [])],
			};
		},
		isPending: (workspaceId, sha) => pending.get(workspaceId)?.has(sha) ?? false,
		async settle(workspaceId) {
			let current = chains.get(workspaceId);
			while (current) {
				await current;
				const next = chains.get(workspaceId);
				if (next === current) return;
				current = next;
			}
		},
		forget(workspaceId) {
			pending.delete(workspaceId);
			attempted.delete(workspaceId);
		},
	};
	return analyzer;
}
