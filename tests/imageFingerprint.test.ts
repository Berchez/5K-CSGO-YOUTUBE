import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  dHash,
  findNearReference,
  hammingDistance,
  hashReferences,
} from '../src/clipper/imageFingerprint.js';

async function pattern(opts: { width?: number; height?: number; invert?: boolean } = {}): Promise<Buffer> {
  const width = opts.width ?? 96;
  const height = opts.height ?? 96;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0;
      const v = block !== Boolean(opts.invert) ? 235 : 20;
      const i = (y * width + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('imageFingerprint', () => {
  it('dá distância 0 para o mesmo buffer', async () => {
    const a = await pattern();
    expect(hammingDistance(await dHash(a), await dHash(a))).toBe(0);
  });

  it('reconhece a mesma imagem redimensionada/recomprimida', async () => {
    const a = await pattern();
    const b = await sharp(a).resize(48, 48).jpeg({ quality: 75 }).toBuffer();
    expect(hammingDistance(await dHash(a), await dHash(b))).toBeLessThanOrEqual(4);
  });

  it('separa imagens de composição diferente', async () => {
    const a = await pattern();
    const b = await pattern({ invert: true });
    expect(hammingDistance(await dHash(a), await dHash(b))).toBeGreaterThan(16);
  });

  it('findNearReference aceita arquivo de referência e rejeita arte diferente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-'));
    try {
      const refFile = path.join(dir, 'ref.png');
      fs.writeFileSync(refFile, await pattern());
      const refs = await hashReferences([refFile]);
      expect(refs).toHaveLength(1);

      const same = await sharp(await pattern()).resize(60, 60).jpeg({ quality: 70 }).toBuffer();
      const near = await findNearReference(same, refs);
      expect(near?.distance).toBeLessThanOrEqual(4);

      const other = await pattern({ invert: true });
      expect(await findNearReference(other, refs)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hammingDistance conta bits diferentes', () => {
    expect(hammingDistance(0b1010n, 0b0011n)).toBe(2);
  });
});
