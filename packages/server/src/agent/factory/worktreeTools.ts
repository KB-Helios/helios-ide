import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundFor, sourceWorktree, toolResult } from "./access";
import { clip, confinedPath, type FactoryRun, MAX_WRITE, relativeUnix } from "./run";
import { FACTORY_TOOL } from "./spec";

const Source = Type.Optional(
	Type.String({ description: "Source node id; only needed when this node has several sources." }),
);

/**
 * File tools confined to a factory worktree. A coder has no other way to write: its allowlist omits
 * pi's own `write`/`edit`/`bash`, and every path here is resolved inside the worktree (no `..`, no
 * symlink out, no `.git`, no `node_modules`), then checked against the node's ownership globs.
 */
export function registerWorktreeTools(pi: ExtensionAPI, run: FactoryRun): void {
	pi.registerTool({
		name: FACTORY_TOOL.read,
		label: "Read worktree file",
		description:
			"Read a text file from a factory worktree (path relative to the worktree). Optional 1-based startLine and lineCount.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1 }),
			startLine: Type.Optional(Type.Integer({ minimum: 1 })),
			lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
			source: Source,
		}),
		async execute(_id, args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.read);
			const meta = sourceWorktree(run, bound, args.source);
			const full = confinedPath(meta.path, args.path);
			if (!statSync(full).isFile()) throw new Error(`${args.path} is not a file`);
			let text = readFileSync(full, "utf8");
			if (args.startLine !== undefined || args.lineCount !== undefined) {
				const start = (args.startLine ?? 1) - 1;
				text = text
					.split("\n")
					.slice(start, args.lineCount === undefined ? undefined : start + args.lineCount)
					.join("\n");
			}
			return toolResult({ path: relativeUnix(meta.path, full), ...clip(text) });
		},
	});

	pi.registerTool({
		name: FACTORY_TOOL.list,
		label: "List worktree directory",
		description:
			"List one directory of a factory worktree (default: its root). Directories end with '/'.",
		parameters: Type.Object({ path: Type.Optional(Type.String()), source: Source }),
		async execute(_id, args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.list);
			const meta = sourceWorktree(run, bound, args.source);
			const full = confinedPath(meta.path, args.path || ".", { root: true });
			const entries = readdirSync(full, { withFileTypes: true })
				.filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
				.sort();
			return toolResult({
				path: relativeUnix(meta.path, full) || ".",
				entries: entries.slice(0, 500),
			});
		},
	});

	pi.registerTool({
		name: FACTORY_TOOL.write,
		label: "Write worktree file",
		description:
			"Create or overwrite a text file in your own worktree. Refused outside your owned paths, inside avoided paths, and for build manifests you do not own.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1 }),
			content: Type.String({ maxLength: MAX_WRITE }),
		}),
		async execute(_id, args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.write);
			const meta = sourceWorktree(run, bound, undefined);
			const full = confinedPath(meta.path, args.path);
			const rel = relativeUnix(meta.path, full);
			const violations = run.violations(meta, [rel]);
			if (violations.length) throw new Error(`${rel} is outside this node's ownership`);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, args.content);
			return toolResult({ path: rel, bytes: Buffer.byteLength(args.content) });
		},
	});

	pi.registerTool({
		name: FACTORY_TOOL.edit,
		label: "Edit worktree file",
		description:
			"Replace one exact occurrence of oldText with newText in a file of your own worktree. Fails when oldText is missing or not unique.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1 }),
			oldText: Type.String({ minLength: 1 }),
			newText: Type.String({ maxLength: MAX_WRITE }),
		}),
		async execute(_id, args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.edit);
			const meta = sourceWorktree(run, bound, undefined);
			const full = confinedPath(meta.path, args.path);
			const rel = relativeUnix(meta.path, full);
			const violations = run.violations(meta, [rel]);
			if (violations.length) throw new Error(`${rel} is outside this node's ownership`);
			const text = readFileSync(full, "utf8");
			const first = text.indexOf(args.oldText);
			if (first < 0) throw new Error("oldText was not found");
			if (text.indexOf(args.oldText, first + 1) >= 0)
				throw new Error("oldText is not unique; include more context");
			writeFileSync(
				full,
				text.slice(0, first) + args.newText + text.slice(first + args.oldText.length),
			);
			return toolResult({ path: rel });
		},
	});
}
