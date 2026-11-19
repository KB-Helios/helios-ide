import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "./board.ts";
import { run } from "./git.ts";

const SCRIPT_ORDER = ["typecheck", "lint", "test"] as const;

function packageManager(cwd: string): string {
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

/** The project's own typecheck → lint → test commands, from its manifest. */
export function detectGates(cwd: string): string[] {
	const manifest = join(cwd, "package.json");
	if (existsSync(manifest)) {
		try {
			const scripts =
				(JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> })
					.scripts ?? {};
			const pm = packageManager(cwd);
			return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string").map(
				(name) => `${pm} run ${name}`,
			);
		} catch {
			return [];
		}
	}
	if (existsSync(join(cwd, "Cargo.toml"))) return ["cargo check --all-targets", "cargo test"];
	if (existsSync(join(cwd, "go.mod"))) return ["go vet ./...", "go test ./..."];
	if (existsSync(join(cwd, "pyproject.toml"))) return ["python -m pytest -q"];
	return [];
}

const TAIL = 4000;

export async function runGates(
	commands: readonly string[],
	cwd: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GateResult[]> {
	const results: GateResult[] = [];
	for (const command of commands) {
		try {
			const result = await run(command, [], {
				cwd,
				shell: true,
				timeoutMs: options.timeoutMs ?? 15 * 60_000,
				...(options.signal ? { signal: options.signal } : {}),
			});
			const output = `${result.stdout}\n${result.stderr}`.trim();
			results.push({
				command,
				ok: result.code === 0,
				exitCode: result.code,
				durationMs: result.durationMs,
				outputTail: output.slice(-TAIL),
			});
			if (result.code !== 0) break;
		} catch (error) {
			results.push({
				command,
				ok: false,
				exitCode: null,
				durationMs: 0,
				outputTail: error instanceof Error ? error.message : String(error),
			});
			break;
		}
	}
	return results;
}

export function describeGates(results: readonly GateResult[]): string {
	return results
		.map(
			(result) =>
				`${result.ok ? "✓" : "✗"} ${result.command} (${Math.round(result.durationMs / 1000)}s)${
					result.ok ? "" : `\n\`\`\`\n${result.outputTail}\n\`\`\``
				}`,
		)
		.join("\n");
}
