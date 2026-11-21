import { expect, test } from "bun:test";
import { FACTORY_CAP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { FactorySettings, parseFactoryCap } from "./FactorySettings";

test("the cap accepts whole numbers 1 to 64 and never clamps", () => {
	expect(parseFactoryCap("1")).toBe(1);
	expect(parseFactoryCap("64")).toBe(64);
	for (const draft of ["", "0", "65", "-1", "2.5", "1e1", "abc", " 8"])
		expect(parseFactoryCap(draft)).toBeNull();
});

test("the cap is offered only to a host that stores it, showing the current value", () => {
	const render = (protocolVersion: number | null) =>
		renderToStaticMarkup(
			<FactorySettings protocolVersion={protocolVersion} value={12} onChange={() => {}} />,
		);
	expect(render(null)).toBe("");
	expect(render(FACTORY_CAP_PROTOCOL_VERSION - 1)).toBe("");
	const markup = render(FACTORY_CAP_PROTOCOL_VERSION);
	expect(markup).toContain('data-testid="settings-factory"');
	const input = markup.match(/<input[^>]*data-testid="factory-cap-input"[^>]*>/)?.[0];
	expect(input).toContain('value="12"');
	expect(input).toContain('min="1"');
	expect(input).toContain('max="64"');
	expect(input).toContain("data-settings-draft-input");
});
