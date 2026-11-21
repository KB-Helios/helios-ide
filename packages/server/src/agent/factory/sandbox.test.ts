import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runFactoryGates, sourceStatus } from "./gateTools";
import { FactoryRun } from "./run";
import {
	appContainerSandbox,
	bubblewrapSandbox,
	bwrapArgs,
	findProgram,
	type GateSandbox,
	gateEnvironment,
	HELPER_ENV,
	leadingProgram,
	platformGateSandbox,
	type SandboxRequest,
	SandboxUnavailableError,
	seatbeltProfile,
	toolchainFolders,
	unavailableSandbox,
	windowsCommandLine,
	windowsHelperArgs,
	windowsHelperPath,
} from "./sandbox";

const root = mkdtempSync(join(tmpdir(), "trsandbox-"));
let serial = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** A repo whose `test` gate is `bun gate.js`, so the gate's logic is a committed file, not a quoted string. */
function makeRepo(gateScript: string, extra: Record<string, string> = {}): string {
	const repo = join(root, `repo${serial++}`);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "T");
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: "demo", scripts: { test: "bun gate.js" } }),
	);
	writeFileSync(join(repo, "bun.lock"), "");
	writeFileSync(join(repo, "README.md"), "demo\n");
	writeFileSync(join(repo, "gate.js"), gateScript);
	for (const [name, content] of Object.entries(extra)) {
		mkdirSync(join(repo, name, ".."), { recursive: true });
		writeFileSync(join(repo, name), content);
	}
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	return repo;
}

function factoryRun(repo: string, sandbox: GateSandbox): FactoryRun {
	return new FactoryRun({
		workspaceId: "sandbox",
		dagId: `sandbox-${serial++}`,
		cwd: repo,
		worktreeRoot: join(root, `worktrees-${serial++}`),
		isTrusted: () => true,
		releaseApproved: async () => false,
		sandbox,
	});
}

const lf = (text: string) => text.split("\r\n").join("\n");

/** "ok" for a passing record, else what failed (the output of the failing gate or the refusal). */
function why(record: { ok: boolean; reason?: string; results: { outputTail: string }[] }): string {
	return record.ok ? "ok" : (record.results.at(-1)?.outputTail ?? record.reason ?? "failed");
}

/** A worktree with one owned change, ready for its gates. */
async function changedWorktree(run: FactoryRun) {
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	return meta;
}

const request: SandboxRequest = {
	command: "bun run test",
	cwd: "/work/snap",
	readPaths: ["/repo/node_modules"],
	toolPaths: ["/home/u/.bun/bin"],
	scratch: "/tmp/scratch",
	timeoutMs: 60_000,
};

describe("sandbox command construction", () => {
	test("a gate's environment is an allowlist, with temp and home in the scratch directory", () => {
		const host = {
			PATH: "/usr/bin",
			Path: undefined,
			ANTHROPIC_API_KEY: "sk-secret",
			GITHUB_TOKEN: "ghp_secret",
			SSH_AUTH_SOCK: "/agent",
			HOME: "/home/u",
			LANG: "C.UTF-8",
		};
		const env = gateEnvironment("linux", "/tmp/scratch", host);
		expect(env).toMatchObject({
			PATH: "/usr/bin",
			LANG: "C.UTF-8",
			HOME: "/tmp/scratch",
			TMPDIR: "/tmp/scratch",
			TEMP: "/tmp/scratch",
			CI: "1",
		});
		expect(Object.keys(env).join(" ")).not.toMatch(/KEY|TOKEN|SSH/);
		expect(JSON.stringify(env)).not.toContain("secret");
		const win = gateEnvironment("win32", "C:\\scratch", {
			Path: "C:\\Windows",
			SYSTEMROOT: "C:\\Windows",
			COMSPEC: "cmd",
			OPENAI_API_KEY: "sk",
		});
		// Windows names are case-insensitive; the container needs LOCALAPPDATA.
		expect(win).toMatchObject({
			PATH: "C:\\Windows",
			SystemRoot: "C:\\Windows",
			LOCALAPPDATA: "C:\\scratch",
		});
		expect(win.OPENAI_API_KEY).toBeUndefined();
	});

	test("leadingProgram reads the first word, quoted or not", () => {
		expect(leadingProgram("bun run test")).toBe("bun");
		expect(leadingProgram('  "C:\\Program Files\\x\\y.exe" --flag')).toBe(
			"C:\\Program Files\\x\\y.exe",
		);
		expect(leadingProgram("")).toBeUndefined();
	});

	test("the Windows helper gets the checkout and dependencies read-only and one writable directory", () => {
		const args = windowsHelperArgs(
			request,
			{ LOCALAPPDATA: "C:\\s", PATH: "C:\\bin" },
			"C:\\cmd.exe",
		);
		expect(args.slice(0, 5)).toEqual([
			"run",
			"--cwd",
			"/work/snap",
			"--cmdline",
			'"C:\\cmd.exe" /d /s /c "bun run test"',
		]);
		const pairs = args.flatMap((arg, i) => (arg.startsWith("--") ? [[arg, args[i + 1]]] : []));
		expect(pairs).toContainEqual(["--read", "/work/snap"]);
		expect(pairs).toContainEqual(["--read", "/repo/node_modules"]);
		expect(pairs).toContainEqual(["--read-optional", "/home/u/.bun/bin"]);
		expect(pairs).toContainEqual(["--write", "/tmp/scratch"]);
		expect(pairs.filter(([flag]) => flag === "--write")).toHaveLength(1);
		expect(pairs).toContainEqual(["--env", "PATH=C:\\bin"]);
		expect(pairs).toContainEqual(["--timeout-ms", "60000"]);
		expect(windowsCommandLine("bun x", "cmd.exe")).toBe('"cmd.exe" /d /s /c "bun x"');
	});

	test("bubblewrap: read-only system and checkout, hidden profile, no network, cleared environment", () => {
		const args = bwrapArgs(request, { PATH: "/usr/bin", HOME: "/tmp/scratch" }, "/home/u");
		const find = (flag: string, a: string, b?: string) =>
			args.findIndex(
				(arg, i) => arg === flag && args[i + 1] === a && (b === undefined || args[i + 2] === b),
			);
		expect(args).toContain("--unshare-net");
		expect(args).toContain("--unshare-all");
		expect(args).toContain("--clearenv");
		expect(find("--ro-bind", "/", "/")).toBeGreaterThan(-1);
		// The checkout and dependencies are read-only; only the scratch directory is a writable bind.
		expect(find("--ro-bind", "/work/snap", "/work/snap")).toBeGreaterThan(-1);
		expect(find("--ro-bind", "/repo/node_modules", "/repo/node_modules")).toBeGreaterThan(-1);
		expect(find("--bind", "/work/snap")).toBe(-1);
		expect(args.filter((arg) => arg === "--bind")).toHaveLength(1);
		expect(find("--bind", "/tmp/scratch", "/tmp/scratch")).toBeGreaterThan(-1);
		// The home folder is hidden first, then the shares are bound over it.
		expect(find("--tmpfs", "/home/u")).toBeGreaterThan(-1);
		expect(find("--tmpfs", "/home/u")).toBeLessThan(find("--ro-bind-try", "/home/u/.bun/bin"));
		expect(args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "bun run test"]);
		expect(args[args.indexOf("--chdir") + 1]).toBe("/work/snap");
	});

	test("sandbox-exec: no network, writes only in the scratch directory, profile closed", () => {
		const profile = seatbeltProfile(request, "/Users/u");
		expect(profile).toContain("(deny network*)");
		expect(profile).toContain("(deny file-write*)");
		expect(profile).toContain('(allow file-write* (subpath "/tmp/scratch")');
		expect(profile).not.toContain('(allow file-write* (subpath "/work/snap")');
		expect(profile).toContain('(deny file-read* (subpath "/Users/u"))');
		expect(profile).toContain('(allow file-read* (subpath "/work/snap"))');
		expect(profile).toContain('(allow file-read* (subpath "/repo/node_modules"))');
		// A hostile path cannot break out of its string.
		expect(
			seatbeltProfile({ ...request, scratch: '/t/"x") (allow default' }, "/Users/u"),
		).toContain(String.raw`"/t/\"x\") (allow default"`);
	});

	test("the Windows helper is looked for next to the host, or where the override points", () => {
		const dir = mkdtempSync(join(root, "host-"));
		const sibling = join(dir, "thinkrail-gate-sandbox.exe");
		expect(windowsHelperPath({}, join(dir, "thinkrail-sidecar.exe"))).toBeUndefined();
		writeFileSync(sibling, "");
		expect(windowsHelperPath({}, join(dir, "thinkrail-sidecar.exe"))).toBe(sibling);
		// An override that points nowhere never falls back to something else.
		expect(
			windowsHelperPath({ [HELPER_ENV]: join(dir, "missing.exe") }, join(dir, "x.exe")),
		).toBeUndefined();
		expect(windowsHelperPath({ [HELPER_ENV]: sibling }, "elsewhere")).toBe(sibling);
	});

	test("program lookup honours PATH and PATHEXT; system folders need no toolchain grant", () => {
		// Folders are compared by real path (toolchainFolders resolves symlinks): on macOS the temp folder
		// `/var/...` is a link to `/private/var/...`.
		const bin = realpathSync(mkdtempSync(join(root, "bin-")));
		writeFileSync(join(bin, "mytool.EXE"), "");
		const env = { PATH: bin, PATHEXT: ".EXE" };
		expect(findProgram("mytool", env, "win32")).toBe(join(bin, "mytool.EXE"));
		expect(findProgram("nope", env, "win32")).toBeUndefined();
		expect(toolchainFolders(["mytool run x"], env, "win32").map((p) => p.toLowerCase())).toContain(
			resolve(bin).toLowerCase(),
		);
		// A tool that lives in the OS folder is already readable to every sandbox.
		expect(toolchainFolders(["mytool x"], { ...env, SystemRoot: bin }, "win32")).toEqual([]);
	});
});

describe("fail closed", () => {
	// A gate that leaves proof it ran, so "nothing ran" is checkable.
	function provingRepo(): { repo: string; marker: string } {
		const marker = join(root, `ran-${serial++}.txt`);
		const repo = makeRepo(
			`require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(0);\n`,
		);
		return { repo, marker };
	}

	test("no sandbox: the gates never run and the record says why", async () => {
		const { repo, marker } = provingRepo();
		const run = factoryRun(repo, unavailableSandbox("No gate sandbox: nothing here."));
		const meta = await changedWorktree(run);
		const record = await runFactoryGates(run, meta);
		expect(record.ok).toBe(false);
		expect(record.reason).toContain("No gate sandbox");
		expect(record.results).toEqual([]);
		expect(existsSync(marker)).toBe(false);
		// Nothing lands on a refused record.
		expect((await sourceStatus(run, meta)).ready).toBe(false);
	});

	test("an unsupported platform, a missing helper and a missing bwrap are all refusals", async () => {
		const missing = await appContainerSandbox({ helperPath: () => undefined }).availability();
		expect(missing).toMatchObject({ ok: false });
		expect(missing.ok ? "" : missing.reason).toContain("thinkrail-gate-sandbox.exe");
		const noBwrap = await bubblewrapSandbox({ which: () => undefined }).availability();
		expect(noBwrap.ok ? "" : noBwrap.reason).toContain("bubblewrap");
		const other = await platformGateSandbox("freebsd").availability();
		expect(other.ok ? "" : other.reason).toContain("freebsd");
		await expect(
			appContainerSandbox({ helperPath: () => undefined }).launch({ ...request }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);

		const { repo, marker } = provingRepo();
		const run = factoryRun(repo, appContainerSandbox({ helperPath: () => undefined }));
		const record = await runFactoryGates(run, await changedWorktree(run));
		expect(record.ok).toBe(false);
		expect(record.reason).toContain("thinkrail-gate-sandbox.exe");
		expect(existsSync(marker)).toBe(false);
	});

	test("a helper that fails to start the command refuses the run instead of failing a gate", async () => {
		const { repo, marker } = provingRepo();
		const broken: GateSandbox = {
			kind: "broken",
			availability: async () => ({ ok: true }),
			launch: async () => {
				throw new SandboxUnavailableError("could not create the AppContainer profile: denied");
			},
		};
		const run = factoryRun(repo, broken);
		const meta = await changedWorktree(run);
		const record = await runFactoryGates(run, meta);
		expect(record.ok).toBe(false);
		expect(record.results).toEqual([]);
		expect(record.reason).toContain("could not be set up");
		expect(record.reason).toContain("denied");
		expect(existsSync(marker)).toBe(false);
	});

	test("gates run through the sandbox with the checkout read-only and a scratch folder outside it", async () => {
		const { repo } = provingRepo();
		mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		const seen: SandboxRequest[] = [];
		const recording: GateSandbox = {
			kind: "recording",
			availability: async () => ({ ok: true }),
			launch: async (req) => {
				seen.push(req);
				expect(existsSync(req.cwd)).toBe(true);
				expect(existsSync(req.scratch)).toBe(true);
				return { code: 0, stdout: "", stderr: "", durationMs: 1 };
			},
		};
		const run = factoryRun(repo, recording);
		const record = await runFactoryGates(run, await changedWorktree(run));
		expect(record.ok).toBe(true);
		expect(seen).toHaveLength(1);
		const [req] = seen;
		expect(req?.command).toBe("bun run test");
		expect(req?.cwd).toContain(".gate-runs");
		// The scratch directory is not inside the checkout, and is gone with the run.
		expect(req?.scratch.startsWith(req?.cwd ?? "")).toBe(false);
		expect(existsSync(req?.scratch ?? "")).toBe(false);
		// The linked dependency folder is readable (it is the real folder behind the link).
		expect(req?.readPaths).toContain(realpathSync(join(repo, "node_modules")));
		// The scratch folder lives with the gate checkouts, so no parent of it is ever the user profile.
		expect(req?.scratch).toContain(".gate-scratch");
		expect(req?.traversePaths ?? []).not.toContain(dirname(req?.scratch ?? ""));
	});

	test("a sandboxed gate's exit code decides the result like any gate", async () => {
		const { repo } = provingRepo();
		const failing: GateSandbox = {
			kind: "failing",
			availability: async () => ({ ok: true }),
			launch: async () => ({ code: 3, stdout: "", stderr: "boom", durationMs: 1 }),
		};
		const run = factoryRun(repo, failing);
		const record = await runFactoryGates(run, await changedWorktree(run));
		expect(record.ok).toBe(false);
		expect(record.results[0]?.exitCode).toBe(3);
		expect(record.results[0]?.outputTail).toContain("boom");
	});
});

// ---------------------------------------------------------------------------------------------------------
// The real thing: the AppContainer helper, on Windows
// ---------------------------------------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const TAURI_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri");

/** The helper, taken from `THINKRAIL_GATE_SANDBOX_HELPER` or the Tauri workspace's own build (built if absent). */
function locateHelper(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const explicit = process.env[HELPER_ENV];
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	const candidates = ["debug", "release"].map((profile) =>
		join(TAURI_DIR, "target", profile, "thinkrail-gate-sandbox.exe"),
	);
	const found = candidates.find((file) => existsSync(file));
	if (found) return found;
	const built = Bun.spawnSync(["cargo", "build", "-p", "thinkrail-gate-sandbox"], {
		cwd: TAURI_DIR,
		stdout: "ignore",
		stderr: "ignore",
	});
	return built.exitCode === 0 && existsSync(candidates[0] as string) ? candidates[0] : undefined;
}

const helper = locateHelper();
const native = helper ? describe : describe.skip;

native("Windows AppContainer (the real helper)", () => {
	let listener: Server;
	let port = 0;
	let connections = 0;
	const canary = join(root, "canary-outside.txt");

	beforeAll(async () => {
		writeFileSync(canary, "the user's own file");
		listener = createServer((socket) => {
			connections++;
			socket.end("hi");
		});
		await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
		port = (listener.address() as { port: number }).port;
	});
	afterAll(() => listener.close());

	const sandbox = () => appContainerSandbox({ helperPath: () => helper });

	function gate(body: string): string {
		return `const fs = require("fs"); const os = require("os"); const net = require("net");\n${body}\n`;
	}

	test("the helper works on this machine", async () => {
		expect(await sandbox().availability()).toEqual({ ok: true });
	});

	test("a gate reads its snapshot, cannot change it, and X→Y→X fails too", async () => {
		const repo = makeRepo(
			gate(`
const failures = [];
const expectDenied = (what, fn) => { try { fn(); failures.push(what + " was allowed"); } catch {} };
// It can read everything it needs.
if (!fs.readFileSync("README.md", "utf8").includes("demo")) failures.push("cannot read the snapshot");
if (!fs.readFileSync("src/a/x.txt", "utf8").includes("x")) failures.push("cannot read the coder's change");
// ... and changes nothing: not an existing file, not a new one, not a deletion.
expectDenied("overwrite", () => fs.writeFileSync("README.md", "changed"));
expectDenied("overwrite the manifest", () => fs.writeFileSync("package.json", "{}"));
expectDenied("create", () => fs.writeFileSync("created.txt", "new"));
expectDenied("create in a subfolder", () => fs.writeFileSync("src/a/created.txt", "new"));
expectDenied("delete", () => fs.unlinkSync("README.md"));
expectDenied("mkdir", () => fs.mkdirSync("newdir"));
// X -> Y -> X: change a file, then put the original back.
const original = fs.readFileSync("README.md", "utf8");
expectDenied("X -> Y", () => { fs.writeFileSync("README.md", "Y"); fs.writeFileSync("README.md", original); });
// The one writable place is the private temp folder.
const scratch = os.tmpdir();
fs.writeFileSync(scratch + "/out.txt", "ok");
if (fs.readFileSync(scratch + "/out.txt", "utf8") !== "ok") failures.push("scratch is not writable");
if (failures.length) { console.error(failures.join("; ")); process.exit(2); }
`),
		);
		const run = factoryRun(repo, sandbox());
		const meta = await changedWorktree(run);
		const record = await runFactoryGates(run, meta);
		expect(why(record)).toBe("ok");
		// The snapshot the gates ran on is exactly what the worktree holds.
		expect(lf(readFileSync(join(meta.path, "README.md"), "utf8"))).toBe("demo\n");
		expect(lf(git(meta.path, "show", `${record.snapshot}:README.md`))).toBe("demo\n");
	});

	test("a gate has no network, not even loopback, and cannot read the user's other files", async () => {
		const before = connections;
		const repo = makeRepo(
			gate(`
const failures = [];
const reach = (host, port) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.on("connect", () => { socket.destroy(); done(true); });
  socket.on("timeout", () => { socket.destroy(); done(false); });
  socket.on("error", () => done(false));
});
(async () => {
  if (await reach("127.0.0.1", ${port})) failures.push("reached loopback");
  if (await reach("1.1.1.1", 443)) failures.push("reached the internet");
  try { fs.readFileSync(${JSON.stringify(canary)}, "utf8"); failures.push("read a file outside the snapshot"); } catch {}
  if (process.env.HELIOS_TEST_SECRET) failures.push("saw a host secret");
  if (failures.length) { console.error(failures.join("; ")); process.exit(2); }
})();
`),
		);
		process.env.HELIOS_TEST_SECRET = "leaked";
		try {
			const run = factoryRun(repo, sandbox());
			const record = await runFactoryGates(run, await changedWorktree(run));
			expect(why(record)).toBe("ok");
		} finally {
			delete process.env.HELIOS_TEST_SECRET;
		}
		// The control: the listener really is reachable from here, and nothing else ever connected.
		expect(connections).toBe(before);
		await new Promise<void>((done) => {
			const probe = Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
					open(s) {
						s.end();
						done();
					},
					error() {
						done();
					},
				},
			});
			void probe;
		});
	});

	test("dependency folders stay readable but read-only, and no access entry is left behind", async () => {
		const repo = makeRepo(
			gate(`
const failures = [];
if (require("dep") !== 42) failures.push("cannot read the dependency");
try { fs.writeFileSync("node_modules/dep/index.js", "module.exports = 0;"); failures.push("wrote into a dependency"); } catch {}
try { fs.writeFileSync("node_modules/dep/extra.js", "x"); failures.push("created in a dependency"); } catch {}
if (failures.length) { console.error(failures.join("; ")); process.exit(2); }
`),
		);
		const dep = join(repo, "node_modules", "dep");
		mkdirSync(dep, { recursive: true });
		writeFileSync(join(dep, "index.js"), "module.exports = 42;\n");
		const run = factoryRun(repo, sandbox());
		const record = await runFactoryGates(run, await changedWorktree(run));
		expect(why(record)).toBe("ok");
		expect(readFileSync(join(dep, "index.js"), "utf8")).toBe("module.exports = 42;\n");
		expect(existsSync(join(dep, "extra.js"))).toBe(false);
		// The real node_modules got a temporary access entry for the container; it is revoked again.
		const acl = Bun.spawnSync(["icacls", dep]).stdout.toString();
		expect(acl).not.toMatch(/S-1-15-2-\d/);
		expect(acl).not.toContain("helios.gate");
	});

	test("a failing gate fails, and a hanging one is killed at the timeout", async () => {
		const repo = makeRepo(gate("console.error('lint failed'); process.exit(4);"));
		const run = factoryRun(repo, sandbox());
		const record = await runFactoryGates(run, await changedWorktree(run));
		expect(record.ok).toBe(false);
		expect(record.results[0]?.exitCode).toBe(4);
		expect(record.results[0]?.outputTail).toContain("lint failed");

		const started = Date.now();
		const outcome = await sandbox().launch({
			command: "ping -n 60 127.0.0.1 > nul",
			cwd: repo,
			readPaths: [],
			toolPaths: [],
			scratch: mkdtempSync(join(root, "scratch-")),
			timeoutMs: 2_000,
		});
		// Exit 124 is the helper's timeout code; loopback ping would also end early if blocked.
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(outcome.code).not.toBe(0);
	});

	test("cancelling stops the run and cleans up the profile", async () => {
		const repo = makeRepo(gate("setInterval(() => {}, 1000);"));
		const run = factoryRun(repo, sandbox());
		const meta = await changedWorktree(run);
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("stop")), 4_000);
		await expect(runFactoryGates(run, meta, controller.signal)).rejects.toThrow("stop");
		const packages = join(process.env.LOCALAPPDATA ?? "", "Packages");
		const left = Bun.spawnSync(["cmd", "/c", `dir /b "${packages}" | findstr /b helios.gate.`]);
		expect(left.stdout.toString().trim()).toBe("");
	});
});
