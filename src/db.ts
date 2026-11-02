import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AceEvent } from './types.js';
import { getLogger } from './logger.js';

let db: Database.Database | null = null;
let dbPath = '';

export function getDb(dbFile: string): Database.Database {
  if (db && dbPath === dbFile) return db;
  // Trocar de arquivo sem fechar o anterior segura o handle no Windows
  // (o `rm` do arquivo falha e o teste "achando" a falha).
  closeDb();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new Database(dbFile);
  dbPath = dbFile;
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      map TEXT NOT NULL,
      round INTEGER NOT NULL,
      player TEXT NOT NULL,
      team1 TEXT,
      team2 TEXT,
      event TEXT,
      detected_at TEXT NOT NULL,
      UNIQUE(match_id, map, round, player)
    );
    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ace_id INTEGER NOT NULL REFERENCES ace_events(id),
      file_path TEXT NOT NULL,
      youtube_video_id TEXT,
      privacy TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS discarded_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      map TEXT NOT NULL,
      round INTEGER NOT NULL,
      player TEXT NOT NULL,
      reason TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      discarded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrateClips(db);
  ensureClipsUniqueIndex(db);
  return db;
}

/** Fecha a conexão em cache (o arquivo do banco fica liberado no Windows). */
export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // best-effort
  }
  db = null;
  dbPath = '';
}

/**
 * Colunas novas da tabela `clips`.
 *
 * `CREATE TABLE IF NOT EXISTS` NÃO altera tabela existente: um banco já
 * criado ficaria sem as colunas novas (e o INSERT com elas falharia).
 * A migração é idempotente (só ADD COLUMN do que ainda não existe).
 */
const CLIP_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'format', ddl: "ALTER TABLE clips ADD COLUMN format TEXT" },
  { name: 'width', ddl: 'ALTER TABLE clips ADD COLUMN width INTEGER' },
  { name: 'height', ddl: 'ALTER TABLE clips ADD COLUMN height INTEGER' },
  { name: 'duration_sec', ddl: 'ALTER TABLE clips ADD COLUMN duration_sec REAL' },
  { name: 'is_shorts', ddl: 'ALTER TABLE clips ADD COLUMN is_shorts INTEGER NOT NULL DEFAULT 0' },
  { name: 'title', ddl: 'ALTER TABLE clips ADD COLUMN title TEXT' },
  { name: 'published_at', ddl: 'ALTER TABLE clips ADD COLUMN published_at TEXT' },
];

/** Nomes das colunas de `clips` (PRAGMA table_info). */
function tableColumns(d: Database.Database, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Migração das colunas de `clips`.
 *
 * O que já existe é lido do PRAGMA: um `ALTER TABLE` por coluna, todo
 * boot, só para receber "duplicate column name" e ser ignorado — em
 * banco com muitas colunas isso são dezenas de DDL por abertura.
 */
function migrateClips(d: Database.Database): void {
  let existing: Set<string>;
  try {
    existing = tableColumns(d, 'clips');
  } catch (e) {
    getLogger().warn(
      { err: String(e).slice(0, 160) },
      'migração da tabela clips falhou (PRAGMA table_info)',
    );
    return;
  }
  for (const column of CLIP_COLUMNS) {
    if (existing.has(column.name)) continue;
    try {
      d.exec(column.ddl);
    } catch (e) {
      getLogger().warn(
        { err: String(e).slice(0, 160), coluna: column.name },
        'migração da tabela clips falhou',
      );
    }
  }
}

/**
 * Índice ÚNICO de (ace_id, formato).
 *
 * O `insertClip` faz SELECT + INSERT/UPDATE: dois processos (o bot e o
 * script de Shorts/VOD) podem gravar o MESMO ace ao mesmo tempo e, sem
 * o índice, criar duas linhas — o Short pode subir duas vezes.
 *
 * Duplicatas legadas são limpas antes: a linha com vídeo publicado
 * sobrevive (é a que o bot usa para não reenviar), as outras são
 * removidas. Se o índice não puder ser criado (banco antigo com dado
 * inesperado), o script segue no SELECT+INSERT — só perde a garantia.
 */
function ensureClipsUniqueIndex(d: Database.Database): void {
  try {
    const dupes = d
      .prepare(
        `SELECT ace_id, COALESCE(format, '') AS fmt, COUNT(*) AS n
         FROM clips GROUP BY ace_id, COALESCE(format, '') HAVING n > 1`,
      )
      .all() as Array<{ ace_id: number; fmt: string; n: number }>;
    for (const dup of dupes) {
      const rows = d
        .prepare(
          `SELECT id FROM clips
           WHERE ace_id=? AND COALESCE(format, '')=?
           ORDER BY (youtube_video_id IS NOT NULL) DESC, id DESC`,
        )
        .all(dup.ace_id, dup.fmt) as Array<{ id: number }>;
      for (const row of rows.slice(1)) {
        d.prepare('DELETE FROM clips WHERE id=?').run(row.id);
      }
    }
    d.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_ace_format
       ON clips (ace_id, COALESCE(format, ''))`,
    );
  } catch (e) {
    getLogger().warn(
      { err: String(e).slice(0, 160) },
      'índice único de clips não criado (duplicatas podem aparecer)',
    );
  }
}

export function hasAce(
  dbFile: string,
  matchId: string,
  map: string,
  round: number,
  player: string,
): boolean {
  const d = getDb(dbFile);
  const row = d
    .prepare(
      'SELECT 1 FROM ace_events WHERE match_id=? AND map=? AND round=? AND player=?',
    )
    .get(matchId, map, round, player);
  return !!row;
}

export function insertAce(dbFile: string, ace: AceEvent): number {
  const d = getDb(dbFile);
  const info = d
    .prepare(
      `INSERT OR IGNORE INTO ace_events
       (match_id, map, round, player, team1, team2, event, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ace.matchId,
      ace.map,
      ace.round,
      ace.player,
      ace.team1,
      ace.team2,
      ace.event,
      ace.detectedAt,
    );
  if (info.lastInsertRowid) return Number(info.lastInsertRowid);
  const row = d
    .prepare(
      'SELECT id FROM ace_events WHERE match_id=? AND map=? AND round=? AND player=?',
    )
    .get(ace.matchId, ace.map, ace.round, ace.player) as { id: number };
  return row.id;
}

export interface DiscardedEvent {
  matchId: string;
  map: string;
  round: number;
  player: string;
  reason: string;
  detectedAt?: string;
}

/**
 * Remove um ace (e clipes associados) e registra o descarte. Usado quando o
 * evento se revela fantasma (sem footage no buffer) e não deve bloquear
 * detecções futuras da mesma chave via hasAce.
 */
export function discardAce(dbFile: string, aceId: number, event: DiscardedEvent): void {
  const d = getDb(dbFile);
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM clips WHERE ace_id=?').run(aceId);
    d.prepare('DELETE FROM ace_events WHERE id=?').run(aceId);
    insertDiscarded(d, event);
  });
  tx();
}

/** Registra um descarte que nem chegou a ser gravado em ace_events. */
export function recordDiscardedEvent(dbFile: string, event: DiscardedEvent): void {
  insertDiscarded(getDb(dbFile), event);
}

function insertDiscarded(d: Database.Database, event: DiscardedEvent): void {
  d.prepare(
    `INSERT INTO discarded_events (match_id, map, round, player, reason, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    event.matchId,
    event.map,
    event.round,
    event.player,
    event.reason,
    event.detectedAt ?? new Date().toISOString(),
  );
}

export interface ClipInsert {
  /** Formato do clipe (ex.: 'standard', 'shorts'). */
  format?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  isShorts?: boolean;
  title?: string | null;
  publishedAt?: string | null;
}

/** Chave canônica do ace (o UNIQUE da tabela `ace_events`). */
export function aceKey(
  matchId: string,
  map: string,
  round: number,
  player: string,
): string {
  return `${matchId}|${map}|${round}|${player}`;
}

/** Id do ace no banco (null se o evento não está registrado). */
export function getAceId(
  dbFile: string,
  matchId: string,
  map: string,
  round: number,
  player: string,
): number | null {
  const row = getDb(dbFile)
    .prepare(
      'SELECT id FROM ace_events WHERE match_id=? AND map=? AND round=? AND player=?',
    )
    .get(matchId, map, round, player) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/**
 * Registra o clipe.
 *
 * - Só as colunas que EXISTEM na tabela entram no INSERT: um banco sem a
 *   migração aplicada não pode derrubar o registro inteiro.
 * - Um clipe do MESMO ace e MESMO formato é ATUALIZADO, não duplicado:
 *   reexecutar o script não pode criar duas linhas para o mesmo Short.
 * - O `youtube_video_id` já gravado NUNCA é apagado por um insert sem id
 *   (um re-registro do clipe não pode fazer o bot esquecer o vídeo que
 *   já subiu).
 */
export function insertClip(
  dbFile: string,
  aceId: number,
  filePath: string,
  privacy: string,
  youtubeVideoId?: string,
  extra: ClipInsert = {},
): void {
  const d = getDb(dbFile);
  const columns = tableColumns(d, 'clips');
  const values: Record<string, unknown> = {
    ace_id: aceId,
    file_path: filePath,
    youtube_video_id: youtubeVideoId ?? null,
    privacy,
    format: extra.format ?? null,
    width: extra.width ?? null,
    height: extra.height ?? null,
    duration_sec: extra.durationSec ?? null,
    is_shorts: extra.isShorts ? 1 : 0,
    title: extra.title ?? null,
    published_at: extra.publishedAt ?? null,
  };
  const names = Object.keys(values).filter((name) => columns.has(name));
  if (names.length === 0) throw new Error('tabela clips sem colunas conhecidas');
  const params = names.map((name) => values[name]);

  const formatValue = String(extra.format ?? '');
  const existing = d
    .prepare(
      `SELECT id FROM clips WHERE ace_id=? AND COALESCE(format, '')=? LIMIT 1`,
    )
    .get(aceId, formatValue) as { id: number } | undefined;

  const update = (id: number): void => {
    // `youtube_video_id` só é trocado quando o novo valor é REALMENTE
    // diferente: um insert sem id não pode limpar o id publicado.
    const setNames = names.filter((n) => n !== 'youtube_video_id');
    const setClause = setNames.map((n) => `${n}=?`).join(', ');
    const setParams = setNames.map((n) => values[n]);
    const hasVideoId = columns.has('youtube_video_id');
    const sql = `UPDATE clips SET ${setClause}${
      hasVideoId ? ', youtube_video_id=COALESCE(?, youtube_video_id)' : ''
    } WHERE id=?`;
    const sqlParams = hasVideoId
      ? [...setParams, youtubeVideoId ?? null, id]
      : [...setParams, id];
    d.prepare(sql).run(...sqlParams);
  };

  if (existing) {
    update(existing.id);
    return;
  }
  try {
    d.prepare(`INSERT INTO clips (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...params);
  } catch (e) {
    // Corrida com outro processo: o índice único barrou o INSERT. Atualiza
    // a linha que o outro processo gravou em vez de falhar.
    const message = String(e);
    if (!/UNIQUE|constraint/i.test(message)) throw e;
    const row = d
      .prepare(
        `SELECT id FROM clips WHERE ace_id=? AND COALESCE(format, '')=? LIMIT 1`,
      )
      .get(aceId, formatValue) as { id: number } | undefined;
    if (!row) throw e;
    update(row.id);
  }
}

/**
 * Shorts já publicados, indexados pela CHAVE DO ACE
 * (`match_id|map|round|player`).
 *
 * Indexar pelo caminho do arquivo quebrava o dedupe: o mesmo ace
 * gravado em outro diretório (ou com o caminho relativo num banco
 * antigo) passava como "novo" e o Short ia ao ar DUAS vezes.
 */
export function findPublishedShorts(dbFile: string): Map<string, string> {
  const rows = getDb(dbFile)
    .prepare(
      `SELECT e.match_id, e.map, e.round, e.player, c.youtube_video_id
       FROM clips c JOIN ace_events e ON e.id = c.ace_id
       WHERE c.is_shorts = 1 AND c.youtube_video_id IS NOT NULL`,
    )
    .all() as Array<{
    match_id: string;
    map: string;
    round: number;
    player: string;
    youtube_video_id: string;
  }>;
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(aceKey(row.match_id, row.map, row.round, row.player), row.youtube_video_id);
  }
  return out;
}

/**
 * Vídeos já enviados (com `youtube_video_id`) registrados desde `sinceSql`.
 *
 * `sinceSql` no formato do SQLite ('YYYY-MM-DD HH:MM:SS', UTC) — o
 * `created_at` da tabela `clips` usa esse formato. Serve para a guarda
 * de cota: cada `videos.insert` custa 1600 units do limite diário de
 * 10000 do YouTube, e o bot live e o script de Shorts dividem a mesma
 * cota do projeto de API.
 */
export function countPublishedClips(dbFile: string, sinceSql: string): number {
  const row = getDb(dbFile)
    .prepare(
      `SELECT COUNT(*) AS n FROM clips
       WHERE youtube_video_id IS NOT NULL AND created_at >= ?`,
    )
    .get(sinceSql) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}
