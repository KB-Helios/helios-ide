// Bun's `with { type: "file" }` import of the QuickJS wasm evaluates to a readable path.
declare module "quickjs-wasi/quickjs.wasm" {
	const path: string;
	export default path;
}
