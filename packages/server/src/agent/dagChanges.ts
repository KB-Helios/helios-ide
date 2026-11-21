import type { DagChanged } from "@thinkrail/contracts";

/**
 * Where a DAG's committed changes become pushes. pi-dag's `onChange` observer reports every durable
 * version (worker admission, settlement, gate decisions, commands from any caller), so the factory
 * pane no longer polls: this module turns that stream into debounced `dag.changed` publishes for the
 * wire and into immediate wake-ups for host code that waits on a DAG (paused worker turns).
 */
export const DAG_CHANGE_DEBOUNCE_MS = 120;

/** A lost wake-up can never strand a waiter longer than this. */
export const DAG_WAIT_SAFETY_MS = 5000;

let publish: (payload: DagChanged) => void = () => {};
let debounceMs = DAG_CHANGE_DEBOUNCE_MS;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; payload: DagChanged }>();
const waiters = new Map<string, Set<() => void>>();

export function setDagPublisher(next: ((payload: DagChanged) => void) | null): void {
	publish = next ?? (() => {});
	if (!next) cancelPendingDagChanges();
}

/** Test seam: the debounce window, `undefined` restores the default. */
export function setDagChangeDebounce(ms: number | undefined): void {
	debounceMs = ms ?? DAG_CHANGE_DEBOUNCE_MS;
}

export function cancelPendingDagChanges(): void {
	for (const entry of pending.values()) clearTimeout(entry.timer);
	pending.clear();
}

const keyOf = (workspaceId: string, dagId: string) => `${workspaceId}\u0000${dagId}`;

/** A command's own result is returned to its caller right away; nothing else needs to be delayed. */
export function publishDagChangedNow(payload: DagChanged): void {
	const key = keyOf(payload.workspaceId, payload.dagId);
	const queued = pending.get(key);
	if (queued) {
		clearTimeout(queued.timer);
		pending.delete(key);
	}
	publish(payload);
}

/**
 * One committed change of a DAG. Waiters wake at once; the push is trailing-debounced per DAG (a burst
 * of commits publishes once, at most `debounceMs` after the first of them).
 */
export function dagChanged(workspaceId: string, dagId: string): void {
	const key = keyOf(workspaceId, dagId);
	for (const wake of [...(waiters.get(key) ?? [])]) wake();
	if (pending.has(key)) return;
	const payload = { workspaceId, dagId };
	const timer = setTimeout(() => {
		pending.delete(key);
		publish(payload);
	}, debounceMs);
	timer.unref?.();
	pending.set(key, { timer, payload });
}

/**
 * Resolves `true` at the DAG's next committed change (or after the safety interval, so a caller always
 * re-checks its condition), `false` when `signal` aborted first.
 */
export function waitForDagChange(
	workspaceId: string,
	dagId: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const key = keyOf(workspaceId, dagId);
		const set = waiters.get(key) ?? new Set<() => void>();
		waiters.set(key, set);
		const finish = (value: boolean) => {
			clearTimeout(timer);
			set.delete(wake);
			if (set.size === 0 && waiters.get(key) === set) waiters.delete(key);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const wake = () => finish(true);
		const onAbort = () => finish(false);
		const timer = setTimeout(wake, DAG_WAIT_SAFETY_MS);
		set.add(wake);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
