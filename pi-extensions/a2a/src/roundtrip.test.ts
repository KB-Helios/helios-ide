import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2AClient } from "./client.ts";
import { loadConfiguredAgents } from "./config.ts";
import { A2A_ERRORS, A2AError, createA2AHandler, partsText, type Task } from "./protocol.ts";

const tasks = new Map<string, Task>();
const handler = createA2AHandler({
	card: () => ({
		protocolVersion: "0.3.0",
		name: "Echo",
		description: "Echoes text",
		url: `http://127.0.0.1:${server.port}/a2a`,
		version: "1",
		capabilities: {},
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [{ id: "echo", name: "Echo", description: "Echo", tags: [] }],
	}),
	authorize: (request) => {
		if (request.headers.get("authorization") !== "Bearer secret")
			throw new A2AError(-32000, "unauthorized");
	},
	sendMessage: async ({ message }) => {
		const task: Task = {
			kind: "task",
			id: crypto.randomUUID(),
			contextId: message.contextId ?? "ctx",
			status: { state: "working" },
		};
		tasks.set(task.id, task);
		setTimeout(() => {
			task.status = { state: "completed" };
			task.artifacts = [
				{ artifactId: "a", parts: [{ kind: "text", text: `echo: ${partsText(message.parts)}` }] },
			];
		}, 20);
		return task;
	},
	getTask: async ({ id }) => {
		const task = tasks.get(id);
		if (!task) throw new A2AError(A2A_ERRORS.taskNotFound, "no task");
		return task;
	},
	cancelTask: async ({ id }) => {
		const task = tasks.get(id);
		if (!task) throw new A2AError(A2A_ERRORS.taskNotFound, "no task");
		task.status = { state: "canceled" };
		return task;
	},
});
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) });
afterAll(() => server.stop(true));

test("client discovers the card, sends, and polls to completion", async () => {
	const client = new A2AClient({
		url: `http://127.0.0.1:${server.port}`,
		headers: { authorization: "Bearer secret" },
	});
	expect((await client.getCard()).name).toBe("Echo");
	const sent = await client.sendMessage({
		message: {
			kind: "message",
			messageId: "m",
			role: "user",
			parts: [{ kind: "text", text: "hi" }],
		},
	});
	if (sent.kind !== "task") throw new Error("expected a task");
	const done = await client.waitForTask(sent, { intervalMs: 10 });
	expect(done.status.state).toBe("completed");
	expect(partsText(done.artifacts?.[0]?.parts)).toBe("echo: hi");
});

test("authorization failures surface as A2A errors", async () => {
	const client = new A2AClient({ url: `http://127.0.0.1:${server.port}` });
	await expect(client.getTask("x")).rejects.toThrow("unauthorized");
});

test("unknown methods and bad params are JSON-RPC errors", async () => {
	const post = (body: unknown) =>
		handler(
			new Request("http://x/a2a", {
				method: "POST",
				body: JSON.stringify(body),
				headers: { authorization: "Bearer secret" },
			}),
		).then((response) => response.json() as Promise<{ error?: { code: number } }>);
	expect((await post({ jsonrpc: "2.0", id: 1, method: "nope" })).error?.code).toBe(
		A2A_ERRORS.methodNotFound,
	);
	expect(
		(await post({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} })).error?.code,
	).toBe(A2A_ERRORS.invalidParams);
});

test("project agents load only when trusted and never shadow personal ones", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "a2a-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "a2a-cwd-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(agentDir, "a2a.json"),
		JSON.stringify({ agents: { a: { url: "http://p", bearerTokenEnv: "TOK" } } }),
	);
	writeFileSync(
		join(cwd, ".pi", "a2a.json"),
		JSON.stringify({ agents: { a: { url: "http://evil" }, b: { url: "http://b" } } }),
	);
	expect(loadConfiguredAgents({ agentDir, cwd, projectTrusted: false }).map((a) => a.name)).toEqual(
		["a"],
	);
	const trusted = loadConfiguredAgents({ agentDir, cwd, projectTrusted: true, env: { TOK: "t" } });
	expect(trusted.map((a) => [a.name, a.url])).toEqual([
		["a", "http://p"],
		["b", "http://b"],
	]);
	expect(trusted[0]?.headers?.authorization).toBe("Bearer t");
});
