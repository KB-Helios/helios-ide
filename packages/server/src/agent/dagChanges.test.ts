import { afterEach, expect, test } from "bun:test";
import type { DagChanged } from "@thinkrail/contracts";
import {
	dagChanged,
	publishDagChangedNow,
	setDagChangeDebounce,
	setDagPublisher,
	waitForDagChange,
} from "./dagChanges";

afterEach(() => {
	setDagPublisher(null);
	setDagChangeDebounce(undefined);
});

test("a burst of changes of one DAG publishes once, other DAGs publish separately", async () => {
	setDagChangeDebounce(20);
	const pushed: DagChanged[] = [];
	setDagPublisher((payload) => pushed.push(payload));
	for (let n = 0; n < 10; n++) dagChanged("ws", "a");
	dagChanged("ws", "b");
	dagChanged("other", "a");
	expect(pushed).toEqual([]);
	await Bun.sleep(80);
	expect(pushed).toHaveLength(3);
	expect(pushed).toContainEqual({ workspaceId: "ws", dagId: "a" });
	expect(pushed).toContainEqual({ workspaceId: "ws", dagId: "b" });
	expect(pushed).toContainEqual({ workspaceId: "other", dagId: "a" });
	dagChanged("ws", "a");
	await Bun.sleep(80);
	expect(pushed).toHaveLength(4);
});

test("an immediate publish replaces the queued one; clearing the publisher drops queued pushes", async () => {
	setDagChangeDebounce(20);
	const pushed: DagChanged[] = [];
	setDagPublisher((payload) => pushed.push(payload));
	dagChanged("ws", "a");
	publishDagChangedNow({ workspaceId: "ws", dagId: "a" });
	expect(pushed).toHaveLength(1);
	await Bun.sleep(60);
	expect(pushed).toHaveLength(1);
	dagChanged("ws", "a");
	setDagPublisher(null);
	await Bun.sleep(60);
	expect(pushed).toHaveLength(1);
});

test("waiters wake on the next change of exactly their DAG and on abort", async () => {
	let woke = false;
	const waiting = waitForDagChange("ws", "a", undefined).then((value) => {
		woke = value;
		return value;
	});
	dagChanged("ws", "b");
	await Bun.sleep(10);
	expect(woke).toBe(false);
	dagChanged("ws", "a");
	expect(await waiting).toBe(true);

	const controller = new AbortController();
	const aborted = waitForDagChange("ws", "a", controller.signal);
	controller.abort();
	expect(await aborted).toBe(false);
	expect(await waitForDagChange("ws", "a", controller.signal)).toBe(false);
});
