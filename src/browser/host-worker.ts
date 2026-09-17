/**
 * The one place the host's Web Worker is constructed.
 *
 * The core runs as Rust/WASM inside `@parity/truapi-host/worker-runtime`, and
 * both the worker chunk and the `.wasm` beside it have to be emitted by the
 * build and served next to the page. That is a build concern, not a runtime
 * one, so it lives behind this single named function: the bundler only ever
 * has to recognise one `new Worker(new URL(...), { type: 'module' })` site.
 *
 * The URL is deliberately a relative *output* path, not the package specifier:
 * esbuild does not bundle `new Worker(new URL(...))`, it emits the URL verbatim,
 * so a specifier would reach the browser as a path no server serves. `build.mjs`
 * makes `@parity/truapi-host/worker-runtime` a second entry point named
 * `worker-runtime.js` in the same directory as this chunk, and `import.meta.url`
 * — this chunk's own URL at runtime — is what makes `./` point at it.
 */

/** Start the TrUAPI core worker. */
export function createHostWorker(): Worker {
  return new Worker(new URL('./worker-runtime.js', import.meta.url), {
    type: 'module',
  });
}
