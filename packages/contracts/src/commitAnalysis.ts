export const COMMIT_RISK_SEVERITIES = ["high", "medium", "low"] as const;
export type CommitRiskSeverity = (typeof COMMIT_RISK_SEVERITIES)[number];

export interface CommitRiskFlag {
	severity: CommitRiskSeverity;
	title: string;
	detail: string;
	path?: string;
}

export interface CommitFileNote {
	path: string;
	note: string;
}

export interface CommitAnalysis {
	intent: string;
	summary: string;
	riskFlags: CommitRiskFlag[];
	fileNotes: CommitFileNote[];
}

export interface ArchitectureModuleImpact {
	spec: string;
	module: string;
	paths: string[];
	surfaceChanged: boolean;
}

export interface ArchitectureBoundaryViolation {
	from: string;
	to: string;
	path: string;
	rule: string;
	detail: string;
}

export interface ArchitectureEdgeChange {
	from: string;
	to: string;
	change: "added" | "removed";
}

export interface ArchitectureImpact {
	modules: ArchitectureModuleImpact[];
	boundaryViolations: ArchitectureBoundaryViolation[];
	edgesChanged: ArchitectureEdgeChange[];
}

export interface CommitAnalysisRecord {
	sha: string;
	subject: string;
	analyzedAt: number;
	model?: string;
	analysis: CommitAnalysis;
	architecture: ArchitectureImpact;
}

export interface CommitAnalyzedPayload {
	workspaceId: string;
	sha: string;
	status: "completed" | "failed";
	code?: string;
}

const FULL_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isOptStr = (v: unknown): boolean => v === undefined || isStr(v);
const arrayOf = (v: unknown, item: (x: unknown) => boolean): boolean =>
	Array.isArray(v) && v.every(item);

const isRiskFlag = (v: unknown): v is CommitRiskFlag =>
	isObj(v) &&
	(COMMIT_RISK_SEVERITIES as readonly unknown[]).includes(v.severity) &&
	isStr(v.title) &&
	isStr(v.detail) &&
	isOptStr(v.path);

const isFileNote = (v: unknown): v is CommitFileNote => isObj(v) && isStr(v.path) && isStr(v.note);

const isModuleImpact = (v: unknown): v is ArchitectureModuleImpact =>
	isObj(v) &&
	isStr(v.spec) &&
	isStr(v.module) &&
	arrayOf(v.paths, isStr) &&
	typeof v.surfaceChanged === "boolean";

const isBoundaryViolation = (v: unknown): v is ArchitectureBoundaryViolation =>
	isObj(v) && isStr(v.from) && isStr(v.to) && isStr(v.path) && isStr(v.rule) && isStr(v.detail);

const isEdgeChange = (v: unknown): v is ArchitectureEdgeChange =>
	isObj(v) && isStr(v.from) && isStr(v.to) && (v.change === "added" || v.change === "removed");

export function isCommitAnalysis(v: unknown): v is CommitAnalysis {
	return (
		isObj(v) &&
		isStr(v.intent) &&
		isStr(v.summary) &&
		arrayOf(v.riskFlags, isRiskFlag) &&
		arrayOf(v.fileNotes, isFileNote)
	);
}

export function isArchitectureImpact(v: unknown): v is ArchitectureImpact {
	return (
		isObj(v) &&
		arrayOf(v.modules, isModuleImpact) &&
		arrayOf(v.boundaryViolations, isBoundaryViolation) &&
		arrayOf(v.edgesChanged, isEdgeChange)
	);
}

export function isCommitAnalysisRecord(v: unknown): v is CommitAnalysisRecord {
	return (
		isObj(v) &&
		isStr(v.sha) &&
		FULL_OID.test(v.sha) &&
		isStr(v.subject) &&
		typeof v.analyzedAt === "number" &&
		isOptStr(v.model) &&
		isCommitAnalysis(v.analysis) &&
		isArchitectureImpact(v.architecture)
	);
}
