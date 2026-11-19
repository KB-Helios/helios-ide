export const A2A_PROTOCOL_VERSION = "0.3.0";
export const AGENT_CARD_PATHS = [
	"/.well-known/agent-card.json",
	"/.well-known/agent.json",
] as const;

export type TaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "canceled"
	| "failed"
	| "rejected"
	| "auth-required"
	| "unknown";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
	"completed",
	"canceled",
	"failed",
	"rejected",
]);

export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
	"input-required",
	"auth-required",
]);

export type Part =
	| { kind: "text"; text: string; metadata?: Record<string, unknown> }
	| {
			kind: "file";
			file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
			metadata?: Record<string, unknown>;
	  }
	| { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };

export interface Message {
	kind: "message";
	messageId: string;
	role: "user" | "agent";
	parts: Part[];
	contextId?: string;
	taskId?: string;
	metadata?: Record<string, unknown>;
}

export interface Artifact {
	artifactId: string;
	name?: string;
	description?: string;
	parts: Part[];
	metadata?: Record<string, unknown>;
}

export interface TaskStatus {
	state: TaskState;
	message?: Message;
	timestamp?: string;
}

export interface Task {
	kind: "task";
	id: string;
	contextId: string;
	status: TaskStatus;
	artifacts?: Artifact[];
	history?: Message[];
	metadata?: Record<string, unknown>;
}

export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
	examples?: string[];
}

export interface AgentCard {
	protocolVersion: string;
	name: string;
	description: string;
	url: string;
	version: string;
	preferredTransport?: "JSONRPC";
	capabilities: { streaming?: boolean; pushNotifications?: boolean };
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: AgentSkill[];
	securitySchemes?: Record<string, unknown>;
	security?: Array<Record<string, string[]>>;
}

export interface MessageSendParams {
	message: Message;
	configuration?: { blocking?: boolean; historyLength?: number; acceptedOutputModes?: string[] };
	metadata?: Record<string, unknown>;
}

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number | null;
	method: string;
	params?: unknown;
}

export type JsonRpcResponse =
	| { jsonrpc: "2.0"; id: string | number | null; result: unknown }
	| { jsonrpc: "2.0"; id: string | number | null; error: JsonRpcError };

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export const A2A_ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	taskNotFound: -32001,
	taskNotCancelable: -32002,
	unsupportedOperation: -32004,
} as const;

export class A2AError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "A2AError";
		this.code = code;
		if (data !== undefined) this.data = data;
	}
}

export function textMessage(
	role: Message["role"],
	text: string,
	extra: Partial<Pick<Message, "contextId" | "taskId" | "metadata">> = {},
): Message {
	return {
		kind: "message",
		messageId: crypto.randomUUID(),
		role,
		parts: [{ kind: "text", text }],
		...extra,
	};
}

export function partsText(parts: readonly Part[] | undefined): string {
	return (parts ?? [])
		.map((part) => {
			if (part.kind === "text") return part.text;
			if (part.kind === "data") return JSON.stringify(part.data, null, 2);
			return `[file ${part.file.name ?? part.file.uri ?? "attachment"}]`;
		})
		.join("\n");
}

export function isTask(value: unknown): value is Task {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { kind?: unknown }).kind === "task" &&
		typeof (value as { id?: unknown }).id === "string"
	);
}

export function isMessage(value: unknown): value is Message {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { kind?: unknown }).kind === "message" &&
		Array.isArray((value as { parts?: unknown }).parts)
	);
}

export interface A2AHandlers {
	card: () => AgentCard;
	/** Validates bearer/other credentials; throw an `A2AError` to reject. */
	authorize?: (request: Request) => void | Promise<void>;
	sendMessage: (params: MessageSendParams, request: Request) => Promise<Task | Message>;
	getTask: (params: { id: string; historyLength?: number }) => Promise<Task>;
	cancelTask: (params: { id: string }) => Promise<Task>;
}

function rpcError(id: JsonRpcRequest["id"], error: unknown): JsonRpcResponse {
	if (error instanceof A2AError)
		return {
			jsonrpc: "2.0",
			id,
			error: {
				code: error.code,
				message: error.message,
				...(error.data !== undefined ? { data: error.data } : {}),
			},
		};
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: A2A_ERRORS.internal,
			message: error instanceof Error ? error.message : "Internal error",
		},
	};
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new A2AError(A2A_ERRORS.invalidParams, `${what} must be an object`);
	return value as Record<string, unknown>;
}

function parseSendParams(params: unknown): MessageSendParams {
	const object = requireObject(params, "params");
	const message = requireObject(object.message, "params.message");
	if (message.role !== "user")
		throw new A2AError(A2A_ERRORS.invalidParams, 'params.message.role must be "user"');
	if (!Array.isArray(message.parts) || message.parts.length === 0)
		throw new A2AError(A2A_ERRORS.invalidParams, "params.message.parts must be a non-empty array");
	return {
		...(object as unknown as MessageSendParams),
		message: {
			...(message as unknown as Message),
			kind: "message",
			messageId: typeof message.messageId === "string" ? message.messageId : crypto.randomUUID(),
		},
	};
}

function parseTaskId(params: unknown): { id: string; historyLength?: number } {
	const object = requireObject(params, "params");
	if (typeof object.id !== "string" || !object.id)
		throw new A2AError(A2A_ERRORS.invalidParams, "params.id must be a task id");
	return {
		id: object.id,
		...(typeof object.historyLength === "number" ? { historyLength: object.historyLength } : {}),
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Answers the A2A agent card (GET) and JSON-RPC (POST) requests; streaming methods are unsupported. */
export function createA2AHandler(handlers: A2AHandlers): (request: Request) => Promise<Response> {
	return async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && (AGENT_CARD_PATHS as readonly string[]).includes(path))
			return json(handlers.card());
		if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
		let body: JsonRpcRequest;
		try {
			body = (await request.json()) as JsonRpcRequest;
		} catch {
			return json(rpcError(null, new A2AError(A2A_ERRORS.parse, "Invalid JSON")));
		}
		const id = body && typeof body === "object" && "id" in body ? body.id : null;
		try {
			if (body?.jsonrpc !== "2.0" || typeof body.method !== "string")
				throw new A2AError(A2A_ERRORS.invalidRequest, "Not a JSON-RPC 2.0 request");
			await handlers.authorize?.(request);
			switch (body.method) {
				case "message/send":
					return json({
						jsonrpc: "2.0",
						id,
						result: await handlers.sendMessage(parseSendParams(body.params), request),
					});
				case "tasks/get":
					return json({
						jsonrpc: "2.0",
						id,
						result: await handlers.getTask(parseTaskId(body.params)),
					});
				case "tasks/cancel":
					return json({
						jsonrpc: "2.0",
						id,
						result: await handlers.cancelTask(parseTaskId(body.params)),
					});
				case "message/stream":
				case "tasks/resubscribe":
				case "tasks/pushNotificationConfig/set":
				case "tasks/pushNotificationConfig/get":
					throw new A2AError(A2A_ERRORS.unsupportedOperation, `${body.method} is not supported`);
				default:
					throw new A2AError(A2A_ERRORS.methodNotFound, `Unknown method ${body.method}`);
			}
		} catch (error) {
			return json(rpcError(id, error));
		}
	};
}
