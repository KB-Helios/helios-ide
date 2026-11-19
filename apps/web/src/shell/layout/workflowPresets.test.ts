import { describe, expect, it } from "bun:test";
import {
	BUILTIN_LAYOUT_PRESETS,
	DEFAULT_LAYOUT_PRESET_ID,
	frameMatchesPreset,
	instantiateWorkbenchFrame,
	resolveLayoutPreset,
	WORKFLOW_LAYOUT_PRESET_IDS,
} from "./presets";

describe("workflow layout presets", () => {
	it("are appended after the original built-ins and leave the default alone", () => {
		expect(BUILTIN_LAYOUT_PRESETS.slice(0, 4).map((preset) => preset.id)).toEqual([
			"codex",
			"balanced",
			"focus",
			"review",
		]);
		expect(BUILTIN_LAYOUT_PRESETS.slice(4).map((preset) => preset.id)).toEqual([
			...WORKFLOW_LAYOUT_PRESET_IDS,
		]);
		expect(DEFAULT_LAYOUT_PRESET_ID).toBe("codex");
	});

	it("resolve by id and place every tool exactly once", () => {
		for (const id of WORKFLOW_LAYOUT_PRESET_IDS) {
			const preset = resolveLayoutPreset(id, []);
			expect(preset.id).toBe(id);
			const tools = [preset.left, preset.right, preset.bottom].flatMap((region) =>
				region.groups.flatMap((group) => group.tools),
			);
			expect(tools).toHaveLength(6);
			expect(new Set(tools).size).toBe(6);
		}
	});

	it("give Agent + Code Split and Code Focus a two-group center, Review Mode one wide Review side", () => {
		const agent = resolveLayoutPreset("agent-split", []);
		const code = resolveLayoutPreset("code-focus", []);
		const review = resolveLayoutPreset("review-mode", []);
		for (const preset of [agent, code]) {
			expect(preset.center.kind).toBe("split");
			if (preset.center.kind === "split") expect(preset.center.direction).toBe("horizontal");
		}
		if (agent.center.kind === "split") expect(agent.center.weights).toEqual([0.42, 0.58]);
		if (code.center.kind === "split") expect(code.center.weights).toEqual([0.78, 0.22]);
		expect(review.center.kind).toBe("group");
		expect(review.right.visible).toBe(true);
		expect(review.right.groups[0]?.tools).toEqual(["review"]);
		expect(agent.left.visible).toBe(true);
		expect(code.left.visible).toBe(false);
	});

	it("instantiate into a frame that matches themselves and no other workflow preset", () => {
		for (const id of WORKFLOW_LAYOUT_PRESET_IDS) {
			const preset = resolveLayoutPreset(id, []);
			const frame = instantiateWorkbenchFrame(preset);
			expect(frameMatchesPreset(frame, preset)).toBe(true);
			for (const other of WORKFLOW_LAYOUT_PRESET_IDS) {
				if (other !== id) {
					expect(frameMatchesPreset(frame, resolveLayoutPreset(other, []))).toBe(false);
				}
			}
		}
	});
});
