/**
 * Builds the Electron main + preload bundles with esbuild.
 *
 * Raw `tsc` fights this package's `"type": "module"` + workspace `exports` +
 * Electron's preload module-format rules; esbuild sidesteps all of it: it emits
 * `.mjs` (ESM, the format Electron 42 loads for both main and an `.mjs` preload),
 * bundles only our own source, and keeps every node_modules package external so
 * the heavy runtime tree is resolved by Node at launch rather than inlined.
 */
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['src/main/main.ts'], outfile: 'dist/electron/main.mjs' });
await build({
  ...shared,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/electron/preload.mjs',
});
