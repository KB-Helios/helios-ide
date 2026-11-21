import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { DagArtifactView } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

/**
 * The bounded, verified preview of an `artifact` output for `dag.output`. The bytes come from the
 * captured payload pi-dag issued (never a path a model supplied) and are checked against the stored
 * SHA-256 and size before anything is shown. The name is only the base name of the path the worker
 * submitted, kept as a label: it is never opened.
 */
export interface ArtifactSource {
	/** pi-dag's captured payload file. */
	localPath: string;
	sizeBytes: number;
	sha256: string;
	/** The path the worker submitted (pi-dag keeps it as the value preview); only its base name is used. */
	label: string;
}

export interface ArtifactPreview {
	artifact: DagArtifactView;
	text?: string;
	truncated: boolean;
}

const TEXT_TYPES: Record<string, string> = {
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	jsonl: "application/x-ndjson",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	xml: "application/xml",
	svg: "image/svg+xml",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	ts: "text/typescript",
	tsx: "text/typescript",
	jsx: "text/javascript",
	yaml: "application/yaml",
	yml: "application/yaml",
	toml: "application/toml",
	diff: "text/x-diff",
	patch: "text/x-diff",
	py: "text/x-python",
	rs: "text/x-rust",
	go: "text/x-go",
	java: "text/x-java",
	sh: "text/x-shellscript",
};

const NAME_MAX = 255;
const SNIFF_BYTES = 8192;
const CHUNK = 64 * 1024;

function unavailable(): CodedError {
	return new CodedError("RESOURCE_UNAVAILABLE", "Output unavailable");
}

/** A base name safe to show: no directories (either separator), no control characters, bounded. */
export function artifactName(label: string): string {
	const leaf = basename(label.replaceAll("\\", "/"));
	let clean = "";
	for (const char of leaf) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) clean += char;
	}
	clean = clean.trim();
	return (clean.length > NAME_MAX ? clean.slice(0, NAME_MAX) : clean) || "artifact";
}

function imageType(head: Uint8Array): string | undefined {
	const at = (i: number) => head[i];
	if (head.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
		return "image/png";
	if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (head.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
		return "image/gif";
	if (
		head.length >= 12 &&
		Buffer.from(head.subarray(0, 4)).toString("latin1") === "RIFF" &&
		Buffer.from(head.subarray(8, 12)).toString("latin1") === "WEBP"
	)
		return "image/webp";
	return undefined;
}

function extension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Reads the whole captured payload once (at most pi-dag's value quota), hashing it as it goes and
 * keeping only what a preview needs. A missing file, a size or hash that differs from the stored
 * identity, or a short read is `RESOURCE_UNAVAILABLE`: a tampered payload is never shown.
 */
async function readVerified(
	source: ArtifactSource,
	keep: number,
): Promise<{ kept: Buffer; head: Buffer }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(source.localPath, "r");
		const hash = createHash("sha256");
		const kept = Buffer.alloc(Math.min(source.sizeBytes, keep));
		const chunk = Buffer.alloc(CHUNK);
		let position = 0;
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
			if (bytesRead === 0) break;
			hash.update(chunk.subarray(0, bytesRead));
			if (position < kept.length)
				chunk.copy(kept, position, 0, Math.min(bytesRead, kept.length - position));
			position += bytesRead;
			if (position > source.sizeBytes) throw unavailable();
		}
		if (position !== source.sizeBytes || hash.digest("hex") !== source.sha256) throw unavailable();
		return { kept, head: kept.subarray(0, Math.min(kept.length, SNIFF_BYTES)) };
	} catch (error) {
		throw error instanceof CodedError ? error : unavailable();
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function previewArtifact(
	source: ArtifactSource,
	textMax: number,
	imageMax: number,
): Promise<ArtifactPreview> {
	const name = artifactName(source.label);
	const { kept, head } = await readVerified(source, Math.max(textMax, imageMax));
	const image = imageType(head);
	if (image) {
		if (source.sizeBytes <= imageMax)
			return {
				artifact: { name, mediaType: image, imageBase64: kept.toString("base64") },
				truncated: false,
			};
		return { artifact: { name, mediaType: image }, truncated: false };
	}
	if (head.includes(0))
		return { artifact: { name, mediaType: "application/octet-stream" }, truncated: false };
	return {
		artifact: { name, mediaType: TEXT_TYPES[extension(name)] ?? "text/plain" },
		text: new TextDecoder("utf-8", { fatal: false }).decode(kept.subarray(0, textMax)),
		truncated: source.sizeBytes > textMax,
	};
}
