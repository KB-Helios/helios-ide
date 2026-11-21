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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	bubblewrapSandbox,
	type GateSandbox,
	type SandboxAvailability,
	type SandboxRequest,
	seatbeltSandbox,
	toolchainFolders,
} from "./sandbox";

/**
 * The real Linux (bubblewrap) and macOS (`sandbox-exec`) gate sandboxes: commands are actually run inside them.
 * `sandbox.test.ts` only checks the generated arguments of these two; this file is what proves the OS enforces
 * them. The Windows helper has its own real-execution suite in `sandbox.test.ts`.
 *
 * The suite runs only where the platform's sandbox works. A developer machine without `bwrap` skips it, with the
 * reason in the suite's name. CI sets `THINKRAIL_REQUIRE_GATE_SANDBOX=1`, which turns "not available here" into a
 * failure, so a runner that silently loses its sandbox cannot leave the boundary untested.
 */

const REQUIRE_ENV = "THINKRAIL_REQUIRE_GATE_SANDBOX";
const required = process.env[REQUIRE_ENV] === "1";

function nativeSandbox(): GateSandbox | undefined {
	if (process.platform === "linux") return bubblewrapSandbox();
	if (process.platform === "darwin") return seatbeltSandbox();
	return undefined;
}

const sandbox = nativeSandbox();
const availability: SandboxAvailability = sandbox
	? await sandbox.availability()
	: {
			ok: false,
			reason: `no bubblewrap/sandbox-exec sandbox exists on ${process.platform} (Windows is covered by sandbox.test.ts)`,
		};

if (!availability.ok && required && sandbox) {
	// CI asked for the real thing: report it as a failure rather than a quiet skip.
	test(`${REQUIRE_ENV}=1 but the ${sandbox.kind} gate sandbox is unavailable`, () => {
		throw new Error(
			`${REQUIRE_ENV}=1 requires a working gate sandbox, but: ${availability.ok ? "" : availability.reason}`,
		);
	});
}

const native = sandbox && availability.ok ? describe : describe.skip;
const suiteName = `native gate sandbox (${sandbox?.kind ?? process.platform}${
	availability.ok ? "" : `; skipped: ${availability.reason}`
})`;

/** Single-quotes a value for `sh`. */
function sh(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

const real = (path: string) => realpathSync(path);

native(suiteName, () => {
	const root = real(mkdtempSync(join(tmpdir(), "trnative-")));
	const checkout = join(root, "checkout");
	const dep = join(root, "deps", "node_modules");
	const scratchBase = join(root, "scratch");
	const secretName = "THINKRAIL_NATIVE_TEST_SECRET";
	// A file in the user's profile, outside every grant.
	let homeCanary: string | undefined;
	const homeCanaryText = "the user's private file";
	let listener: Server;
	let port = 0;
	let connections = 0;

	beforeAll(async () => {
		mkdirSync(join(checkout, "src"), { recursive: true });
		mkdirSync(dep, { recursive: true });
		mkdirSync(scratchBase, { recursive: true });
		writeFileSync(join(checkout, "README.md"), "demo\n");
		writeFileSync(join(checkout, "src", "a.txt"), "a\n");
		writeFileSync(join(dep, "index.js"), "module.exports = 42;\n");
		writeFileSync(
			join(checkout, "net.js"),
			`const net = require("net"); const dns = require("dns");
const reach = (host, port) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.on("connect", () => { socket.destroy(); done(true); });
  socket.on("timeout", () => { socket.destroy(); done(false); });
  socket.on("error", () => done(false));
});
(async () => {
  console.log((await reach("127.0.0.1", Number(process.argv[2]))) ? "REACHED_LOOPBACK" : "BLOCKED_LOOPBACK");
  console.log((await reach("1.1.1.1", 53)) ? "REACHED_INTERNET" : "BLOCKED_INTERNET");
  const resolved = await new Promise((done) => dns.lookup("example.com", (error) => done(!error)));
  console.log(resolved ? "RESOLVED_HOST" : "BLOCKED_DNS");
})();
`,
		);
		const canaryDir = mkdtempSync(join(homedir(), ".thinkrail-native-sandbox-"));
		homeCanary = join(canaryDir, "secret.txt");
		writeFileSync(homeCanary, homeCanaryText);
		listener = createServer((socket) => {
			connections++;
			socket.end("hi");
		});
		await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
		port = (listener.address() as { port: number }).port;
	});

	afterAll(() => {
		listener?.close();
		rmSync(root, { recursive: true, force: true });
		if (homeCanary) rmSync(dirname(homeCanary), { recursive: true, force: true });
	});

	/** Runs `command` in the sandbox the way a gate would, in a fresh scratch directory. */
	async function launch(command: string, scratchName: string) {
		const scratch = join(scratchBase, scratchName);
		mkdirSync(scratch, { recursive: true });
		const request: SandboxRequest = {
			command,
			cwd: checkout,
			readPaths: [dep],
			toolPaths: toolchainFolders([process.execPath], process.env).map(real),
			scratch,
			timeoutMs: 60_000,
		};
		const result = await sandbox?.launch(request);
		if (!result) throw new Error("no sandbox");
		return { ...result, scratch };
	}

	test("a command runs inside the sandbox and its exit code and output come back", async () => {
		process.env[secretName] = "leaked";
		try {
			const result = await launch(
				`echo out-line; echo err-line >&2; echo "secret=\${${secretName}:-none}"; echo "home=$HOME"; exit 7`,
				"run",
			);
			expect(result.code).toBe(7);
			expect(result.stdout).toContain("out-line");
			expect(result.stderr).toContain("err-line");
			// The environment is an allowlist: no host secret, and home is the private scratch directory.
			expect(result.stdout).toContain("secret=none");
			expect(result.stdout).toContain(`home=${result.scratch}`);
		} finally {
			delete process.env[secretName];
		}
		expect((await launch("exit 0", "ok")).code).toBe(0);
	});

	test("the snapshot checkout is readable and nothing in it can be written, created or deleted", async () => {
		const result = await launch(
			[
				"cat README.md src/a.txt",
				"(echo changed > README.md) 2>/dev/null && echo WROTE_README",
				"(echo changed > src/a.txt) 2>/dev/null && echo WROTE_SUBFOLDER_FILE",
				"(echo new > created.txt) 2>/dev/null && echo CREATED_FILE",
				"(echo new > src/created.txt) 2>/dev/null && echo CREATED_IN_SUBFOLDER",
				"(mkdir newdir) 2>/dev/null && echo CREATED_DIR",
				"(rm README.md) 2>/dev/null && echo DELETED_FILE",
				"(mv README.md moved.md) 2>/dev/null && echo RENAMED_FILE",
				"(echo Y > README.md; echo demo > README.md) 2>/dev/null && echo X_Y_X",
				"echo done",
			].join("\n"),
			"checkout",
		);
		expect(result.stdout).toContain("demo");
		expect(result.stdout).toContain("done");
		expect(result.stdout).not.toMatch(/WROTE_|CREATED_|DELETED_|RENAMED_|X_Y_X/);
		// And the real files are exactly as they were.
		expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("demo\n");
		expect(readFileSync(join(checkout, "src", "a.txt"), "utf8")).toBe("a\n");
		expect(existsSync(join(checkout, "created.txt"))).toBe(false);
		expect(existsSync(join(checkout, "newdir"))).toBe(false);
	});

	test("dependency folders are readable and never writable", async () => {
		const result = await launch(
			[
				`cat ${sh(join(dep, "index.js"))}`,
				`(echo 'module.exports = 0;' > ${sh(join(dep, "index.js"))}) 2>/dev/null && echo WROTE_DEP`,
				`(echo x > ${sh(join(dep, "extra.js"))}) 2>/dev/null && echo CREATED_IN_DEP`,
				`(rm ${sh(join(dep, "index.js"))}) 2>/dev/null && echo DELETED_DEP`,
				"echo done",
			].join("\n"),
			"deps",
		);
		expect(result.stdout).toContain("module.exports = 42;");
		expect(result.stdout).toContain("done");
		expect(result.stdout).not.toMatch(/WROTE_DEP|CREATED_IN_DEP|DELETED_DEP/);
		expect(readFileSync(join(dep, "index.js"), "utf8")).toBe("module.exports = 42;\n");
		expect(existsSync(join(dep, "extra.js"))).toBe(false);
	});

	test("the private scratch directory is writable, and is also the temp and home directory", async () => {
		const result = await launch(
			[
				'echo scratch-ok > "$TMPDIR/out.txt" && cat "$TMPDIR/out.txt"',
				'mkdir "$TMPDIR/sub" && echo scratch-mkdir-ok',
				'echo home-ok > "$HOME/h.txt" && cat "$HOME/h.txt"',
			].join("\n"),
			"scratch",
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("scratch-ok");
		expect(result.stdout).toContain("scratch-mkdir-ok");
		expect(result.stdout).toContain("home-ok");
		// What was written there is really the host's scratch directory.
		expect(readFileSync(join(result.scratch, "out.txt"), "utf8")).toBe("scratch-ok\n");
	});

	test("there is no network: not loopback, not the internet, not name resolution", async () => {
		const before = connections;
		const result = await launch(`${sh(process.execPath)} net.js ${port}`, "net");
		// bun must have started: otherwise nothing here would prove anything.
		expect(result.stdout, result.stderr).toContain("BLOCKED_LOOPBACK");
		expect(result.stdout).toContain("BLOCKED_INTERNET");
		expect(result.stdout).toContain("BLOCKED_DNS");
		expect(result.stdout).not.toMatch(/REACHED_|RESOLVED_/);
		expect(connections).toBe(before);
		// The control: the listener really is reachable outside the sandbox.
		await new Promise<void>((done, fail) => {
			Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
					open(s) {
						s.end();
						done();
					},
					error: fail,
				},
			}).catch(fail);
		});
	});

	test("a file in the user's home outside the allowed paths is unreadable", async () => {
		if (!homeCanary) throw new Error("no canary");
		// The control: readable here, so an unreadable result below is the sandbox's doing.
		expect(readFileSync(homeCanary, "utf8")).toBe(homeCanaryText);
		const result = await launch(
			[
				`cat ${sh(homeCanary)} && echo READ_HOME_FILE`,
				`ls ${sh(dirname(homeCanary))} >/dev/null 2>&1 && echo LISTED_HOME_FOLDER`,
				"echo done",
			].join("\n"),
			"home",
		);
		expect(result.stdout).toContain("done");
		expect(result.stdout).not.toContain(homeCanaryText);
		expect(result.stdout).not.toMatch(/READ_HOME_FILE|LISTED_HOME_FOLDER/);
	});
});
