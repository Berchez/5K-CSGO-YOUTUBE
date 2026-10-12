import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickSegments } from '../src/clipper/clipBuilder.js';

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
