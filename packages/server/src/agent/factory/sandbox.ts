import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { dependencyTargets, type ExecResult, type GateRunner, runCommand } from "pi-swarm";
import { logger } from "../../log";

const log = logger("factory");

/**
 * OS sandboxing for factory gate processes. A gate is the project's own `typecheck`/`lint`/`test` script, so
 * it runs code a coder agent may have changed (a script reaching a changed source file, a test, a config).
 * The immutable snapshot checkout already keeps it away from the worker's files; this adds the OS boundary:
 *
 * - the snapshot checkout and the dependency folders linked into it are readable and never writable, so a
 *   gate cannot rewrite its own inputs (nor change a file and put it back);
 * - exactly one private scratch directory is writable (it also becomes `TEMP` and the home directory);
 * - no network at all, loopback included;
 * - nothing of the user's profile is readable, and no host secret reaches the process: the environment is
 *   an allowlist, never the host's.
 *
 * It is **fail closed**: when no sandbox can be set up (helper missing, `bwrap` absent, an unsupported OS) the
 * gates do not run at all and the gate record says why.
 *
 * Windows runs the gate through `thinkrail-gate-sandbox.exe` (an AppContainer, shipped next to the sidecar),
 * Linux through bubblewrap and macOS through `sandbox-exec`.
 */

/** What the Windows helper prints (with exit code 125) when it could not set up: the gate never ran. */
export const SANDBOX_ERROR_MARKER = "HELIOS_GATE_SANDBOX_ERROR";
const HELPER_EXIT_SETUP_FAILED = 125;
/** Overrides where the Windows helper is looked for (the default is next to the host executable). */
export const HELPER_ENV = "THINKRAIL_GATE_SANDBOX_HELPER";
const HELPER_NAME = "thinkrail-gate-sandbox.exe";
const HELPER_GRACE_MS = 30_000;
const HELPER_KILL_MS = 15_000;

export interface SandboxRequest {
	/** The gate command: one shell command line (`bun run test`). */
	command: string;
	/** The snapshot checkout the command runs in. Readable, never writable. */
	cwd: string;
	/** Further folders the command must read: the checkout's dependency folders. */
	readPaths: string[];
	/** Toolchain folders (the package manager's own) to read when they can be shared. */
	toolPaths: string[];
	/**
	 * Folders above the checkout to list (not read inside): some tools (Bun) open every parent of their working
	 * directory and refuse to start when one is closed. Best effort, folders only.
	 */
	traversePaths?: string[];
	/** The one writable directory; also the command's temp and home directory. */
	scratch: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export type SandboxAvailability = { ok: true } | { ok: false; reason: string };

export interface GateSandbox {
	/** Which mechanism confines the gates ("appcontainer", "bubblewrap", "sandbox-exec", ...). */
	readonly kind: string;
	/**
	 * Where the throwaway snapshot checkouts are made, when the sandbox needs them somewhere particular
	 * (given the usual root). Unset means the usual root.
	 */
	checkoutRoot?(usualRoot: string): string;
	/** Whether gates can run confined right now; asked before any checkout is made. */
	availability(): Promise<SandboxAvailability>;
	/** Runs one command inside the sandbox. Throws {@link SandboxUnavailableError} when it cannot be set up. */
	launch(request: SandboxRequest): Promise<ExecResult>;
}

/** The sandbox could not be set up for this run: the command never executed. */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

/** A sandbox that is not there: every gate is refused with `reason`. */
export function unavailableSandbox(reason: string, kind = "none"): GateSandbox {
	return {
		kind,
		availability: async () => ({ ok: false, reason }),
		launch: async () => {
			throw new SandboxUnavailableError(reason);
		},
	};
}

type Platform = NodeJS.Platform;
type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------------------
// Environment and toolchain
// ---------------------------------------------------------------------------------------------------------

const WINDOWS_ENV = [
	"SystemRoot",
	"SystemDrive",
	"windir",
	"ComSpec",
	"PATHEXT",
	"PATH",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"NUMBER_OF_PROCESSORS",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"CommonProgramFiles",
	"ProgramData",
	"LANG",
] as const;
const UNIX_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/**
 * The environment a gate gets: an allowlist of what the toolchain needs, with temp/home pointing at the
 * scratch directory. Nothing else of the host's (API keys, tokens, `SSH_AUTH_SOCK`, ...) is passed on.
 */
export function gateEnvironment(
	platform: Platform,
	scratch: string,
	host: Env,
): Record<string, string> {
	const env: Record<string, string> = {};
	const lookup = (name: string) => {
		const key = Object.keys(host).find((candidate) =>
			platform === "win32" ? candidate.toLowerCase() === name.toLowerCase() : candidate === name,
		);
		return key ? host[key] : undefined;
	};
	for (const name of platform === "win32" ? WINDOWS_ENV : UNIX_ENV) {
		const value = lookup(name);
		if (value !== undefined) env[name] = value;
	}
	Object.assign(env, {
		TMPDIR: scratch,
		TMP: scratch,
		TEMP: scratch,
		HOME: scratch,
		CI: "1",
		NO_COLOR: "1",
		TERM: "dumb",
	});
	if (platform === "win32") {
		// Windows places the container's own folders under LOCALAPPDATA and refuses to start without one.
		Object.assign(env, { USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch });
	}
	return env;
}

/** The program a command line starts with (`"C:\\Program Files\\x\\y.exe" arg` or `bun run test`). */
export function leadingProgram(command: string): string | undefined {
	const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Resolves a program through PATH (and PATHEXT on Windows), the way a shell would. */
export function findProgram(
	name: string,
	env: Env,
	platform: Platform = process.platform,
): string | undefined {
	const exts =
		platform === "win32"
			? ["", ...(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
			: [""];
	const candidates = (base: string) =>
		exts.map((ext) =>
			ext && extname(base).toLowerCase() === ext.toLowerCase() ? base : base + ext,
		);
	if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
		return candidates(name).find((file) => existsSync(file));
	}
	const path = env.PATH ?? env.Path ?? "";
	for (const dir of path.split(delimiter).filter(Boolean)) {
		const hit = candidates(join(dir, name)).find((file) => existsSync(file));
		if (hit) return hit;
	}
	return undefined;
}

/**
 * The folders holding the programs the gate commands (and the runtimes they hand over to) start, so a
 * sandbox can share them read-only. Folders every sandbox already reads (the operating system's and
 * `Program Files`) are left out: they need no grant, and a grant there would only fail.
 */
export function toolchainFolders(
	commands: readonly string[],
	env: Env,
	platform: Platform = process.platform,
): string[] {
	const names = new Set<string>(["bun", "node"]);
	for (const command of commands) {
		const program = leadingProgram(command);
		if (program) names.add(program);
	}
	const system =
		platform === "win32"
			? [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]
			: ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
	const isSystem = (dir: string) =>
		system.some((root) => {
			if (!root) return false;
			const [a, b] = platform === "win32" ? [dir.toLowerCase(), root.toLowerCase()] : [dir, root];
			return (
				a === b ||
				a.startsWith(
					b.endsWith("\\") || b.endsWith("/") ? b : `${b}${platform === "win32" ? "\\" : "/"}`,
				)
			);
		});
	const folders = new Set<string>();
	for (const name of names) {
		const found = findProgram(name, env, platform);
		if (!found) continue;
		let dir = dirname(found);
		try {
			dir = realpathSync(dir);
		} catch {}
		if (!isSystem(dir)) folders.add(dir);
	}
	return [...folders];
}

// ---------------------------------------------------------------------------------------------------------
// Windows: the AppContainer helper
// ---------------------------------------------------------------------------------------------------------

/** Where the helper is: `THINKRAIL_GATE_SANDBOX_HELPER`, else next to the running host executable. */
export function windowsHelperPath(
	env: Env = process.env,
	execPath = process.execPath,
): string | undefined {
	const explicit = env[HELPER_ENV];
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	const sibling = join(dirname(execPath), HELPER_NAME);
	return existsSync(sibling) ? sibling : undefined;
}

/**
 * Every folder above `paths` (not the paths themselves, not the filesystem root), nearest first and without
 * repeats. See `SandboxRequest.traversePaths`.
 */
export function ancestorsOf(paths: readonly string[]): string[] {
	const found = new Set<string>();
	for (const path of paths) {
		let current = dirname(path);
		while (dirname(current) !== current) {
			found.add(current);
			current = dirname(current);
		}
	}
	return [...found];
}

/** `"cmd.exe" /d /s /c "<command>"`: the raw command line the helper hands to `CreateProcessW`. */
export function windowsCommandLine(command: string, comspec: string): string {
	return `"${comspec}" /d /s /c "${command}"`;
}

/** The helper's argument list for one request. Pure, so it is tested without a helper. */
export function windowsHelperArgs(
	request: SandboxRequest,
	env: Record<string, string>,
	comspec: string,
): string[] {
	return [
		"run",
		"--cwd",
		request.cwd,
		"--cmdline",
		windowsCommandLine(request.command, comspec),
		"--timeout-ms",
		String(Math.max(1, Math.round(request.timeoutMs))),
		...[request.cwd, ...request.readPaths].flatMap((path) => ["--read", path]),
		...request.toolPaths.flatMap((path) => ["--read-optional", path]),
		...(request.traversePaths ?? []).flatMap((path) => ["--traverse", path]),
		"--write",
		request.scratch,
		...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
	];
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
			"error",
			() => {},
		);
	} catch {}
}

/**
 * Runs the helper with its stdin held open: that pipe is the control channel, and closing it makes the
 * helper stop the command, revoke its access entries and delete the container profile. Only if it does
 * not exit then is it killed outright.
 */
function runHelper(
	helper: string,
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
	const started = Date.now();
	return new Promise((resolvePromise, reject) => {
		if (options.signal?.aborted) {
			reject(options.signal.reason ?? new Error("The gate run was cancelled"));
			return;
		}
		const child = spawn(helper, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", () => {});
		let force: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (force) return;
			child.stdin.end();
			force = setTimeout(() => killTree(child.pid), HELPER_KILL_MS);
		};
		// The helper enforces the timeout itself; this is only the backstop for a helper that is stuck.
		const backstop = setTimeout(stop, options.timeoutMs + HELPER_GRACE_MS);
		options.signal?.addEventListener("abort", stop, { once: true });
		const cleanup = () => {
			clearTimeout(backstop);
			if (force) clearTimeout(force);
			options.signal?.removeEventListener("abort", stop);
		};
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			const marker = err.indexOf(SANDBOX_ERROR_MARKER);
			if (code === HELPER_EXIT_SETUP_FAILED && marker >= 0) {
				reject(
					new SandboxUnavailableError(
						err
							.slice(marker + SANDBOX_ERROR_MARKER.length)
							.replace(/^[:\s]+/, "")
							.trim(),
					),
				);
				return;
			}
			resolvePromise({ code, stdout: out, stderr: err, durationMs: Date.now() - started });
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new SandboxUnavailableError(`The sandbox helper could not start: ${error.message}`));
		});
		child.on("close", finish);
		child.on("exit", (code) => {
			setTimeout(() => finish(code), 1_000).unref?.();
		});
	});
}

/**
 * `bun run <script>` executes scripts in Bun's built-in shell, which opens the working directory for writing,
 * so it cannot run in a read-only checkout. Bun's `--shell=system` runs them through cmd.exe instead. The
 * flag is injected by a `bun.cmd` placed first on the gate's PATH (in the scratch directory), so the
 * project's gate command stays what the project declared.
 */
export function bunShimScript(realBun: string): string {
	const real = `"${realBun}"`;
	return [
		"@echo off",
		'if /i "%~1"=="run" goto run',
		`${real} %*`,
		"exit /b %errorlevel%",
		":run",
		`for /f "tokens=1*" %%a in ("%*") do ${real} run --shell=system %%b`,
		"exit /b %errorlevel%",
		"",
	].join("\r\n");
}

function installBunShim(scratch: string, env: Env): string | undefined {
	const bun = findProgram("bun", env, "win32");
	if (!bun) return undefined;
	const dir = join(scratch, ".helios-shims");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bun.cmd"), bunShimScript(bun));
	return dir;
}

export function appContainerSandbox(
	options: { helperPath?: () => string | undefined; env?: Env; comspec?: string } = {},
): GateSandbox {
	const hostEnv = options.env ?? process.env;
	const locate = options.helperPath ?? (() => windowsHelperPath(hostEnv));
	const comspec = options.comspec ?? hostEnv.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
	let verified: string | undefined;
	return {
		kind: "appcontainer",
		// Bun opens every parent folder of its working directory and fails on one the container cannot
		// list (`C:Users`, `C:ProgramData` ...), and no ACL change is possible on those. A folder created
		// directly under the drive root is the one place whose whole chain is ours to open.
		checkoutRoot: (usualRoot) => join(parse(resolve(usualRoot)).root, "helios-gates"),
		async availability() {
			const helper = locate();
			if (!helper) {
				return {
					ok: false,
					reason: `No gate sandbox: ${HELPER_NAME} was not found next to the host executable (or at ${HELPER_ENV}). Gates are not run without it.`,
				};
			}
			if (verified === helper) return { ok: true };
			try {
				const result = await runHelper(helper, ["check"], { timeoutMs: 30_000 });
				if (result.code !== 0) throw new Error(result.stderr.trim() || `exit code ${result.code}`);
			} catch (error) {
				return {
					ok: false,
					reason: `No gate sandbox: the AppContainer helper does not work on this machine (${error instanceof Error ? error.message : String(error)}). Gates are not run without it.`,
				};
			}
			verified = helper;
			return { ok: true };
		},
		async launch(request) {
			const helper = locate();
			if (!helper) throw new SandboxUnavailableError(`${HELPER_NAME} was not found`);
			const env = gateEnvironment("win32", request.scratch, hostEnv);
			const shims = installBunShim(request.scratch, hostEnv);
			if (shims) env.PATH = `${shims};${env.PATH ?? ""}`;
			return runHelper(helper, windowsHelperArgs(request, env, comspec), {
				timeoutMs: request.timeoutMs,
				...(request.signal ? { signal: request.signal } : {}),
			});
		},
	};
}

// ---------------------------------------------------------------------------------------------------------
// Linux: bubblewrap, macOS: sandbox-exec
// ---------------------------------------------------------------------------------------------------------

/** The `bwrap` argument list: the system read-only, the profile hidden, the checkout read-only, no network. */
export function bwrapArgs(
	request: SandboxRequest,
	env: Record<string, string>,
	home: string | undefined,
): string[] {
	const hideHome = home && home !== "/" ? ["--tmpfs", home] : [];
	return [
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--unshare-net",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		...hideHome,
		// Binds after the hiding tmpfs, so they show through it.
		...request.toolPaths.flatMap((path) => ["--ro-bind-try", path, path]),
		...[request.cwd, ...request.readPaths].flatMap((path) => ["--ro-bind", path, path]),
		"--bind",
		request.scratch,
		request.scratch,
		"--clearenv",
		...Object.entries(env).flatMap(([name, value]) => ["--setenv", name, value]),
		"--chdir",
		request.cwd,
		"--",
		"/bin/sh",
		"-c",
		request.command,
	];
}

const BWRAP_PROBE = [
	"--unshare-all",
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--",
	"/bin/sh",
	"-c",
	"exit 0",
];

export function bubblewrapSandbox(
	options: { env?: Env; which?: (name: string) => string | undefined } = {},
): GateSandbox {
	const hostEnv = options.env ?? process.env;
	const which = options.which ?? ((name: string) => findProgram(name, hostEnv, "linux"));
	let verified: string | undefined;
	return {
		kind: "bubblewrap",
		async availability() {
			const bwrap = which("bwrap");
			if (!bwrap) {
				return {
					ok: false,
					reason:
						"No gate sandbox: bubblewrap (`bwrap`) is not installed. Gates are not run without it.",
				};
			}
			if (verified === bwrap) return { ok: true };
			const probe = await runCommand(bwrap, BWRAP_PROBE, {
				cwd: tmpdir(),
				timeoutMs: 30_000,
			}).catch((error: unknown) => ({
				code: null,
				stderr: String(error),
				stdout: "",
				durationMs: 0,
			}));
			if (probe.code !== 0) {
				return {
					ok: false,
					reason: `No gate sandbox: bubblewrap cannot create a sandbox here (${probe.stderr.trim() || `exit code ${probe.code}`}). Gates are not run without it.`,
				};
			}
			verified = bwrap;
			return { ok: true };
		},
		async launch(request) {
			const bwrap = which("bwrap");
			if (!bwrap) throw new SandboxUnavailableError("bubblewrap (`bwrap`) is not installed");
			const env = gateEnvironment("linux", request.scratch, hostEnv);
			return runCommand(bwrap, bwrapArgs(request, env, homedir()), {
				cwd: request.scratch,
				timeoutMs: request.timeoutMs,
				...(request.signal ? { signal: request.signal } : {}),
			});
		},
	};
}

function sbplString(value: string): string {
	return JSON.stringify(value);
}

/** The `sandbox-exec` profile: no network, writes only in the scratch directory, the profile unreadable. */
export function seatbeltProfile(request: SandboxRequest, home: string | undefined): string {
	const reads = [request.cwd, ...request.readPaths, ...request.toolPaths, request.scratch];
	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny file-write*)",
		`(allow file-write* (subpath ${sbplString(request.scratch)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
		...(home && home !== "/"
			? [
					`(deny file-read* (subpath ${sbplString(home)}))`,
					...reads.map((path) => `(allow file-read* (subpath ${sbplString(path)}))`),
				]
			: []),
		"",
	].join("\n");
}

function realPaths(request: SandboxRequest): SandboxRequest {
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return {
		...request,
		cwd: real(request.cwd),
		scratch: real(request.scratch),
		readPaths: request.readPaths.map(real),
		toolPaths: request.toolPaths.map(real),
	};
}

export function seatbeltSandbox(options: { env?: Env; exec?: string } = {}): GateSandbox {
	const hostEnv = options.env ?? process.env;
	const exec = options.exec ?? "/usr/bin/sandbox-exec";
	let verified = false;
	return {
		kind: "sandbox-exec",
		async availability() {
			if (!existsSync(exec)) {
				return {
					ok: false,
					reason:
						"No gate sandbox: /usr/bin/sandbox-exec is missing. Gates are not run without it.",
				};
			}
			if (verified) return { ok: true };
			const probe = await runCommand(
				exec,
				["-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"],
				{
					cwd: tmpdir(),
					timeoutMs: 30_000,
				},
			).catch((error: unknown) => ({
				code: null,
				stderr: String(error),
				stdout: "",
				durationMs: 0,
			}));
			if (probe.code !== 0) {
				return {
					ok: false,
					reason: `No gate sandbox: sandbox-exec does not work here (${probe.stderr.trim() || `exit code ${probe.code}`}). Gates are not run without it.`,
				};
			}
			verified = true;
			return { ok: true };
		},
		async launch(request) {
			if (!existsSync(exec)) throw new SandboxUnavailableError("/usr/bin/sandbox-exec is missing");
			const real = realPaths(request);
			const env = gateEnvironment("darwin", real.scratch, hostEnv);
			// `env -i` first: the host's environment (and its secrets) never reach the gate.
			return runCommand(
				"/usr/bin/env",
				[
					"-i",
					...Object.entries(env).map(([name, value]) => `${name}=${value}`),
					exec,
					"-p",
					seatbeltProfile(real, homedir()),
					"/bin/sh",
					"-c",
					real.command,
				],
				{
					cwd: real.cwd,
					timeoutMs: real.timeoutMs,
					...(real.signal ? { signal: real.signal } : {}),
				},
			);
		},
	};
}

/** The sandbox this machine offers, or one that refuses every gate with the reason. */
export function platformGateSandbox(platform: Platform = process.platform): GateSandbox {
	switch (platform) {
		case "win32":
			return appContainerSandbox();
		case "linux":
			return bubblewrapSandbox();
		case "darwin":
			return seatbeltSandbox();
		default:
			return unavailableSandbox(
				`No gate sandbox exists for ${platform}. Gates are not run without one.`,
			);
	}
}

let shared: GateSandbox | undefined;
/** The process-wide default (the platform's sandbox), created on first use so its probe result is cached. */
export function defaultGateSandbox(): GateSandbox {
	shared ??= platformGateSandbox();
	return shared;
}

/**
 * Replaces the process-wide default (`undefined` restores the platform's). A test seam: the factory's
 * integration tests run gates in-process through `dagServiceFor`, which has no place to inject one.
 */
export function setDefaultGateSandbox(sandbox: GateSandbox | undefined): void {
	shared = sandbox;
}

// ---------------------------------------------------------------------------------------------------------
// Running a gate set
// ---------------------------------------------------------------------------------------------------------

export interface ConfinedGates {
	/** For pi-swarm's `runGates`: every command goes through the sandbox. */
	runner: GateRunner;
	/** Why the sandbox could not be set up, when a command hit that (the command never ran). */
	unavailable(): string | undefined;
}

/**
 * Prepares the private scratch directory and the read-only grants for one checkout, hands `use` a
 * runner that confines each command, then deletes the scratch directory.
 */
export async function withGateSandbox<T>(
	sandbox: GateSandbox,
	context: { checkout: string; commands: readonly string[]; env?: Env },
	use: (gates: ConfinedGates) => Promise<T>,
): Promise<T> {
	const env = context.env ?? process.env;
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	const checkout = real(context.checkout);
	const scratch = real(mkdtempSync(join(tmpdir(), "helios-gate-")));
	const readPaths = [...new Set(dependencyTargets(context.checkout).map(real))].filter(
		(path) => path !== checkout,
	);
	const toolPaths = toolchainFolders(context.commands, env);
	const traversePaths = ancestorsOf([checkout, scratch, ...readPaths, ...toolPaths]);
	let unavailable: string | undefined;
	const runner: GateRunner = async (command, options) => {
		try {
			return await sandbox.launch({
				command,
				cwd: checkout,
				readPaths,
				toolPaths,
				traversePaths,
				scratch,
				timeoutMs: options.timeoutMs,
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (error) {
			if (error instanceof SandboxUnavailableError) unavailable ??= error.message;
			throw error;
		}
	};
	try {
		return await use({ runner, unavailable: () => unavailable });
	} finally {
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch (error) {
			log.warn(`could not delete the gate scratch directory ${scratch}`, error);
		}
	}
}
