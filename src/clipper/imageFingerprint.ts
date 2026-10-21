import sharp from 'sharp';

export interface ImageHash {
  name: string;
  hash: bigint;
}

/** dHash 8x8 (64 bits): robusto a resize/recompressão, sensível a composição. */
export async function dHash(buf: Buffer): Promise<bigint> {
  const { data } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (data[y * 9 + x] < data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let v = a ^ b;
  let n = 0;
  while (v !== 0n) {
    v &= v - 1n;
    n++;
  }
  return n;
}

/**
 * Distância máxima para considerar "mesma imagem". Recompressões do mesmo
 * arquivo (mapa/foto anexados) ficam em 0-2; uma arte gerada diferente passa
 * longe (>=8 na prática).
 */
export const REFERENCE_MAX_DISTANCE = 4;

export async function hashReferences(
  files: string[],
  log?: { warn: (obj: object, msg: string) => void },
): Promise<ImageHash[]> {
  const out: ImageHash[] = [];
  for (const file of files) {
    try {
      out.push({ name: file, hash: await dHash(await sharp(file).toBuffer()) });
    } catch {
      log?.warn({ file }, 'falha ao calcular fingerprint da referência');
    }
  }
  return out;
}

export async function findNearReference(
  candidate: Buffer,
  refs: ImageHash[],
  maxDistance = REFERENCE_MAX_DISTANCE,
): Promise<{ name: string; distance: number } | null> {
  if (refs.length === 0) return null;
  const hash = await dHash(candidate);
  let best: { name: string; distance: number } | null = null;
  for (const ref of refs) {
    const distance = hammingDistance(hash, ref.hash);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: ref.name, distance };
    }
  }
  return best;
}
