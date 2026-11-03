import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const common = { bundle: true, minify: true, target: ['chrome110', 'safari16'], logLevel: 'warning' };
await build({ ...common, entryPoints: ['src/main.ts'], sourcemap: true, format: 'esm', outfile: 'dist/rider.js' });
await build({ ...common, entryPoints: ['src/sw.ts'], format: 'iife', outfile: 'dist/sw.js' });
for (const f of ['index.html', 'rider.css', 'manifest.webmanifest', 'icon.svg']) await copyFile(`public/${f}`, `dist/${f}`);
console.log('rider app built -> apps/rider/dist');
