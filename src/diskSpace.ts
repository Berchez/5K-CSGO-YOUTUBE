import fs from 'node:fs';

export const DEFAULT_DISK_MIN_FREE_BYTES = 3 * 1024 ** 3;

/** Bytes livres no volume (null quando indeterminável — nunca joga). */
export function getFreeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bfree) * Number(st.bsize);
    if (!Number.isFinite(free) || free < 0) return null;
    return free;
  } catch {
    return null;
  }
}

/**
 * Espaço suficiente? null (indeterminável) = true (fail-open: travar todos
 * os clipes por uma sonda falha é pior que o risco). Puro/testável.
 */
export function isFreeSpaceOk(freeBytes: number | null, minBytes: number): boolean {
  if (freeBytes == null) return true;
  return freeBytes >= minBytes;
}

export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}
