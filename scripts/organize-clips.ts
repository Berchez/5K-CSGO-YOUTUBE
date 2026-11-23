/**
 * Organiza data/clips: move mp4/json/jpg avulsos da RAIZ para um diretório
 * por clipe (mesmo layout que o buildClip gera para clipes novos).
 *
 * - Só toca arquivos DIRETAMENTE na raiz (refs/, .build/, pastas prontas: intactos).
 * - Agrupa por basename; `_muxed` vai para a pasta do clipe base (só quando
 *   o irmão sem sufixo existe — senão ganha pasta própria).
 * - Atualiza file_path no banco (só linhas que apontam p/ o caminho antigo).
 * - Idempotente e re-executável: segunda passada não encontra nada p/ mover.
 *
 * Uso:
 *   npx tsx scripts/organize-clips.ts              (dry-run: só mostra o plano)
 *   npx tsx scripts/organize-clips.ts --apply      (executa, com backup do .sqlite antes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHANNEL_ID } from '../src/channels.js';
import { getConfig } from '../src/config.js';
import { getDb } from '../src/db.js';

const MEDIA_EXTS = new Set(['.mp4', '.json', '.jpg']);
const MUXED_SUFFIX = '_muxed';

function groupKey(stem: string, stemsInRoot: Set<string>): string {
  if (stem.endsWith(MUXED_SUFFIX)) {
    const base = stem.slice(0, -MUXED_SUFFIX.length);
    // Só agrupa se o irmão sem sufixo existe (senão "player muxed" viraria pasta errada).
    if (stemsInRoot.has(`${base}.mp4`) || stemsInRoot.has(`${base}.json`)) return base;
  }
  return stem;
}

function splitStored(p: string): { sep: string; parts: string[] } {
  const sep = p.includes('\\') ? '\\' : '/';
  return { sep, parts: p.split(/[\\/]/) };
}

/** Linha do banco que pode ser atualizada ao mover um arquivo. */
export interface ClipPathRow {
  id: number;
  filePath: string;
  channelId: string;
}

/**
 * Chave canônica de um caminho. O Windows não diferencia maiúsculas de
 * minúsculas; os demais sistemas mantêm a diferença.
 */
export function canonicalPathKey(filePath: string, baseDir = process.cwd()): string {
  const resolved = path.resolve(baseDir, filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Seleciona somente as linhas que apontam EXATAMENTE para o arquivo que
 * será movido na raiz configurada. Não usar apenas o basename: outra raiz
 * (ou outro canal) pode ter um arquivo com o mesmo nome.
 */
export function rowsForClipPath(
  rows: readonly ClipPathRow[],
  clipsDir: string,
  fileName: string,
  channelId = DEFAULT_CHANNEL_ID,
): ClipPathRow[] {
  const expected = canonicalPathKey(path.join(clipsDir, fileName));
  return rows.filter(
    (row) =>
      row.channelId === channelId && canonicalPathKey(row.filePath) === expected,
  );
}

/** Caminho da linha depois de colocar o arquivo na pasta do clipe. */
export function movedFilePath(storedPath: string, folder: string): string {
  const { sep, parts } = splitStored(storedPath);
  if (parts.length < 2) return storedPath;
  return [...parts.slice(0, -1), folder, parts[parts.length - 1]].join(sep);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const cfg = getConfig();
  const clipsDir = path.resolve(cfg.CLIPS_DIR);
  const entries = fs.readdirSync(clipsDir, { withFileTypes: true });
  const flat = entries
    .filter((e) => e.isFile() && MEDIA_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);
  const others = entries
    .filter((e) => e.isFile() && !MEDIA_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);
  const stems = new Set(flat);

  // Agrupa: pasta -> arquivos
  const groups = new Map<string, string[]>();
  for (const name of flat) {
    const stem = name.slice(0, -path.extname(name).length);
    const folder = groupKey(stem, stems);
    const list = groups.get(folder) ?? [];
    list.push(name);
    groups.set(folder, list);
  }

  console.log(`raiz: ${flat.length} arquivos de mídia em ${groups.size} pastas-alvo`);
  if (others.length > 0) console.log(`ignorados (extensão fora do padrão): ${others.join(', ')}`);

  const db = getDb(cfg.DB_PATH);
  const rows = db
    .prepare(
      `SELECT id, file_path AS filePath, channel_id AS channelId
       FROM clips WHERE channel_id=?`,
    )
    .all(DEFAULT_CHANNEL_ID) as ClipPathRow[];
  let movedFiles = 0;
  let movedWithDb = 0;
  let movedOrphan = 0;
  const upd = db.prepare(
    `UPDATE clips SET file_path = ?
     WHERE id=? AND file_path=? AND channel_id=?`,
  );

  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${cfg.DB_PATH}.organize-${stamp}.bak`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`backup do banco: ${backup}`);
  }

  const moveOne = (from: string, to: string): void => {
    if (apply) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
  };

  for (const [folder, names] of [...groups.entries()].sort()) {
    const destDir = path.join(clipsDir, folder);
    const dbTouched: number[] = [];
    for (const name of names.sort()) {
      const from = path.join(clipsDir, name);
      const to = path.join(destDir, name);
      moveOne(from, to);
      if (name.toLowerCase().endsWith('.mp4')) {
        const candidates = rowsForClipPath(rows, clipsDir, name);
        const touchedBefore = dbTouched.length;
        for (const c of candidates) {
          const next = movedFilePath(c.filePath, folder);
          if (apply) {
            const changed = upd.run(next, c.id, c.filePath, DEFAULT_CHANNEL_ID).changes;
            if (changed > 0) dbTouched.push(c.id);
            else {
              console.warn(
                `  linha #${c.id} mudou durante a organização — não foi atualizada`,
              );
            }
          } else dbTouched.push(c.id);
        }
        if (dbTouched.length > touchedBefore) movedWithDb++;
        else movedOrphan++;
      }
      movedFiles++;
    }
    console.log(
      `${apply ? 'MOVEU' : 'moveria'} ${folder}/ (${names.length} arq.${dbTouched.length > 0 ? `, db#${dbTouched.join(',')}` : ', sem linha no banco'})`,
    );
  }

  console.log(
    `${apply ? 'FEITO' : 'DRY-RUN (nada alterado)'}: ${movedFiles} arquivos em ${groups.size} pastas; ` +
      `${movedWithDb} mp4 com linha no banco atualizada; ${movedOrphan} mp4 órfãos (movidos, sem linha).`,
  );
  if (!apply) console.log('rode com --apply para executar (com backup automático do banco).');
}

/** Executa a organização somente quando o arquivo é chamado diretamente. */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
