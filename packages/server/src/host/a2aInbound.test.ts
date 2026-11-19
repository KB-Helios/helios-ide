import { afterEach, expect, test } from "bun:test";
import { isA2ARoute, serveA2A } from "./a2aInbound";

const prior = process.env.THINKRAIL_A2A_TOKEN;
const priorDataDir = process.env.THINKRAIL_DATA_DIR;

afterEach(() => {
	if (prior === undefined) delete process.env.THINKRAIL_A2A_TOKEN;
	else process.env.THINKRAIL_A2A_TOKEN = prior;
	if (priorDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = priorDataDir;
});

const rpc = (body: unknown, token?: string) =>
	serveA2A(
		new Request("http://localhost:24242/a2a", {
			method: "POST",
			body: JSON.stringify(body),
			headers: token ? { authorization: `Bearer ${token}` } : {},
		}),
	);

test("routes are the agent card paths and /a2a only", () => {
	expect(isA2ARoute("/a2a")).toBe(true);
	expect(isA2ARoute("/.well-known/agent.json")).toBe(true);
	expect(isA2ARoute("/.well-known/agent-card.json")).toBe(true);
	expect(isA2ARoute("/a2a/x")).toBe(false);
});

test("inbound A2A is off without a token", async () => {
	delete process.env.THINKRAIL_A2A_TOKEN;
	process.env.THINKRAIL_DATA_DIR = "/nonexistent-thinkrail-test-dir";
	expect((await serveA2A(new Request("http://localhost/.well-known/agent.json"))).status).toBe(404);
	expect(
		(await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } })).status,
	).toBe(404);
});

test("with a token the card is public and every call needs the bearer token", async () => {
	process.env.THINKRAIL_A2A_TOKEN = "s3cret";
	const card = (await (
		await serveA2A(new Request("http://localhost:9/.well-known/agent-card.json"))
	).json()) as {
		url: string;
		skills: unknown[];
	};
	expect(card.url).toBe("http://localhost:9/a2a");
	expect(card.skills.length).toBe(1);
	const denied = (await (
		await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }, "nope")
	).json()) as {
		error: { message: string };
	};
	expect(denied.error.message).toContain("Unauthorized");
	const missing = (await (
		await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "x" } }, "s3cret")
	).json()) as {
		error: { code: number };
	};
	expect(missing.error.code).toBe(-32001);
});
