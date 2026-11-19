import { defineServerExtension } from "@thinkrail/extension-api/server";
import { createA2AExtension } from "@thinkrail/pi-a2a";

export default defineServerExtension({
	name: "a2a",
	title: "Agent2Agent (A2A)",
	description:
		"Lets the agent and its subagents discover remote A2A agents and delegate self-contained tasks to them (a2a_agents, a2a_send, a2a_task). Agents are configured in a2a.json in the pi agent folder or a trusted project's .pi folder.",
	extensions: [createA2AExtension()],
	childExtensions: [createA2AExtension()],
});
