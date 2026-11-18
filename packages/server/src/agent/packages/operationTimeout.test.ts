import { afterEach, expect, it, jest } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { errorCodeOf } from "@thinkrail/shared/codedError";
import { PACKAGE_OPERATION_TIMEOUT_MS, withPackageOperationTimeout } from "./operationTimeout";

afterEach(() => {
	jest.useRealTimers();
});

it("still finds pi's private spawnCommand hook", () => {
	const prototype = DefaultPackageManager.prototype as unknown as { spawnCommand?: unknown };
	expect(typeof prototype.spawnCommand).toBe("function");
});

it("kills a spawned package command and rejects when the operation exceeds its deadline", async () => {
	jest.useFakeTimers();
	let killed = false;
	const child = {
		pid: 2147483647,
		exitCode: null as number | null,
		kill: () => {
			killed = true;
			return true;
		},
		once: () => child,
		removeListener: () => child,
	};
	const manager = { spawnCommand: (_command: string, _args: string[]) => child };
	let started = () => {};
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	const operation = withPackageOperationTimeout(
		manager as unknown as DefaultPackageManager,
		"Installing npm:fixture",
		async () => {
			manager.spawnCommand("npm", ["install"]);
			started();
			return new Promise(() => {});
		},
	);
	await began;
	jest.advanceTimersByTime(PACKAGE_OPERATION_TIMEOUT_MS);
	const error = await operation.catch((failure) => failure);
	expect(errorCodeOf(error)).toBe("PACKAGE_OPERATION_TIMEOUT");
	expect(killed).toBe(true);
});

it("restores pi's spawn hook when the operation settles", async () => {
	const original = () => ({
		pid: 2147483647,
		kill: () => true,
		once: () => undefined,
		removeListener: () => undefined,
	});
	const manager = { spawnCommand: original };
	await withPackageOperationTimeout(
		manager as unknown as DefaultPackageManager,
		"Updating packages",
		async () => {},
	);
	expect(manager.spawnCommand).toBe(original);
});

it("blocks launches by a continuation after timeout and restores only after it settles", async () => {
	jest.useFakeTimers();
	let resume = () => {};
	const pending = new Promise<void>((resolve) => {
		resume = resolve;
	});
	let launches = 0;
	const original = () => {
		launches++;
		throw new Error("unexpected launch");
	};
	const manager = { spawnCommand: original };
	let continuationError: unknown;
	const operation = withPackageOperationTimeout(
		manager as unknown as DefaultPackageManager,
		"Updating",
		async () => {
			await pending;
			try {
				manager.spawnCommand();
			} catch (error) {
				continuationError = error;
			}
		},
	);
	jest.advanceTimersByTime(PACKAGE_OPERATION_TIMEOUT_MS);
	expect(errorCodeOf(await operation.catch((error) => error))).toBe("PACKAGE_OPERATION_TIMEOUT");
	expect(manager.spawnCommand).not.toBe(original);
	resume();
	await pending;
	await Promise.resolve();
	expect(errorCodeOf(continuationError)).toBe("PACKAGE_OPERATION_TIMEOUT");
	expect(launches).toBe(0);
	expect(manager.spawnCommand).toBe(original);
});

it("preserves failures before expiry", async () => {
	const failure = new Error("original");
	const operation = withPackageOperationTimeout(
		{} as DefaultPackageManager,
		"Updating",
		async () => {
			throw failure;
		},
	);
	expect(await operation.catch((error) => error)).toBe(failure);
});

it.skipIf(process.platform === "win32")(
	"kills lifecycle descendants and keeps timeout when killing settles the task",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "package-tree-"));
		const marker = join(root, "pid");
		const child = spawn("sh", ["-c", 'sleep 300 & echo $! > "$1"; wait', "sh", marker]);
		const manager = { spawnCommand: () => child };
		try {
			while (true) {
				try {
					if (readFileSync(marker, "utf8").trim()) break;
				} catch {}
				await Bun.sleep(10);
			}
			const descendant = Number(readFileSync(marker, "utf8").trim());
			jest.useFakeTimers();
			const operation = withPackageOperationTimeout(
				manager as unknown as DefaultPackageManager,
				"Installing",
				async () => {
					manager.spawnCommand();
					await new Promise<void>((resolve) => child.once("exit", () => resolve()));
				},
			);
			jest.advanceTimersByTime(PACKAGE_OPERATION_TIMEOUT_MS);
			expect(errorCodeOf(await operation.catch((error) => error))).toBe(
				"PACKAGE_OPERATION_TIMEOUT",
			);
			jest.useRealTimers();
			await Bun.sleep(50);
			const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(descendant)])
				.stdout.toString()
				.trim();
			expect(state === "" || state.startsWith("Z")).toBe(true);
		} finally {
			child.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("expiry wins if killing the child settles the task during cleanup", async () => {
	jest.useFakeTimers();
	let settle = () => {};
	const pending = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const child = {
		pid: 2147483647,
		exitCode: null,
		kill: () => settle(),
		once: () => {},
		removeListener: () => {},
	};
	const manager = { spawnCommand: () => child };
	const operation = withPackageOperationTimeout(
		manager as unknown as DefaultPackageManager,
		"Updating",
		async () => {
			manager.spawnCommand();
			await pending;
			return "success";
		},
	);
	jest.advanceTimersByTime(PACKAGE_OPERATION_TIMEOUT_MS);
	expect(errorCodeOf(await operation.catch((error) => error))).toBe("PACKAGE_OPERATION_TIMEOUT");
});
