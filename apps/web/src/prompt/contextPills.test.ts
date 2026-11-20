import { describe, expect, it } from "bun:test";
import {
	activeContextTrigger,
	type ContextCandidate,
	type ContextKnowledge,
	contextCandidateKey,
	contextTokenCount,
	findContextTokens,
	insertContextCandidate,
	NO_CONTEXT_KNOWLEDGE,
} from "./contextPills";

const known: ContextKnowledge = {
	specIds: new Set(["module-web", "architecture"]),
	skillCommands: new Set(["skill:review"]),
};

const kinds = (value: string, knowledge = known) =>
	findContextTokens(value, knowledge).map((token) => [
		token.kind,
		value.slice(token.start, token.end),
	]);

describe("findContextTokens", () => {
	it("classifies @ paths as file, dir or artifact", () => {
		expect(kinds("see @src/a.ts and @src/ plus @.thinkrail/context/todos/x.json")).toEqual([
			["file", "@src/a.ts"],
			["dir", "@src/"],
			["artifact", "@.thinkrail/context/todos/x.json"],
		]);
	});

	it("does not treat a bare @ or an email-like word as a token", () => {
		expect(kinds("@ mail me at a@b.co")).toEqual([]);
	});

	it("recognises # only for a known spec id", () => {
		expect(kinds("update #module-web but not #fixme or #architecture.")).toEqual([
			["spec", "#module-web"],
		]);
		expect(kinds("#module-web", NO_CONTEXT_KNOWLEDGE)).toEqual([]);
	});

	it("recognises a skill only as the first token and only when known", () => {
		expect(kinds("/skill:review the diff")).toEqual([["skill", "/skill:review"]]);
		expect(kinds("run /skill:review please")).toEqual([]);
		expect(kinds("/skill:unknown go")).toEqual([]);
	});

	it("keeps offsets exact across newlines and repeated whitespace", () => {
		const value = "a\n\n  @x/y.ts\t#architecture";
		for (const token of findContextTokens(value, known)) {
			expect(value.slice(token.start, token.end)).toMatch(/^[@#]/);
		}
	});
});

describe("contextTokenCount", () => {
	it("counts distinct references once", () => {
		expect(contextTokenCount("@a.ts @a.ts @b.ts #module-web", known)).toBe(3);
		expect(contextTokenCount("nothing here", known)).toBe(0);
	});
});

describe("activeContextTrigger", () => {
	it("reads the @ or # token the caret ends", () => {
		expect(activeContextTrigger("fix @src/ap", 11)).toEqual({
			trigger: "@",
			query: "src/ap",
			start: 4,
		});
		expect(activeContextTrigger("see #arch", 9)).toEqual({ trigger: "#", query: "arch", start: 4 });
		expect(activeContextTrigger("plain text", 10)).toBeNull();
		expect(activeContextTrigger("@a b", 4)).toBeNull();
	});

	it("only considers text before the caret", () => {
		expect(activeContextTrigger("@abc def", 2)).toEqual({ trigger: "@", query: "a", start: 0 });
	});
});

describe("insertContextCandidate", () => {
	const at = (value: string, caret: number) => {
		const trigger = activeContextTrigger(value, caret);
		if (!trigger) throw new Error("no trigger");
		return trigger;
	};

	it("inserts a file as @path plus a space, a directory as @path/ so completion continues", () => {
		const file: ContextCandidate = { kind: "file", path: "src/a.ts", name: "a.ts" };
		const dir: ContextCandidate = { kind: "dir", path: "src", name: "src" };
		expect(insertContextCandidate("fix @sr more", 7, at("fix @sr more", 7), file, known)).toEqual({
			value: "fix @src/a.ts  more",
			caret: 14,
		});
		expect(insertContextCandidate("@s", 2, at("@s", 2), dir, known)).toEqual({
			value: "@src/",
			caret: 5,
		});
	});

	it("inserts a spec as #id", () => {
		const spec: ContextCandidate = {
			kind: "spec",
			id: "module-web",
			title: "Web UI client",
			path: "apps/web/SPEC.md",
		};
		expect(insertContextCandidate("see #mod", 8, at("see #mod", 8), spec, known)).toEqual({
			value: "see #module-web ",
			caret: 16,
		});
	});

	it("moves a skill to the front of the draft and replaces one already there", () => {
		const review: ContextCandidate = { kind: "skill", command: "skill:review" };
		expect(
			insertContextCandidate("fix this @rev", 13, at("fix this @rev", 13), review, known),
		).toEqual({ value: "/skill:review fix this ", caret: 14 });
		const next: ContextCandidate = { kind: "skill", command: "skill:review" };
		expect(
			insertContextCandidate(
				"/skill:review do it @x",
				22,
				at("/skill:review do it @x", 22),
				next,
				known,
			),
		).toEqual({ value: "/skill:review do it ", caret: 14 });
	});
});

describe("contextCandidateKey", () => {
	it("is unique per kind and identity", () => {
		const keys = [
			contextCandidateKey({ kind: "file", path: "a", name: "a" }),
			contextCandidateKey({ kind: "dir", path: "a", name: "a" }),
			contextCandidateKey({ kind: "spec", id: "a", title: "a", path: "a/SPEC.md" }),
			contextCandidateKey({ kind: "skill", command: "skill:a" }),
		];
		expect(new Set(keys).size).toBe(4);
	});
});
