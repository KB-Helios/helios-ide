import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { A2AEndpoint } from "./client.ts";

export interface A2AAgentConfig {
	url: string;
	description?: string;
	headers?: Record<string, string>;
	/** Name of an environment variable holding a bearer token; never the token itself. */
	bearerTokenEnv?: string;
}

export interface ConfiguredAgent extends A2AEndpoint {
	name: string;
	description?: string;
	source: "personal" | "project";
}

export const CONFIG_FILE = "a2a.json";

function readAgents(path: string): Record<string, A2AAgentConfig> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as { agents?: unknown };
		if (!parsed.agents || typeof parsed.agents !== "object") return {};
		const agents: Record<string, A2AAgentConfig> = {};
		for (const [name, value] of Object.entries(parsed.agents as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const entry = value as Record<string, unknown>;
			if (typeof entry.url !== "string") continue;
			agents[name] = {
				url: entry.url,
				...(typeof entry.description === "string" ? { description: entry.description } : {}),
				...(entry.headers && typeof entry.headers === "object"
					? { headers: entry.headers as Record<string, string> }
					: {}),
				...(typeof entry.bearerTokenEnv === "string"
					? { bearerTokenEnv: entry.bearerTokenEnv }
					: {}),
			};
		}
		return agents;
	} catch {
		return {};
	}
}

export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => env[name] ?? "");
}

function toEndpoint(
	name: string,
	config: A2AAgentConfig,
	source: ConfiguredAgent["source"],
	env: NodeJS.ProcessEnv,
): ConfiguredAgent {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.headers ?? {}))
		if (typeof value === "string") headers[key] = expandEnv(value, env);
	const token = config.bearerTokenEnv ? env[config.bearerTokenEnv] : undefined;
	if (token) headers.authorization = `Bearer ${token}`;
	return {
		name,
		url: config.url,
		source,
		...(config.description ? { description: config.description } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
	};
}

/** Personal agents first; a project file may add names but never shadow a personal one. */
export function loadConfiguredAgents(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	env?: NodeJS.ProcessEnv;
}): ConfiguredAgent[] {
	const env = options.env ?? process.env;
	const agents = new Map<string, ConfiguredAgent>();
	for (const [name, config] of Object.entries(readAgents(join(options.agentDir, CONFIG_FILE))))
		agents.set(name, toEndpoint(name, config, "personal", env));
	if (options.projectTrusted)
		for (const [name, config] of Object.entries(readAgents(join(options.cwd, ".pi", CONFIG_FILE))))
			if (!agents.has(name)) agents.set(name, toEndpoint(name, config, "project", env));
	return [...agents.values()];
}
