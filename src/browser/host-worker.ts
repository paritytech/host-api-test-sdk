/**
 * The one place the host's Web Worker is constructed.
 *
 * The core runs as Rust/WASM inside `@parity/truapi-host/worker-runtime`, and
 * both the worker chunk and the `.wasm` beside it have to be emitted by the
 * build and served next to the page. That is a build concern, not a runtime
 * one, so it lives behind this single named function: the bundler only ever
 * has to recognise one `new Worker(new URL(...), { type: 'module' })` site.
 */

/** Start the TrUAPI core worker. */
export function createHostWorker(): Worker {
  return new Worker(new URL('@parity/truapi-host/worker-runtime', import.meta.url), {
    type: 'module',
  });
}
