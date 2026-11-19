import type { CommitAnalysisRecord, CommitRiskSeverity } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import type { ReactNode } from "react";

const SEVERITY: Record<
	CommitRiskSeverity,
	{
		className: string;
		label:
			| "changes.commitAnalysis.severity.high"
			| "changes.commitAnalysis.severity.medium"
			| "changes.commitAnalysis.severity.low";
	}
> = {
	high: { className: "text-feedback-error", label: "changes.commitAnalysis.severity.high" },
	medium: { className: "text-feedback-warning", label: "changes.commitAnalysis.severity.medium" },
	low: { className: "text-text-muted", label: "changes.commitAnalysis.severity.low" },
};

function Section({
	id,
	title,
	empty = false,
	children,
}: {
	id: string;
	title: string;
	empty?: boolean;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<section data-testid={`commit-analysis-${id}`} className="flex flex-col gap-4">
			<h3 className="tr-text-emphasis text-text-muted">{title}</h3>
			{empty ? (
				<p data-testid={`commit-analysis-${id}-empty`} className="tr-text-metadata text-text-muted">
					{t("changes.commitAnalysis.none")}
				</p>
			) : (
				children
			)}
		</section>
	);
}

export function CommitAnalysisView({ record }: { record: CommitAnalysisRecord }) {
	const t = useT();
	const { analysis, architecture } = record;
	return (
		<div data-testid="commit-analysis-view" className="flex flex-col gap-12">
			<Section id="intent" title={t("changes.commitAnalysis.intent")}>
				<p>{analysis.intent}</p>
			</Section>
			<Section id="summary" title={t("changes.commitAnalysis.summary")}>
				<p className="text-text-muted">{analysis.summary}</p>
			</Section>
			<Section
				id="risk"
				title={t("changes.commitAnalysis.riskFlags")}
				empty={analysis.riskFlags.length === 0}
			>
				<ul className="flex flex-col gap-8">
					{analysis.riskFlags.map((flag) => (
						<li
							key={`${flag.severity}:${flag.title}:${flag.path ?? ""}`}
							data-severity={flag.severity}
							className="flex flex-col gap-2"
						>
							<span className="flex min-w-0 items-baseline gap-8">
								<span className={cn("tr-text-emphasis", SEVERITY[flag.severity].className)}>
									{t(SEVERITY[flag.severity].label)}
								</span>
								<span>{flag.title}</span>
							</span>
							<span className="text-text-muted">{flag.detail}</span>
							{flag.path ? <code className="tr-text-metadata">{flag.path}</code> : null}
						</li>
					))}
				</ul>
			</Section>
			<Section
				id="modules"
				title={t("changes.commitAnalysis.modules")}
				empty={architecture.modules.length === 0}
			>
				<ul className="flex flex-col gap-8">
					{architecture.modules.map((module) => (
						<li key={module.spec} className="flex flex-col gap-2">
							<span className="flex min-w-0 items-baseline gap-8">
								<span className="tr-text-emphasis">{module.module}</span>
								{module.surfaceChanged ? (
									<span className="tr-text-metadata text-feedback-warning">
										{t("changes.commitAnalysis.surfaceChanged")}
									</span>
								) : null}
							</span>
							<code className="tr-text-metadata text-text-muted">{module.spec}</code>
						</li>
					))}
				</ul>
			</Section>
			<Section
				id="violations"
				title={t("changes.commitAnalysis.boundaryViolations")}
				empty={architecture.boundaryViolations.length === 0}
			>
				<ul className="flex flex-col gap-8">
					{architecture.boundaryViolations.map((violation) => (
						<li
							key={`${violation.from}:${violation.to}:${violation.path}`}
							data-testid="commit-analysis-violation"
							className="flex flex-col gap-2"
						>
							<span className="tr-text-emphasis text-feedback-error">{violation.rule}</span>
							<span className="text-text-muted">{violation.detail}</span>
							<code className="tr-text-metadata">{violation.path}</code>
						</li>
					))}
				</ul>
			</Section>
			<Section
				id="edges"
				title={t("changes.commitAnalysis.edgesChanged")}
				empty={architecture.edgesChanged.length === 0}
			>
				<ul className="flex flex-col gap-2">
					{architecture.edgesChanged.map((edge) => (
						<li key={`${edge.from}:${edge.to}:${edge.change}`}>
							{edge.change === "added"
								? t("changes.commitAnalysis.edgeAdded", { from: edge.from, to: edge.to })
								: t("changes.commitAnalysis.edgeRemoved", { from: edge.from, to: edge.to })}
						</li>
					))}
				</ul>
			</Section>
			<Section
				id="notes"
				title={t("changes.commitAnalysis.fileNotes")}
				empty={analysis.fileNotes.length === 0}
			>
				<ul className="flex flex-col gap-8">
					{analysis.fileNotes.map((note) => (
						<li key={note.path} className="flex flex-col gap-2">
							<code className="tr-text-metadata">{note.path}</code>
							<span className="text-text-muted">{note.note}</span>
						</li>
					))}
				</ul>
			</Section>
		</div>
	);
}
