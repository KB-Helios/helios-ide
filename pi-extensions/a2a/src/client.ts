import {
	A2AError,
	AGENT_CARD_PATHS,
	type AgentCard,
	INTERRUPTED_STATES,
	isMessage,
	isTask,
	type JsonRpcResponse,
	type Message,
	type MessageSendParams,
	type Task,
	TERMINAL_STATES,
} from "./protocol.ts";

export interface A2AEndpoint {
	/** Base URL of the agent, or the full URL of its agent card. */
	url: string;
	headers?: Record<string, string>;
}

export interface A2AClientOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function assertHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Not a URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`A2A agents are reached over http(s), not ${url.protocol}`);
	return url;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class A2AClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private card?: AgentCard;
	private readonly endpoint: A2AEndpoint;

	constructor(endpoint: A2AEndpoint, options: A2AClientOptions = {}) {
		assertHttpUrl(endpoint.url);
		this.endpoint = endpoint;
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async getCard(signal?: AbortSignal): Promise<AgentCard> {
		if (this.card) return this.card;
		const base = assertHttpUrl(this.endpoint.url);
		const candidates = base.pathname.endsWith(".json")
			? [base]
			: AGENT_CARD_PATHS.map((path) => new URL(path, base));
		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				const response = await this.fetchImpl(candidate, {
					headers: { accept: "application/json", ...this.endpoint.headers },
					signal: withTimeout(signal, this.timeoutMs),
				});
				if (!response.ok) {
					lastError = new Error(`${candidate} answered ${response.status}`);
					continue;
				}
				const card = (await response.json()) as AgentCard;
				if (!card || typeof card.name !== "string" || typeof card.url !== "string")
					throw new Error(`${candidate} is not an A2A agent card`);
				this.card = card;
				return card;
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error;
			}
		}
		throw new Error(
			`No A2A agent card at ${this.endpoint.url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}

	private async rpc<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		const card = await this.getCard(signal);
		const target = assertHttpUrl(new URL(card.url, this.endpoint.url).toString());
		const response = await this.fetchImpl(target, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...this.endpoint.headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
			signal: withTimeout(signal, this.timeoutMs),
		});
		if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`);
		const body = (await response.json()) as JsonRpcResponse;
		if ("error" in body) throw new A2AError(body.error.code, body.error.message, body.error.data);
		return body.result as T;
	}

	sendMessage(params: MessageSendParams, signal?: AbortSignal): Promise<Task | Message> {
		return this.rpc<unknown>("message/send", params, signal).then((result) => {
			if (isTask(result) || isMessage(result)) return result;
			throw new Error("message/send returned neither a task nor a message");
		});
	}

	getTask(id: string, signal?: AbortSignal): Promise<Task> {
		return this.rpc<Task>("tasks/get", { id }, signal);
	}

	cancelTask(id: string, signal?: AbortSignal): Promise<Task> {
		return this.rpc<Task>("tasks/cancel", { id }, signal);
	}

	/** Polls until the task is terminal or needs input; returns the last snapshot on deadline. */
	async waitForTask(
		task: Task,
		options: {
			signal?: AbortSignal;
			deadlineMs?: number;
			intervalMs?: number;
			onUpdate?: (task: Task) => void;
		} = {},
	): Promise<Task> {
		const deadline = Date.now() + (options.deadlineMs ?? 10 * 60_000);
		let interval = options.intervalMs ?? 1000;
		let current = task;
		while (!settled(current) && Date.now() < deadline) {
			await sleep(interval, options.signal);
			current = await this.getTask(current.id, options.signal);
			options.onUpdate?.(current);
			interval = Math.min(interval * 1.5, 10_000);
		}
		return current;
	}
}

export function settled(task: Task): boolean {
	return TERMINAL_STATES.has(task.status.state) || INTERRUPTED_STATES.has(task.status.state);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
