import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ASSET_DIR = 'dist/host';

// Content-hashed chunks, and esbuild does not clean its outdir: stale chunks
// would otherwise be shipped by `pnpm pack`.
rmSync(HOST_ASSET_DIR, { recursive: true, force: true });
mkdirSync(HOST_ASSET_DIR, { recursive: true });

/** Resolve a published file through its package's `exports` map. */
function resolveExport(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/**
 * The core build the host runs: the `testing` bundle, built with `test-host`,
 * which carries the switches a test host needs (`setSubmitPreimagesLocally`)
 * and the production `web` bundle leaves out.
 */
const CORE_WASM_ENTRY = '@parity/truapi-host/wasm/testing';

/** The core's wasm-pack output: its glue, payload, snippets and `verifiable`. */
const CORE_WASM_DIR = dirname(resolveExport(CORE_WASM_ENTRY));

/**
 * The core loads `verifiable` (ring-VRF and its powers of tau) on demand,
 * through a wasm-bindgen snippet that fetches `../../truapi_verifiable*` against
 * its own `import.meta.url` — a path that assumes the snippet still sits two
 * directories below the glue. Inlined into a chunk in `dist/host/`, it would
 * climb out of the asset directory, and find the files only because
 * `server.ts` serves that directory at the origin root, where URL resolution
 * stops at `/`. So the snippet stays its own module, copied below with its
 * directory, and resolves by the layout the core was built for rather than by
 * where the host happens to be mounted.
 */
const keepCoreSnippetsExternal = {
  name: 'keep-core-snippets-external',
  setup(build) {
    build.onResolve({ filter: /^\.\/snippets\// }, (args) =>
      args.importer.startsWith(CORE_WASM_DIR + sep) ? { path: args.path, external: true } : undefined,
    );
  },
};

/**
 * The worker runtime imports the production glue, `./wasm/web/truapi_server.js`.
 * Point that one import at the testing bundle's glue instead, so the worker
 * runs the core this host is built around.
 */
const useTestingCore = {
  name: 'use-testing-core',
  setup(build) {
    build.onResolve({ filter: /^\.\/wasm\/web\/truapi_server\.js$/ }, () => ({
      path: resolveExport(CORE_WASM_ENTRY),
    }));
  },
};

/**
 * esbuild passes `new Worker(new URL(...))` through verbatim rather than
 * bundling the target, so the worker is its own entry point. Naming the entries
 * with an object pins the output basenames despite the two source roots being
 * far apart, which is what lets `host-worker.ts` name `./worker-runtime.js`
 * relative to its own `import.meta.url`.
 */
const browserResult = await build({
  entryPoints: {
    'host-runtime': 'src/browser/host-runtime.ts',
    'worker-runtime': resolveExport('@parity/truapi-host/worker-runtime'),
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  outdir: HOST_ASSET_DIR,
  minify: true,
  sourcemap: false,
  metafile: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  conditions: ['browser'],
  plugins: [useTestingCore, keepCoreSnippetsExternal],
});

console.log(`Browser bundles built into ${HOST_ASSET_DIR}/`);

/**
 * Copy each wasm payload next to the chunk that asks for it.
 *
 * Both wasm-pack glues resolve their payload with
 * `new URL('<name>_bg.wasm', import.meta.url)`, which esbuild leaves verbatim —
 * so the `.wasm` must sit in the directory the glue chunk lands in. The
 * assertion fails the build if one ever moves, rather than shipping a green
 * build whose page 404s on its wasm at runtime.
 *
 * `pkgEntry` only locates the payload's directory: the `.wasm` is not always in
 * the package's `exports` map, so resolve the glue and take the sibling.
 */
for (const { pkgEntry, glue, wasmName } of [
  {
    pkgEntry: CORE_WASM_ENTRY,
    glue: '/wasm/testing/truapi_server.js',
    wasmName: 'truapi_server_bg.wasm',
  },
  {
    pkgEntry: '@parity/truapi-provider',
    glue: '/@parity/truapi-provider/dist/truapi_provider.js',
    wasmName: 'truapi_provider_bg.wasm',
  },
]) {
  const glueChunks = Object.entries(browserResult.metafile.outputs)
    .filter(([, out]) => Object.keys(out.inputs).some((i) => i.endsWith(glue)))
    .map(([file]) => file);

  if (glueChunks.length !== 1 || dirname(glueChunks[0]) !== HOST_ASSET_DIR) {
    throw new Error(
      `expected exactly one ${wasmName} glue chunk directly in ${HOST_ASSET_DIR}/, got: ${glueChunks.join(', ') || '(none)'}`,
    );
  }

  const from = join(dirname(resolveExport(pkgEntry)), wasmName);
  copyFileSync(from, join(HOST_ASSET_DIR, wasmName));
  console.log(`WASM payload copied: ${HOST_ASSET_DIR}/${wasmName} (glue: ${glueChunks[0]})`);
}

/**
 * Copy the core's snippets and everything they fetch, then prove each lands
 * where it will be looked for.
 *
 * The snippets are external, so the chunk importing them must sit directly in
 * `dist/host/` for its `./snippets/...` specifier to resolve, and every
 * `new URL('<path>', import.meta.url)` inside a snippet must name a file that
 * exists relative to that snippet. A rename upstream fails the build here
 * rather than as a 404 the first time a product asks for a ring-VRF proof.
 */
{
  if (!existsSync(join(CORE_WASM_DIR, 'snippets'))) {
    throw new Error(`expected the core's wasm-bindgen snippets in ${CORE_WASM_DIR}/snippets; found none`);
  }
  cpSync(join(CORE_WASM_DIR, 'snippets'), join(HOST_ASSET_DIR, 'snippets'), { recursive: true });
  for (const name of readdirSync(CORE_WASM_DIR)) {
    if (name.startsWith('truapi_verifiable')) {
      copyFileSync(join(CORE_WASM_DIR, name), join(HOST_ASSET_DIR, name));
    }
  }

  const importers = Object.entries(browserResult.metafile.outputs).flatMap(([file, out]) =>
    out.imports.filter((i) => i.external && i.path.startsWith('./snippets/')).map((i) => [file, i.path]),
  );
  if (importers.length === 0) {
    throw new Error('expected the core glue to import its wasm-bindgen snippets; found none');
  }
  let checked = 0;
  for (const [file, specifier] of importers) {
    if (dirname(file) !== HOST_ASSET_DIR) {
      throw new Error(`${file} imports ${specifier} but is not directly in ${HOST_ASSET_DIR}/`);
    }
    const snippet = posix.join(HOST_ASSET_DIR, specifier);
    if (!existsSync(snippet)) throw new Error(`${file} imports ${specifier}, which was not copied`);
    for (const [, fetched] of readFileSync(snippet, 'utf8').matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)) {
      const target = posix.join(dirname(snippet), fetched);
      if (!target.startsWith(`${HOST_ASSET_DIR}/`) || !existsSync(target)) {
        throw new Error(`${snippet} fetches ${fetched}, which does not resolve inside ${HOST_ASSET_DIR}/ (${target})`);
      }
      checked += 1;
    }
  }
  // The pattern only sees a quoted literal. A snippet that builds its URL any
  // other way would leave this guard checking nothing, so that is an error too.
  if (checked === 0) {
    throw new Error(
      "found no `new URL('<path>', import.meta.url)` in the core's snippets; " +
        'the layout check above checked nothing. Update the pattern to how they build their URLs.',
    );
  }
  console.log(
    `Core snippets copied for: ${[...new Set(importers.map(([file]) => file))].join(', ')} ` +
      `(${checked} fetched URL${checked === 1 ? '' : 's'} checked)`,
  );
}

// Both bundles live in dist/ so `server.ts`'s `import.meta.url` resolves
// dist/host/ the same way it does from the ESM build's dist/server.js.
const cjsShared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: false,
  external: ['@playwright/test'],
  // `server.ts` locates dist/host/ through `import.meta.url`, which CJS lacks.
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__import_meta_url',
  },
};

await Promise.all([
  build({
    ...cjsShared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.cjs',
  }),
  build({
    ...cjsShared,
    entryPoints: ['src/playwright/index.ts'],
    outfile: 'dist/playwright.cjs',
  }),
]);

console.log('CJS bundles built: dist/index.cjs, dist/playwright.cjs');

/**
 * Drift guard for the published wire-schema hash.
 *
 * The core ships as a vendored `.wasm`, so the `@parity/truapi` version in
 * `package.json` says what the JS codecs were built against, not what the
 * binary speaks. Consumers need the latter to answer "can my product talk to
 * this host?", so the value is published — and a bump that changes the core
 * without changing the constant would publish a lie.
 */
{
  const wasm = await import(CORE_WASM_ENTRY);
  await wasm.default({
    module_or_path: await readFile(join(CORE_WASM_DIR, 'truapi_server_bg.wasm')),
  });
  const actual = wasm.wireSchemaHash();
  const source = await readFile(new URL('src/types.ts', import.meta.url), 'utf8');
  const declared = /TRUAPI_WIRE_SCHEMA_HASH = '([^']+)'/.exec(source)?.[1];
  if (declared !== actual) {
    throw new Error(
      `TRUAPI_WIRE_SCHEMA_HASH is ${declared ?? 'missing'}, but the bundled core speaks ${actual}. ` +
        'Update the constant in src/types.ts and say so in the CHANGELOG.',
    );
  }
  console.log(`Wire schema hash verified: ${actual}`);
}
