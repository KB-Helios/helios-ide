import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { editToolReplay, interceptAppWire, playStreamReplay } from "./fixtures/streamReplay";

const BASE_TS = 1_701_400_000_000;

test.use({ viewport: { width: 1600, height: 900 } });

test("Follow Agent opens an edited file in the code group without taking focus from the chat", async ({
	page,
}) => {
	const wire = await interceptAppWire(page);
	await openFixtureProject(page);
	const title = "follow agent";
	const seeded = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: title,
		messages: [{ role: "user", text: "Fix the readme", timestamp: BASE_TS }],
	});
	await enterDefaultWorkspace(page, { panels: false });
	await openPersistedChat(page, title);

	await page.getByTestId("layout-preset-menu").click();
	await page.getByTestId("layout-preset-agent-split").click();
	await expect(page.getByTestId("center-group")).toHaveCount(2);

	const input = page.getByTestId("chat-input");
	await input.click();
	await expect(input).toBeFocused();
	await expect(page.locator('[data-testid="editor-tab"][data-kind="file"]')).toHaveCount(0);

	await playStreamReplay(
		wire(),
		editToolReplay(
			seeded.id,
			{ path: "README.md", oldText: "old", newText: "new" },
			BASE_TS + 1_000,
		),
		30,
	);

	const preview = page.locator('[data-testid="editor-tab"][data-kind="file"]');
	await expect(preview).toHaveCount(1);
	await expect(preview).toContainText("README.md");
	await expect(preview).toHaveAttribute("data-preview", "true");
	await expect(input).toBeFocused();
});
