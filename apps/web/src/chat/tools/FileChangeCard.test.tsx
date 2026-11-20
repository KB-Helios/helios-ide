import { describe, expect, it } from "bun:test";
import type { ToolRenderProps } from "@thinkrail/extension-api/web";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditCard } from "./EditCard";
import { WriteCard } from "./WriteCard";

function render(
	Card: (props: ToolRenderProps) => React.ReactNode,
	args: Record<string, unknown>,
	status: ToolRenderProps["status"] = "done",
	onOpenFile: ToolRenderProps["onOpenFile"] | null = () => {},
): string {
	const props: ToolRenderProps = {
		toolCallId: "call-1",
		toolName: "edit",
		args,
		result: { content: [{ type: "text", text: "ok" }] },
		status,
		workspaceRoot: "/repo",
		streaming: false,
		onOpenFile: onOpenFile ?? undefined,
	};
	return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Card, props)));
}

describe("file change card", () => {
	it("shows the workspace-relative path and +/- line counters for an edit", () => {
		const html = render(EditCard, {
			path: "/repo/src/a.ts",
			oldText: "one\ntwo",
			newText: "uno\ndos\ntres",
		});
		expect(html).toContain('data-testid="tool-edit"');
		expect(html).toContain(">src/a.ts</button>");
		expect(html).toContain("+3");
		expect(html).toContain("−2");
	});

	it("counts a write as additions only", () => {
		const html = render(WriteCard, { path: "notes.md", content: "a\nb\nc\n" });
		expect(html).toContain("+3");
		expect(html).not.toContain("−");
	});

	it("enables Open in Inspector only once the mutation settled and only inside the worktree", () => {
		const open = /data-testid="file-change-open"/;
		const disabled = (html: string) =>
			/<button[^>]*data-testid="file-change-open"[^>]*disabled/.test(html);
		expect(render(EditCard, { path: "a.ts" }, "done")).toMatch(open);
		expect(disabled(render(EditCard, { path: "a.ts" }, "done"))).toBe(false);
		expect(disabled(render(EditCard, { path: "a.ts" }, "running"))).toBe(true);
		expect(disabled(render(EditCard, { path: "/elsewhere/a.ts" }, "done"))).toBe(true);
	});

	it("omits the Inspector action when the host gives no way to open files", () => {
		expect(render(EditCard, { path: "a.ts" }, "done", null)).not.toContain(
			'data-testid="file-change-open"',
		);
	});

	it("renders the failure text instead of a diff when the edit failed", () => {
		const html = render(EditCard, { path: "a.ts", oldText: "x", newText: "y" }, "error");
		expect(html).toContain('data-status="error"');
		expect(html).not.toContain("bg-feedback-success-subtle");
	});
});
