import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ bundle: true, minify: true, target: ['chrome110', 'safari16', 'firefox115'], logLevel: 'warning', entryPoints: ['src/main.ts'], sourcemap: true, format: 'esm', outfile: 'dist/portal.js' });
for (const f of ['index.html', 'portal.css']) await copyFile(`public/${f}`, `dist/${f}`);
console.log('portal built -> apps/portal/dist');
