import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { commitFile } from "./fixtures/git";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

test("the agent files pill counts what a run touched and opens Changes narrowed to those files", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	commitFile(workspace.worktreePath, "by-agent.ts", "export const a = 1;\n", "agent: add a");
	commitFile(workspace.worktreePath, "by-hand.ts", "export const b = 2;\n", "hand: add b");
	const promptAt = 1_700_000_000_000;
	const title = "Add the agent file";
	const seeded = seedWorkspaceSession(workspace.worktreePath, {
		name: title,
		messages: [
			{ role: "user", text: "add the agent file", timestamp: promptAt },
			{ role: "assistant", text: "Added by-agent.ts.", timestamp: promptAt + 4_000 },
		],
	});
	writeFileSync(
		join(E2E_DATA_DIR, "turns.json"),
		JSON.stringify({
			version: 1,
			byWorkspace: {
				[workspace.id]: [
					{
						id: `${seeded.id}:${promptAt + 500}`,
						workspaceId: workspace.id,
						sessionId: seeded.id,
						startedAt: promptAt + 500,
						settledAt: promptAt + 3_500,
						baseTree: "a".repeat(40),
						headTree: "b".repeat(40),
						changes: [{ path: "by-agent.ts", status: "added", added: 1, removed: 0 }],
					},
				],
			},
		}),
	);

	await page.reload();
	await openPersistedChat(page, title);

	const pill = page.getByTestId("agent-changes-pill");
	await expect(pill).toHaveText("1 file changed");

	await pill.click();
	await expect(page.getByTestId("files-mode-changed")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("changes-filter-agent")).toHaveAttribute("aria-pressed", "true");
	const rows = page.getByTestId("change-item");
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("by-agent.ts");

	await page.getByTestId("changes-filter-agent").click();
	await expect(page.getByTestId("changes-filter-agent")).toHaveAttribute("aria-pressed", "false");
	await expect(rows.filter({ hasText: "by-agent.ts" })).toHaveCount(1);
	await expect(rows.filter({ hasText: "by-hand.ts" })).toHaveCount(1);
	await expect(pill).toHaveText("1 file changed");
});
