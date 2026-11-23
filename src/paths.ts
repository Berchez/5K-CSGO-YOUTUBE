import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot(moduleDir);

export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/**
 * Resolve a watchlist configurada no `.env`.
 *
 * Um caminho relativo é sempre relativo à raiz do repo (não ao CWD do
 * script); um caminho absoluto é preservado. `path.join` não serve para
 * este caso: no Windows ele transformaria `C:\...` em
 * `C:\repo\C:\...`.
 */
export function resolveWatchlistFilePath(value?: string | null): string {
  const raw = String(value ?? '').trim();
  if (!raw) return repoPath('data', 'watchlist.json');
  return path.isAbsolute(raw) ? path.normalize(raw) : repoPath(raw);
}
