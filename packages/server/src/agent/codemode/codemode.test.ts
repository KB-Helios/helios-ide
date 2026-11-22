import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createSession,
	disposeAllSessions,
	getSessionMessages,
	promptSession,
	setSessionManagerFactory,
	setSkillAdmissionResolver,
	settleSessionsForShutdown,
	toWireModel,
} from "../agentSessionManager";
import { configurePiRuntime } from "../piRuntime";
import { admissionContextFor } from "../skillAdmission";

const model = {
	id: "codemode",
	name: "codemode",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};
const faux = createFauxCore({
	provider: "codemode",
	api: "codemode",
	models: [model],
	tokensPerSecond: 10000,
});
const saved = {
	agent: process.env.PI_CODING_AGENT_DIR,
	data: process.env.THINKRAIL_DATA_DIR,
	offline: process.env.PI_OFFLINE,
};
const root = mkdtempSync(join(tmpdir(), "codemode-"));

function restore(name: keyof typeof saved, key: string): void {
	const value = saved[name];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(async () => {
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_OFFLINE = "1";
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("codemode", {
		api: faux.api,
		apiKey: "test",
		baseUrl: "http://faux.local",
		streamSimple: faux.streamSimple,
		models: [{ ...model, api: faux.api }],
	});
	configurePiRuntime(runtime);
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	setSkillAdmissionResolver(() => admissionContextFor({ piResourceTrust: "granted" }));
});

afterAll(async () => {
	setSkillAdmissionResolver(() => admissionContextFor(undefined));
	await settleSessionsForShutdown();
	disposeAllSessions();
	configurePiRuntime(null);
	setSessionManagerFactory((cwd) => SessionManager.create(cwd));
	restore("agent", "PI_CODING_AGENT_DIR");
	restore("data", "THINKRAIL_DATA_DIR");
	restore("offline", "PI_OFFLINE");
	rmSync(root, { recursive: true, force: true });
});

test("a chat runs codemode scripts that call the session's own tools", async () => {
	const cwd = mkdtempSync(join(root, "cwd-"));
	writeFileSync(join(cwd, "marker.txt"), "codemode-marker\n");
	const workspaceId = "codemode-ws";
	// Pinned to the faux model: the default would be whatever real provider this machine has keys for.
	const { sessionId } = await createSession({
		workspaceId,
		cwd,
		model: toWireModel(faux.getModel()),
	});
	const code = [
		'const file = await tools.read({ path: "marker.txt" });',
		'console.log("CODEMODE_SAW:" + JSON.stringify(file).includes("codemode-marker"));',
	].join("\n");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code })),
		fauxAssistantMessage("DONE"),
	]);
	await promptSession(sessionId, "Read the marker with a script.");
	const transcript = JSON.stringify(await getSessionMessages(sessionId, workspaceId, cwd));
	expect(transcript).toContain("CODEMODE_SAW:true");
	expect(transcript).not.toContain("Tool codemode not found");
}, 60_000);
