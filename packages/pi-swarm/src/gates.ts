import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "./board.ts";
import { type ExecResult, run } from "./git.ts";

const SCRIPT_ORDER = ["typecheck", "lint", "test"] as const;

function packageManager(cwd: string): string {
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

/**
 * The project's own typecheck → lint → test commands, from its manifest. An unreadable manifest throws:
 * "no checks found" must never be confused with "checks could not be determined".
 */
export function detectGates(cwd: string): string[] {
	const manifest = join(cwd, "package.json");
	if (existsSync(manifest)) {
		let scripts: Record<string, unknown>;
		try {
			const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: unknown };
			scripts =
				parsed.scripts && typeof parsed.scripts === "object"
					? (parsed.scripts as Record<string, unknown>)
					: {};
		} catch (error) {
			throw new Error(
				`Cannot determine quality gates: package.json is unreadable (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
		const pm = packageManager(cwd);
		return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string").map(
			(name) => `${pm} run ${name}`,
		);
	}
	if (existsSync(join(cwd, "Cargo.toml"))) return ["cargo check --all-targets", "cargo test"];
	if (existsSync(join(cwd, "go.mod"))) return ["go vet ./...", "go test ./..."];
	if (existsSync(join(cwd, "pyproject.toml"))) return ["python -m pytest -q"];
	return [];
}

const TAIL = 4000;

/** Detects and runs the project's gates; a manifest that cannot be read is reported as a failed gate. */
export async function runProjectGates(
	cwd: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GateResult[]> {
	let commands: string[];
	try {
		commands = detectGates(cwd);
	} catch (error) {
		return [
			{
				command: "detect quality gates",
				ok: false,
				exitCode: null,
				durationMs: 0,
				outputTail: error instanceof Error ? error.message : String(error),
			},
		];
	}
	return runGates(commands, cwd, options);
}

/**
 * How a host executes one gate command, in place of the default `shell: true` child of this process. A
 * host that must confine gate code (the factory's OS sandbox) supplies one; pi-swarm itself never
 * imports a sandbox. A runner that throws makes that gate fail with the error text as its output.
 */
export type GateRunner = (
	command: string,
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export async function runGates(
	commands: readonly string[],
	cwd: string,
	options: { signal?: AbortSignal; timeoutMs?: number; runner?: GateRunner } = {},
): Promise<GateResult[]> {
	const results: GateResult[] = [];
	const timeoutMs = options.timeoutMs ?? 15 * 60_000;
	for (const command of commands) {
		try {
			const result = options.runner
				? await options.runner(command, {
						cwd,
						timeoutMs,
						...(options.signal ? { signal: options.signal } : {}),
					})
				: await run(command, [], {
						cwd,
						shell: true,
						timeoutMs,
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
