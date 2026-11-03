import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, minify: true, sourcemap: true, format: 'esm', target: ['chrome110'], outfile: 'dist/player.js', logLevel: 'warning' });
await copyFile('public/index.html', 'dist/index.html');
await copyFile('public/player.css', 'dist/player.css');
console.log('player built -> apps/player/dist');
