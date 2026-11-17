import { afterEach, expect, it, jest } from "bun:test";
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
		pid: 0,
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
		pid: 0,
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
