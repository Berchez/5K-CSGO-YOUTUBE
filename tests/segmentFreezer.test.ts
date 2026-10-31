import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SegmentFreezer } from '../src/clipper/segmentFreezer.js';

const T = 1_700_000_000_000;
const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freezer-'));
  tempDirs.push(dir);
  return dir;
}

function makeSegment(dir: string, name: string, mtimeMs: number, size = 64): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function mtimes(files: string[]): number[] {
  return files.map((file) => Math.round(fs.statSync(file).mtimeMs));
}

/** Ordena como `StreamRecorder.listSegments()`: por mtime. */
function byMtime(files: string[]): string[] {
  return [...files].sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SegmentFreezer', () => {
  it('congela só os segmentos fechados, preservando o mtime', async () => {
    const src = tmpDir();
    const dest = tmpDir();
    const a = makeSegment(src, 'seg_1.ts', T);
    const b = makeSegment(src, 'seg_2.ts', T + 10_000);
    const beingWritten = makeSegment(src, 'seg_3.ts', T + 20_000);
    const freezer = new SegmentFreezer({
      listSegments: () => [a, b, beingWritten],
      destDir: dest,
      segmentTimeSec: 10,
    });
    await freezer.scan();
    freezer.stop();

    const frozen = freezer.listFrozen();
    expect(frozen).toHaveLength(2);
    expect(mtimes(frozen)).toEqual([T, T + 10_000]);
    expect(fs.readFileSync(frozen[0]).length).toBe(64);
  });

  it('a rotação do anel não apaga a cópia da volta anterior', async () => {
    const src = tmpDir();
    const dest = tmpDir();
    const files = [makeSegment(src, 'seg_1.ts', T), makeSegment(src, 'seg_2.ts', T + 10_000)];
    const freezer = new SegmentFreezer({
      listSegments: () => byMtime(files),
      destDir: dest,
      segmentTimeSec: 10,
    });
    await freezer.scan();
    expect(freezer.listFrozen()).toHaveLength(1);

    // O anel reescreve seg_1.ts com material novo: o nome é o mesmo, o
    // mtime é outro. A cópia antiga continua, e seg_2 (que fechou) entra.
    files[0] = makeSegment(src, 'seg_1.ts', T + 240_000);
    await freezer.scan();
    expect(freezer.listFrozen()).toHaveLength(2);

    // Quando a volta nova fecha, ela entra como uma cópia SEPARADA.
    files.push(makeSegment(src, 'seg_3.ts', T + 250_000));
    await freezer.scan();
    const frozen = freezer.listFrozen();
    expect(frozen).toHaveLength(3);
    expect(mtimes(frozen)).toEqual([T, T + 10_000, T + 240_000]);
    freezer.stop();
  });

  it('waitForCoverage espera o material fechar o alvo', async () => {
    const src = tmpDir();
    const dest = tmpDir();
    const files = [makeSegment(src, 'seg_1.ts', T), makeSegment(src, 'seg_2.ts', T + 10_000)];
    const freezer = new SegmentFreezer({
      listSegments: () => byMtime(files),
      destDir: dest,
      segmentTimeSec: 10,
      pollIntervalMs: 10,
    });
    await freezer.scan();
    expect(await freezer.waitForCoverage(T, 50)).toBe(false);

    // Fecha seg_3 (o seg_4 ainda está em escrita): o alvo T+15s é coberto.
    files.push(makeSegment(src, 'seg_3.ts', T + 30_000));
    files.push(makeSegment(src, 'seg_4.ts', T + 40_000));
    expect(await freezer.waitForCoverage(T, 500)).toBe(true);
    freezer.stop();
  });
});
