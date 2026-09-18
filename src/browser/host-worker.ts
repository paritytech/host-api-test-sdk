/**
 * The one `new Worker(new URL(...))` site, so the bundler has one thing to
 * recognise. The URL must be a relative OUTPUT path, not the package specifier:
 * esbuild emits it verbatim, so a specifier would reach the browser as a path
 * no server serves. `build.mjs` emits `worker-runtime.js` beside this chunk.
 */

export function createHostWorker(): Worker {
  return new Worker(new URL('./worker-runtime.js', import.meta.url), {
    type: 'module',
  });
}
