import { createA2AExtension } from "./src/extension.ts";

export {
	A2AClient,
	type A2AClientOptions,
	type A2AEndpoint,
	assertHttpUrl,
	settled,
} from "./src/client.ts";
export {
	type A2AAgentConfig,
	CONFIG_FILE,
	type ConfiguredAgent,
	expandEnv,
	loadConfiguredAgents,
} from "./src/config.ts";
export {
	type A2AExtensionOptions,
	createA2AExtension,
	describeCard,
	describeResult,
} from "./src/extension.ts";
export * from "./src/protocol.ts";

export default createA2AExtension();
