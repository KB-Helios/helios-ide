// The codemode sandbox runtime for the compiled host (CLI binary and desktop sidecar).
//
// pi's codemode tool runs each script in a QuickJS VM (quickjs-wasi's wasm) inside a worker
// thread. From source both are found on disk next to the installed packages. A `bun build
// --compile` binary has neither on disk, so the compiled entries:
//  - embed the wasm through this module's file import (Bun evaluates it to a readable path inside
//    the executable) and hand it to pi with `setEmbeddedQuickJSWasmPath` (patched onto pi's
//    barrel; it is the seam pi's own Bun entry uses), and
//  - build `<app>/src/extensions/codemode/worker.ts` (which imports ./worker.ts here) as an extra
//    entrypoint, the embedded path pi's `getCodemodeWorkerSpecifier()` names in a Bun binary.
import { setEmbeddedQuickJSWasmPath } from "@earendil-works/pi-coding-agent";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

let configured = false;

/** Point pi's codemode at the QuickJS wasm embedded in this executable. Idempotent. */
export function configureEmbeddedCodemodeRuntime(): void {
	if (configured) return;
	configured = true;
	setEmbeddedQuickJSWasmPath(quickjsWasmPath);
}
