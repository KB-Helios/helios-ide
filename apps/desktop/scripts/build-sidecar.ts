#!/usr/bin/env bun

// Builds the Tauri desktop sidecar: embeds apps/web/dist plus the bundled
// skills/runtime helpers into a single-file `bun build --compile` binary per
// target triple, mirroring apps/cli/scripts/build-binary.ts. Output lands in
// apps/desktop/src-tauri/binaries/ as `thinkrail-sidecar-<rust-triple>[.exe]`,
// which is the layout `externalBin: ["binaries/thinkrail-sidecar"]` expects.
//
// `tauri dev` and `tauri build` run this through `beforeDevCommand` /
// `beforeBuildCommand` (after the web build), so a clean checkout has a host
// to bundle. Tauri names the triple it is packaging in
// TAURI_ENV_TARGET_TRIPLE, and the sidecar is built for that same triple:
// `tauri build --target aarch64-apple-darwin` needs the arm64 host, not the
// build machine's.
//
// On Windows targets it also builds the gate sandbox helper (`thinkrail-gate-sandbox`, the AppContainer
// launcher the factory runs gates through) into the same `binaries/` folder; `tauri.windows.conf.json`
// lists it as a second `externalBin`, so it ships next to the sidecar.

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveBuildRuntimeSources } from "@thinkrail/server/build-support";
import { channel, version } from "@thinkrail/shared/version";
import {
	HELIOS_WINDOWS_BRAND,
	windowsFileIdentity,
	windowsIconPath,
} from "@thinkrail/shared/windowsIdentity";

const desktopDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const sidecarDir = join(desktopDir, "src", "sidecar");
const webDist = join(repoRoot, "apps", "web", "dist");
const webGeneratedPath = join(sidecarDir, "web-assets.generated.ts");
const extGeneratedPath = join(sidecarDir, "bundled-extensions.generated.ts");
const runtimeGeneratedPath = join(sidecarDir, "runtime-assets.generated.ts");
const entryPath = join(sidecarDir, "desktop-sidecar-entry.ts");
// pi's codemode sandbox worker; see packages/server/src/agent/codemode/runtime.ts.
const codemodeWorkerPath = join(desktopDir, "src", "extensions", "codemode", "worker.ts");
const tauriDir = join(desktopDir, "src-tauri");
const binariesDir = join(tauriDir, "binaries");
const runtimeSources = resolveBuildRuntimeSources();

interface SidecarTarget {
	bunTarget: string;
	rustTriple: string;
	windows: boolean;
}

const SIDECAR_TARGETS: SidecarTarget[] = [
	{ bunTarget: "bun-linux-x64", rustTriple: "x86_64-unknown-linux-gnu", windows: false },
	{ bunTarget: "bun-linux-arm64", rustTriple: "aarch64-unknown-linux-gnu", windows: false },
	{ bunTarget: "bun-darwin-x64", rustTriple: "x86_64-apple-darwin", windows: false },
	{ bunTarget: "bun-darwin-arm64", rustTriple: "aarch64-apple-darwin", windows: false },
	{ bunTarget: "bun-windows-x64", rustTriple: "x86_64-pc-windows-msvc", windows: true },
];

function currentTarget(): SidecarTarget {
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	if (process.platform === "win32")
		return { bunTarget: "bun", rustTriple: `${arch}-pc-windows-msvc`, windows: true };
	if (process.platform === "darwin")
		return { bunTarget: "bun", rustTriple: `${arch}-apple-darwin`, windows: false };
	return { bunTarget: "bun", rustTriple: `${arch}-unknown-linux-gnu`, windows: false };
}

function resolveTargets(): SidecarTarget[] {
	const target =
		process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length) ||
		process.env.TAURI_ENV_TARGET_TRIPLE;
	const current = currentTarget();
	// The build machine's own triple compiles with the running Bun, which also
	// covers hosts that have no cross target listed (Windows on ARM).
	if (!target || target === current.rustTriple) return [current];
	if (target === "all") return SIDECAR_TARGETS;
	const byBun = SIDECAR_TARGETS.find((t) => t.bunTarget === target);
	if (byBun) return [byBun];
	const byTriple = SIDECAR_TARGETS.find((t) => t.rustTriple === target);
	if (byTriple) return [byTriple];
	throw new Error(
		`unknown --target=${target}; want a Bun target (${SIDECAR_TARGETS.map((t) => t.bunTarget).join(", ")}), a Rust triple, or "all"`,
	);
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

function embedFiles(
	files: { root: string; file: string; prefix?: string }[],
	importPrefix: string,
): { imports: string[]; entries: string[]; version: string } {
	const hash = createHash("sha256");
	const imports: string[] = [];
	const entries: string[] = [];
	const seen = new Set<string>();
	files.forEach(({ root, file, prefix }, i) => {
		const route = [prefix, ...relative(root, file).split(sep)].filter(Boolean).join("/");
		if (seen.has(route)) throw new Error(`duplicate embedded route: ${route}`);
		seen.add(route);
		hash.update(route).update(readFileSync(file));
		imports.push(`import ${importPrefix}${i} from ${JSON.stringify(file)} with { type: "file" };`);
		entries.push(`\t{ route: ${JSON.stringify(route)}, data: ${importPrefix}${i} },`);
	});
	return { imports, entries, version: hash.digest("hex").slice(0, 16) };
}

function generateWebManifest(): void {
	if (!existsSync(join(webDist, "index.html"))) {
		throw new Error(`web build not found at ${webDist} — run \`bun run build:web\` first.`);
	}
	const webFiles = listFiles(webDist).sort();
	const maps = webFiles.filter((file) => file.endsWith(".map"));
	if (maps.length) throw new Error(`refusing to embed web source maps: ${maps.join(", ")}`);
	const files = webFiles.map((file) => ({ root: webDist, file }));
	const { imports, entries, version } = embedFiles(files, "a");
	writeFileSync(
		webGeneratedPath,
		`// GENERATED by scripts/build-sidecar.ts — do not edit. Embeds apps/web/dist into the single-file sidecar.\n${imports.join("\n")}\n\nexport const webAssetsVersion = ${JSON.stringify(version)};\nexport const embeddedWebAssets = [\n${entries.join("\n")}\n];\n`,
	);
}

function generateBundledExtensions(): void {
	const entryPaths = runtimeSources.extensions.map((extension) => extension.entry);
	const factoryImports = entryPaths.map((path, i) => `import x${i} from ${JSON.stringify(path)};`);
	const factoryList = entryPaths.map((_, i) => `x${i}`).join(", ");
	const skillFiles = runtimeSources.skillRoots.flatMap(({ source, route }) =>
		listFiles(source)
			.sort()
			.map((file) => ({ root: source, file, prefix: route })),
	);
	const { imports, entries, version } = embedFiles(skillFiles, "s");
	writeFileSync(
		extGeneratedPath,
		`// GENERATED by scripts/build-sidecar.ts — do not edit. Value-imports the bundled pi packages and\n// embeds the bundled skills into the single-file sidecar.\n${factoryImports.join("\n")}\n${imports.join("\n")}\n\nexport const bundledExtensionFactories = [${factoryList}];\nexport const bundledSkillsVersion = ${JSON.stringify(version)};\nexport const embeddedSkillFiles = [\n${entries.join("\n")}\n];\n`,
	);
}

function generateRuntimeManifest(): void {
	const files = [runtimeSources.trashHelpers.macos, runtimeSources.trashHelpers.windows].map(
		(file) => ({ root: dirname(file), file }),
	);
	const { imports, entries, version } = embedFiles(files, "r");
	writeFileSync(
		runtimeGeneratedPath,
		`// GENERATED by scripts/build-sidecar.ts — do not edit. Embeds native runtime helper sidecars.\n${imports.join("\n")}\n\nexport const runtimeAssetsVersion = ${JSON.stringify(version)};\nexport const embeddedRuntimeAssets = [\n${entries.join("\n")}\n];\n`,
	);
}

/**
 * Builds `crates/gate-sandbox` (a member of the src-tauri Cargo workspace) and copies it to
 * `binaries/thinkrail-gate-sandbox-<triple>.exe`, the name Tauri's `externalBin` expects. Always a release
 * build: the helper is tiny, and a debug one would only make every gate slower.
 */
function buildGateSandbox(target: SidecarTarget): void {
	const cross = target.rustTriple !== currentTarget().rustTriple;
	const proc = Bun.spawnSync(
		[
			"cargo",
			"build",
			"--release",
			"-p",
			"thinkrail-gate-sandbox",
			"--manifest-path",
			join(tauriDir, "Cargo.toml"),
			...(cross ? ["--target", target.rustTriple] : []),
		],
		{ stdout: "inherit", stderr: "inherit", cwd: tauriDir },
	);
	if (!proc.success) process.exit(proc.exitCode ?? 1);
	const targetDir = process.env.CARGO_TARGET_DIR ?? join(tauriDir, "target");
	const built = join(
		targetDir,
		...(cross ? [target.rustTriple] : []),
		"release",
		"thinkrail-gate-sandbox.exe",
	);
	if (!existsSync(built)) throw new Error(`gate sandbox helper not found at ${built}`);
	const out = join(binariesDir, `thinkrail-gate-sandbox-${target.rustTriple}.exe`);
	rmSync(out, { force: true });
	copyFileSync(built, out);
	console.log(`Built gate sandbox helper: ${out}`);
}

function windowsMetadataFlags(target: SidecarTarget): string[] {
	if (!target.windows) return [];
	if (process.platform !== "win32") {
		console.warn(
			"Windows icon and file properties need a Windows host; this cross-compiled sidecar keeps Bun's.",
		);
		return [];
	}
	const identity = windowsFileIdentity({ version, channel, brand: HELIOS_WINDOWS_BRAND });
	return [
		`--windows-icon=${windowsIconPath}`,
		`--windows-title=${identity.productName}`,
		`--windows-description=${identity.productName}`,
		`--windows-publisher=${identity.companyName}`,
		`--windows-copyright=${identity.copyright}`,
		`--windows-version=${identity.fileVersion}`,
	];
}

const targets = resolveTargets();
if (!existsSync(entryPath)) throw new Error(`sidecar entry not found at ${entryPath}`);

mkdirSync(binariesDir, { recursive: true });
generateWebManifest();
generateBundledExtensions();
generateRuntimeManifest();
try {
	for (const target of targets) {
		const outFile = join(
			binariesDir,
			`thinkrail-sidecar-${target.rustTriple}${target.windows ? ".exe" : ""}`,
		);
		rmSync(outFile, { force: true });
		const proc = Bun.spawnSync(
			[
				"bun",
				"build",
				"--compile",
				"--no-compile-autoload-bunfig",
				"--bytecode",
				"--format=esm",
				"--sourcemap",
				// Embeds entrypoints relative to apps/desktop, so the codemode worker sits at the
				// `./src/extensions/codemode/worker.ts` pi resolves inside a Bun binary.
				`--root=${desktopDir}`,
				`--target=${target.bunTarget}`,
				...windowsMetadataFlags(target),
				entryPath,
				codemodeWorkerPath,
				"--outfile",
				outFile,
			],
			{ stdout: "inherit", stderr: "inherit", cwd: desktopDir },
		);
		if (!proc.success) process.exit(proc.exitCode ?? 1);
		rmSync(`${outFile}.map`, { force: true });
		console.log(`\nBuilt desktop sidecar: ${outFile}`);
		if (target.windows) buildGateSandbox(target);
	}
} finally {
	rmSync(webGeneratedPath, { force: true });
	rmSync(extGeneratedPath, { force: true });
	rmSync(runtimeGeneratedPath, { force: true });
}
