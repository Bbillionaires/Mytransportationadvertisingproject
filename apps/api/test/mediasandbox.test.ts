import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SANDBOX_LIMITS, sandboxed } from '../src/modules/media/process.js';

const run = promisify(execFile);
const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

describe('ffmpeg sandbox (R-023)', () => {
  it('ffprobe/ffmpeg may open local files only: no request ever reaches a network address', async () => {
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.end('x'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/latest/meta-data/iam`;
    const dir = mkdtempSync(path.join(tmpdir(), 'rmn-sbx-'));
    const playlist = path.join(dir, 'evil.m3u8');
    writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}\n#EXT-X-ENDLIST\n`);
    try {
      // Control: without the sandbox, ffprobe given a network input does fetch it — so this test can detect a regression.
      await quiet(run('ffprobe', ['-v', 'error', url], { timeout: 20_000 }));
      expect(hits).toBe(1);
      hits = 0;
      for (const input of [url, playlist]) {
        const [cmd, args] = sandboxed('ffprobe', ['-v', 'error', '-show_format', input]);
        await expect(run(cmd, args, { timeout: 20_000 })).rejects.toThrow();
      }
      expect(hits).toBe(0);
    } finally { server.close(); }
  });

  it('runs ffmpeg/ffprobe under kernel resource limits and without stdin', async () => {
    const [cmd, args] = sandboxed('ffmpeg', ['-i', 'in.mp4', 'out.mp4']);
    expect(args).toContain('-nostdin');
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file']);
    if (cmd.endsWith('prlimit')) {
      expect(args).toEqual(expect.arrayContaining([`--as=${SANDBOX_LIMITS.addressSpaceBytes}`, `--cpu=${SANDBOX_LIMITS.cpuSeconds}`, '--core=0', '--', 'ffmpeg']));
      // The wrapped command really runs (prlimit is present and accepts these limits).
      const [c2, a2] = sandboxed('ffprobe', ['-version']);
      const { stdout } = await run(c2, a2);
      expect(stdout).toMatch(/ffprobe version/);
    }
  });
});
