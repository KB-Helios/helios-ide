import { runCommand } from "pi-swarm";
import type { GateSandbox } from "./sandbox";

/**
 * A stand-in for the OS sandbox in tests that exercise the gate flow itself (records, freshness, landing):
 * it runs the command as a plain shell child and confines nothing. Never used outside tests; the real
 * boundary has its own tests (`sandbox.test.ts`, and the helper's `cargo test`).
 */
export function unconfinedTestSandbox(): GateSandbox {
	return {
		kind: "unconfined-test",
		availability: async () => ({ ok: true }),
		launch: (request) =>
			runCommand(request.command, [], {
				cwd: request.cwd,
				shell: true,
				timeoutMs: request.timeoutMs,
				...(request.signal ? { signal: request.signal } : {}),
			}),
	};
}
