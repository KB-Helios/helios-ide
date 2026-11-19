import { describe, expect, it } from "bun:test";
import type { CommitAnalysisRecord } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitAnalysisView } from "./CommitAnalysisView";

const record: CommitAnalysisRecord = {
	sha: "a".repeat(40),
	subject: "feat: x",
	analyzedAt: 1,
	analysis: {
		intent: "Retry pushes",
		summary: "Adds a bounded retry.",
		riskFlags: [
			{ severity: "high", title: "No jitter", detail: "Thundering herd.", path: "src/push.ts" },
		],
		fileNotes: [{ path: "src/push.ts", note: "Retry helper." }],
	},
	architecture: {
		modules: [
			{
				spec: "packages/server/src/pr/SPEC.md",
				module: "pr",
				paths: ["packages/server/src/pr/push.ts"],
				surfaceChanged: true,
			},
		],
		boundaryViolations: [
			{
				from: "pr",
				to: "host",
				path: "packages/server/src/pr/push.ts",
				rule: "Forbidden: host",
				detail: "imports ../host",
			},
		],
		edgesChanged: [{ from: "pr", to: "log", change: "added" }],
	},
};

describe("CommitAnalysisView", () => {
	it("renders analyzer and mapper sections read-only", () => {
		const html = renderToStaticMarkup(<CommitAnalysisView record={record} />);
		expect(html).toContain("Retry pushes");
		expect(html).toContain("No jitter");
		expect(html).toContain('data-severity="high"');
		expect(html).toContain("packages/server/src/pr/SPEC.md");
		expect(html).toContain('data-testid="commit-analysis-violation"');
		const row = html.slice(
			html.indexOf('data-testid="commit-analysis-violation"'),
			html.indexOf("</li>", html.indexOf('data-testid="commit-analysis-violation"')),
		);
		expect(row).toContain("pr → host");
		expect(row).toContain("Forbidden: host");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<textarea");
	});

	it("shows the empty marker for empty lists", () => {
		const empty = { ...record, analysis: { ...record.analysis, riskFlags: [] } };
		expect(renderToStaticMarkup(<CommitAnalysisView record={empty} />)).toContain(
			'data-testid="commit-analysis-risk-empty"',
		);
	});
});
