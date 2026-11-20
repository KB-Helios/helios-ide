import type { DelegationService, ResourceChildHandle } from "pi-delegation";
import { Semaphore } from "pi-delegation";

/** Used when the host has not installed a limit resolver (tests, early boot): the subagent default. */
export const DEFAULT_FACTORY_SLOTS = 4;

export interface FactoryQueue {
	/** Worker turns allowed to run at once across every DAG of the workspace. */
	limit: number;
	running: number;
	/** Worker turns admitted by their DAG that wait for a slot. */
	queued: number;
}

/**
 * The workspace-wide cap on running DAG worker turns. pi-dag already bounds one DAG by its own
 * `maxConcurrent`; this adds the bound across all DAGs of a workspace by gating each child's
 * `runQueued` on one shared pi-delegation semaphore. A turn over the cap waits (its DAG node reads
 * `queued`) and starts when a slot frees; lowering the limit never aborts running turns.
 */
export class FactorySlots {
	private readonly semaphore: Semaphore;
	private limit: number;
	private running = 0;
	private readonly waiting = new Set<symbol>();

	constructor(limit: number) {
		this.semaphore = new Semaphore(limit);
		this.limit = limit;
	}

	setLimit(limit: number): void {
		if (limit === this.limit) return;
		this.limit = limit;
		this.semaphore.resize(limit);
	}

	snapshot(): FactoryQueue {
		return { limit: this.limit, running: this.running, queued: this.waiting.size };
	}

	/**
	 * Resolves the release, or `undefined` when `signal` aborted while the turn was still waiting.
	 * `runnable` is asked before a slot is taken and again once one is granted: a turn whose DAG is
	 * paused takes no slot, it stays queued (re-checked every `PAUSE_POLL_MS`) until the DAG runs again.
	 */
	async acquire(
		signal: AbortSignal | undefined,
		runnable?: () => boolean | Promise<boolean>,
	): Promise<(() => void) | undefined> {
		if (signal?.aborted) return undefined;
		const ticket = Symbol("factory-slot");
		this.waiting.add(ticket);
		try {
			for (;;) {
				while (runnable && !(await runnable())) if (!(await pause(signal))) return undefined;
				const release = await this.take(signal);
				if (!release) return undefined;
				if (!runnable || (await runnable())) {
					this.running++;
					let released = false;
					return () => {
						if (released) return;
						released = true;
						this.running--;
						release();
					};
				}
				release();
			}
		} finally {
			this.waiting.delete(ticket);
		}
	}

	private async take(signal: AbortSignal | undefined): Promise<(() => void) | undefined> {
		const slot = this.semaphore.acquire();
		let onAbort = () => {};
		const aborted = new Promise<undefined>((resolve) => {
			onAbort = () => resolve(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const release = await Promise.race([slot, aborted]);
		signal?.removeEventListener("abort", onAbort);
		// The semaphore still holds an aborted waiter; give the slot straight back once it is granted.
		if (!release) void slot.then((free) => free());
		return release;
	}
}

const PAUSE_POLL_MS = 100;

/** Sleeps one poll interval; `false` when `signal` aborted meanwhile. */
function pause(signal: AbortSignal | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const done = (value: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => done(false);
		const timer = setTimeout(() => done(true), PAUSE_POLL_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const registry = new Map<string, FactorySlots>();

export function factorySlotsFor(workspaceId: string, limit: () => number): FactorySlots {
	let slots = registry.get(workspaceId);
	if (!slots) {
		slots = new FactorySlots(limit());
		registry.set(workspaceId, slots);
	}
	return slots;
}

/** Applies a live limit to the workspace's slots, if it has any. */
export function setFactorySlotLimit(workspaceId: string, limit: number): void {
	registry.get(workspaceId)?.setLimit(limit);
}

export function factoryQueueOf(workspaceId: string): FactoryQueue | undefined {
	return registry.get(workspaceId)?.snapshot();
}

export function dropFactorySlots(workspaceId: string): void {
	registry.delete(workspaceId);
}

/**
 * Wraps a delegation service so every DAG child run passes through the workspace slots. Only
 * `registerResource` children are gated (DAGs are resources); chat subagents keep their per-parent
 * limit untouched. A run aborted while waiting still goes through the inner `runQueued` with its
 * aborted signal, so the caller gets pi-delegation's own aborted outcome.
 */
export function withFactorySlots(
	delegation: DelegationService,
	slots: FactorySlots,
	/** False while the DAG (the resource id) is paused: its waiting turns stay queued without a slot. */
	dagRuns?: (dagId: string) => boolean | Promise<boolean>,
): DelegationService {
	const gate = (dagId: string, handle: ResourceChildHandle): ResourceChildHandle => ({
		...handle,
		runQueued: async (task, opts = {}) => {
			const release = await slots.acquire(opts.signal, dagRuns && (() => dagRuns(dagId)));
			try {
				return await handle.runQueued(task, opts);
			} finally {
				release?.();
			}
		},
	});
	return new Proxy(delegation, {
		get(target, property) {
			if (property !== "registerResource") {
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			const register: DelegationService["registerResource"] = async (id, context, options) => {
				const resource = await target.registerResource(id, context, options);
				return {
					...resource,
					createChild: async (spec) => gate(id, await resource.createChild(spec)),
					reopenChild: async (spec) => gate(id, await resource.reopenChild(spec)),
				};
			};
			return register;
		},
	});
}
