import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClip, computeTrimStartSec, contiguousTail, pickSegments, sanitizeSegments } from '../src/clipper/clipBuilder.js';

// Cria N arquivos com mtimes espaçados de stepSec (mais novo por último)
function makeSegments(dir: string, n: number, stepMs: number, newestMs: number): string[] {
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `seg_${String(i).padStart(3, '0')}.mp4`);
    fs.writeFileSync(f, 'x'.repeat(1000));
    const mtime = new Date(newestMs - (n - 1 - i) * stepMs);
    fs.utimesSync(f, mtime, mtime);
    files.push(f);
  }
  return files;
}

describe('pickSegments', () => {
  it('sem aceStartMs: últimos N por pre+post', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const segs = makeSegments(dir, 18, 10_000, Date.now());
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
      });
      expect(picked).toHaveLength(9); // ceil(75/10)+1
      expect(picked[picked.length - 1]).toBe(segs[segs.length - 1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('com aceStartMs: corta 10s antes do 1º kill', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 18, 10_000, now);
      // 1º kill aconteceu no instante do segmento 12 (0-indexed)
      const firstKillMs = now - (18 - 1 - 12) * 10_000;
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        contextSec: 10,
        aceStartMs: firstKillMs,
      });
      // cutFrom = seg12 - 10s = fim do seg11 → pega do seg11 em diante (7 segs)
      expect(picked[0]).toBe(segs[11]);
      expect(picked).toHaveLength(7);
      expect(picked[picked.length - 1]).toBe(segs[17]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ace mais velho que o buffer: usa tudo + avisa no tamanho', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const segs = makeSegments(dir, 5, 10_000, Date.now());
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        aceStartMs: Date.now() - 3_600_000,
      });
      expect(picked).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lista vazia retorna vazio', () => {
    expect(
      pickSegments([], { segmentTimeSec: 10, preRollSec: 60, postRollSec: 15 }),
    ).toEqual([]);
  });
});

describe('contiguousTail', () => {
  function mkTimes(dir: string, spec: Array<{ name: string; atSec: number }>): string[] {
    const files: string[] = [];
    for (const s of spec) {
      const f = path.join(dir, s.name);
      fs.writeFileSync(f, 'x');
      const d = new Date(1_000_000 + s.atSec * 1000);
      fs.utimesSync(f, d, d);
      files.push(f);
    }
    return files;
  }

  it('REGRESSÃO r23: intercalação de fantasma (005 furando) vira cauda contígua', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    try {
      // sidecar real do 2399459_Ancient_r23_Reix: 005 antigo no meio dos novos
      const files = mkTimes(dir, [
        { name: 'seg_005.ts', atSec: 10 },
        { name: 'seg_016.ts', atSec: 120 },
        { name: 'seg_017.ts', atSec: 130 },
        { name: 'seg_000.ts', atSec: 140 },
        { name: 'seg_001.ts', atSec: 150 },
        { name: 'seg_002.ts', atSec: 160 },
        { name: 'seg_003.ts', atSec: 170 },
      ]);
      const r = contiguousTail(files, 25);
      expect(r.ok.map((f) => path.basename(f))).toEqual([
        'seg_016.ts', 'seg_017.ts', 'seg_000.ts', 'seg_001.ts', 'seg_002.ts', 'seg_003.ts',
      ]);
      expect(r.dropped.map((f) => path.basename(f))).toEqual(['seg_005.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buffer saudável (gaps ~10s) mantém tudo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail2-'));
    try {
      const files = mkTimes(dir, [
        { name: 'seg_a.ts', atSec: 0 },
        { name: 'seg_b.ts', atSec: 10 },
        { name: 'seg_c.ts', atSec: 20.5 },
        { name: 'seg_d.ts', atSec: 30 },
      ]);
      const r = contiguousTail(files, 25);
      expect(r.ok).toHaveLength(4);
      expect(r.dropped).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lista vazia/1 arquivo passa direto', () => {
    expect(contiguousTail([], 25).ok).toEqual([]);
    expect(contiguousTail(['x.ts'], 25).ok).toEqual(['x.ts']);
  });
});

describe('computeTrimStartSec', () => {
  const SEG_MS = 10_000;
  it('sem âncora não trimma', () => {
    expect(computeTrimStartSec(110_000, 10, undefined, 10)).toBe(0);
  });
  it('converte folga atômica em começo exato (âncora − contexto)', () => {
    // segmento 1: 100s→110s; kill ancorado em 115s, ctx 10s → desejado 105s
    expect(computeTrimStartSec(110_000, 10, 115_000, 10)).toBe(5);
    // kill em 118s → desejado 108s → trim 8s
    expect(computeTrimStartSec(110_000, 10, 118_000, 10)).toBe(8);
  });
  it('âncora antes do material: clamp em 0 (não corta conteúdo)', () => {
    expect(computeTrimStartSec(110_000, 10, 95_000, 10)).toBe(0);
  });
});

describe('buildClip (passada única: emenda A/V realinhada)', () => {
  // ffmpeg pelo nome (isSegmentReadable/render): .tools no PATH
  process.env.PATH = `${path.resolve('.tools')}${path.delimiter}${process.env.PATH ?? ''}`;
  const FF = path.resolve('.tools/ffmpeg.exe');

  it(
    'produz mp4 com vídeo+áudio a partir de segmentos TS',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildclip-'));
      const clipsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
      try {
        // 4 segmentos TS de 2s (sanitize descarta o mais novo; 3 ficam).
        // -output_ts_offset 3600: PTS ABSOLUTOS (offset de 1h) como no
        // broadcast ao vivo — o render precisa re-ancorar sem estourar.
        const segs: string[] = [];
        for (let i = 0; i < 4; i++) {
          const f = path.join(dir, `seg_${String(i).padStart(3, '0')}.ts`);
          execFileSync(FF, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
            '-muxdelay', '0', '-output_ts_offset', '3600',
            '-f', 'mpegts', f,
          ]);
          segs.push(f);
        }
        const ace = {
          matchId: 'bb', map: 'Cache', round: 3, player: 'x',
          team1: 'A', team2: 'B', event: 'E',
          detectedAt: new Date().toISOString(),
          kills: [1, 2, 3].map((i) => ({ killer: 'x', victim: `v${i}`, round: 3, map: 'Cache' })),
        };
        const out = await buildClip(ace, segs, {
          bufferDir: dir,
          clipsDir,
          preRollSec: 60,
          postRollSec: 15,
          segmentTimeSec: 10,
          upscaleHeight: 0,
        });
        expect(fs.existsSync(out.filePath)).toBe(true);
        // saída precisa ter vídeo E áudio (emenda realinhada)
        let err = '';
        try {
          execFileSync(FF, ['-hide_banner', '-i', out.filePath]);
        } catch (e) {
          err = String((e as { stderr?: string }).stderr ?? e);
        }
        expect(err).toMatch(/Stream #0:0[^\n]*: Video/);
        expect(err).toMatch(/Stream #0:1[^\n]*: Audio/);
        const dur = /Duration: \d+:\d+:(\d+\.\d+)/.exec(err);
        expect(dur).not.toBeNull();
        const sec = Number(dur![1]);
        // 3 segmentos usáveis × 2s = ~6s (sanitize derruba o mais novo)
        expect(sec).toBeGreaterThan(4.5);
        expect(sec).toBeLessThan(7.5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(clipsDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe('sanitizeSegments', () => {
  it('descarta tudo quando nada é legível (ex: arquivos inexistentes)', async () => {
    const r = await sanitizeSegments(['/nao/existe/a.mp4', '/nao/existe/b.mp4', '/nao/existe/c.mp4']);
    expect(r.ok).toEqual([]);
    expect(r.dropped).toHaveLength(3);
  });
});
