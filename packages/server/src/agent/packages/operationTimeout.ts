import { spawnSync } from "node:child_process";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { CodedError } from "@thinkrail/shared/codedError";

/** The longest a pi npm/git command may run before the host stops it and releases the mutation queue. */
export const PACKAGE_OPERATION_TIMEOUT_MS = 5 * 60_000;

type SpawnedChild = {
	readonly pid?: number;
	readonly exitCode?: number | null;
	kill(signal?: string | number): unknown;
	once(event: "exit", listener: () => void): unknown;
	removeListener(event: "exit", listener: () => void): unknown;
};

/** pi's `spawnCommand` is private: this is the narrow shape the timeout adapter shadows. */
type SpawnCommandHost = {
	spawnCommand?: (command: string, args: string[], options?: { cwd?: string }) => SpawnedChild;
};

type SpawnHook = {
	/** Cancel further launches and kill every child that has not exited yet. */
	stop: () => Promise<void>;
	restore: () => void;
};

function hookSpawnedChildren(packageManager: DefaultPackageManager): SpawnHook {
	const host = packageManager as unknown as SpawnCommandHost;
	const original = host.spawnCommand;
	if (typeof original !== "function") return { stop: async () => {}, restore: () => {} };
	const children = new Set<SpawnedChild>();
	let cancelled = false;
	host.spawnCommand = (command, args, options) => {
		if (cancelled) throw new CodedError("PACKAGE_OPERATION_TIMEOUT", "Package operation expired.");
		const child = original.call(packageManager, command, args, options);
		if (child.pid !== undefined) {
			children.add(child);
			child.once("exit", () => children.delete(child));
		}
		return child;
	};
	return {
		restore: () => {
			host.spawnCommand = original;
		},
		stop: async () => {
			cancelled = true;
			const live = [...children];
			children.clear();
			await Promise.all(live.map(killProcessTree));
		},
	};
}

async function killProcessTree(child: SpawnedChild): Promise<void> {
	const pid = child.pid;
	if (pid === undefined || child.exitCode !== null) return;
	if (process.platform !== "win32") {
		const owned = new Set([pid]);
		const stop = (target: number) => {
			try {
				process.kill(target, "SIGSTOP");
			} catch {}
		};
		stop(pid);
		try {
			let previousSize = 0;
			while (previousSize !== owned.size) {
				previousSize = owned.size;
				const snapshot = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
					encoding: "utf8",
					timeout: 5_000,
				});
				if (snapshot.error || snapshot.status !== 0) return;
				const rows = snapshot.stdout
					.trim()
					.split("\n")
					.map((line) => line.trim().split(/\s+/).map(Number));
				let expanded = true;
				while (expanded) {
					expanded = false;
					for (const [descendant, parent] of rows) {
						if (
							descendant !== undefined &&
							descendant > 0 &&
							parent !== undefined &&
							owned.has(parent) &&
							!owned.has(descendant)
						) {
							owned.add(descendant);
							stop(descendant);
							expanded = true;
						}
					}
				}
			}
		} finally {
			for (const descendant of [...owned].reverse()) {
				if (descendant === pid) continue;
				try {
					process.kill(descendant, "SIGKILL");
				} catch {}
			}
			try {
				child.kill("SIGKILL");
			} catch {}
		}
		return;
	}
	try {
		const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		if ((await killer.exited) === 0) return;
	} catch {}
	try {
		child.kill("SIGKILL");
	} catch {}
}

/**
 * pi's package manager awaits npm/git without a deadline. Bound one mutation, kill any child still
 * running when it expires, and reject with a code the dialog can explain; the module queue then
 * advances instead of pinning every later package operation behind the same process.
 *
 * `spawnCommand` is pi's private npm/git launch point; the adapter is recorded in pi-compatibility.md.
 */
export async function withPackageOperationTimeout<T>(
	packageManager: DefaultPackageManager,
	label: string,
	task: () => Promise<T>,
): Promise<T> {
	const hook = hookSpawnedChildren(packageManager);
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			const finish = () => {
				reject(
					new CodedError(
						"PACKAGE_OPERATION_TIMEOUT",
						`${label} did not finish within ${Math.round(PACKAGE_OPERATION_TIMEOUT_MS / 60_000)} minutes.`,
					),
				);
			};
			void hook.stop().then(finish, finish);
		}, PACKAGE_OPERATION_TIMEOUT_MS);
	});
	const running = (async () => {
		try {
			return await task();
		} finally {
			hook.restore();
		}
	})();
	const outcome = running.then(
		(value) => (timedOut ? deadline : value),
		(error) => {
			if (timedOut) return deadline;
			throw error;
		},
	);
	try {
		return await Promise.race([outcome, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (!timedOut) await hook.stop();
	}
}
