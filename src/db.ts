import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CHANNEL_ID,
  isChannelId,
} from './channels.js';
import type { AceEvent } from './types.js';
import { getLogger } from './logger.js';
import { quotaDecision } from './uploader/quota.js';

let db: Database.Database | null = null;
let dbPath = '';

/** DDL do schema multi-canal (o canal default é a constante, não literal). */
const CHANNEL_DEFAULT = `'${DEFAULT_CHANNEL_ID}'`;

export function getDb(dbFile: string): Database.Database {
  if (db && dbPath === dbFile) return db;
  // Trocar de arquivo sem fechar o anterior segura o handle no Windows
  // (o `rm` do arquivo falha e o teste "achando" a falha).
  closeDb();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const d = new Database(dbFile);
  try {
    d.pragma('journal_mode = WAL');
    d.exec(`
      CREATE TABLE IF NOT EXISTS ace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL DEFAULT ${CHANNEL_DEFAULT},
        match_id TEXT NOT NULL,
        map TEXT NOT NULL,
        round INTEGER NOT NULL,
        player TEXT NOT NULL,
        team1 TEXT,
        team2 TEXT,
        event TEXT,
        detected_at TEXT NOT NULL,
        UNIQUE(channel_id, match_id, map, round, player)
      );
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ace_id INTEGER NOT NULL REFERENCES ace_events(id),
        channel_id TEXT NOT NULL DEFAULT ${CHANNEL_DEFAULT},
        file_path TEXT NOT NULL,
        youtube_video_id TEXT,
        privacy TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS discarded_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL DEFAULT ${CHANNEL_DEFAULT},
        match_id TEXT NOT NULL,
        map TEXT NOT NULL,
        round INTEGER NOT NULL,
        player TEXT NOT NULL,
        reason TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        discarded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS youtube_upload_reservations (
        reservation_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        quota_day TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Ordem importa: o rebuild de `ace_events` preserva os ids, então as
    // referências de `clips.ace_id` continuam válidas.
    migrateAceEventsChannel(d, dbFile);
    migrateClips(d);
    migrateChannelColumns(d);
    ensureClipsUniqueIndex(d);
    // Sem `channel_id` o INSERT do ace/descarte quebra no primeiro evento
    // (e o dedup cruzaria canais). Melhor falhar no boot, alto, do que
    // descobrir no meio da partida.
    assertChannelColumns(d);
  } catch (e) {
    // A conexão NÃO entra no cache: se ela voltar no próximo `getDb()`,
    // o chamador receberia um handle com schema velho (sem `channel_id`)
    // e sem nenhuma validação — todo INSERT quebraria com "no such
    // column". Fecha e propaga o erro.
    try {
      d.close();
    } catch {
      // best-effort
    }
    throw e;
  }
  db = d;
  dbPath = dbFile;
  return d;
}

/** `channel_id` presente nas três tabelas (ou o banco não é multi-canal). */
function assertChannelColumns(d: Database.Database): void {
  const missingChannel = (['ace_events', 'clips', 'discarded_events'] as const).filter(
    (table) => !tableColumns(d, table).has('channel_id'),
  );
  if (missingChannel.length > 0) {
    throw new Error(
      `migração multi-canal incompleta: channel_id ausente em ${missingChannel.join(', ')}`,
    );
  }
}

/** Canal de uma chamada de escrita: obrigatório e canônico; inválido = erro. */
function channelOf(channelId: string): string {
  if (!isChannelId(channelId)) throw new Error(`canal inválido: "${channelId}"`);
  return channelId;
}

/**
 * `ace_events` antigo tem `UNIQUE(match_id, map, round, player)` e nenhuma
 * coluna `channel_id`. SQLite não altera constraint: o caminho é criar a
 * tabela nova, copiar (tudo vira o canal default) e trocar. Os ids são
 * preservados, então `clips.ace_id` continua apontando para a linha certa.
 *
 * É a ÚNICA etapa destrutiva da migração: por isso ela (a) tira backup
 * antes, (b) roda em transação com lock de escrita e (c) confere a
 * contagem e as foreign keys depois.
 */
function migrateAceEventsChannel(d: Database.Database, dbFile: string): void {
  if (tableColumns(d, 'ace_events').has('channel_id')) return;
  // Backup antes de qualquer escrita: o `.bak` é o caminho de volta.
  const backup = backupBeforeMigration(d, dbFile);
  getLogger().info(
    { backup },
    'backup do banco criado antes da migração multi-canal',
  );
  // Algumas builds do SQLite ligam `foreign_keys` por default: sem
  // desligar, o `DROP TABLE ace_events` esbarra em `clips.ace_id`.
  // O pragma é no-op dentro de transação — tem que ser ANTES do tx().
  const fkWasOn = Number(d.pragma('foreign_keys', { simple: true })) === 1;
  if (fkWasOn) d.pragma('foreign_keys = OFF');
  try {
    const migrate = d.transaction(() => {
      // Re-checagem DENTRO do lock de escrita: bot e script podem abrir
      // o banco ao mesmo tempo; o segundo precisa ver a coluna já
      // migrada — senão os dois rebuilds marcariam tudo como 'br' (e o
      // 'en' sumiria do banco).
      if (tableColumns(d, 'ace_events').has('channel_id')) return;
      const before = countRows(d, 'ace_events');
      d.exec('DROP TABLE IF EXISTS ace_events_new');
      d.exec(`
        CREATE TABLE ace_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL DEFAULT ${CHANNEL_DEFAULT},
          match_id TEXT NOT NULL,
          map TEXT NOT NULL,
          round INTEGER NOT NULL,
          player TEXT NOT NULL,
          team1 TEXT,
          team2 TEXT,
          event TEXT,
          detected_at TEXT NOT NULL,
          UNIQUE(channel_id, match_id, map, round, player)
        )
      `);
      d.exec(`
        INSERT INTO ace_events_new
          (id, channel_id, match_id, map, round, player, team1, team2, event, detected_at)
        SELECT id, ${CHANNEL_DEFAULT}, match_id, map, round, player, team1, team2, event, detected_at
        FROM ace_events
      `);
      d.exec('DROP TABLE ace_events');
      d.exec('ALTER TABLE ace_events_new RENAME TO ace_events');
      const after = countRows(d, 'ace_events');
      if (after !== before) {
        throw new Error(
          `contagem de ace_events mudou na migração: ${before} -> ${after}`,
        );
      }
    });
    // `immediate`: pega o lock de escrita já na abertura da transação (o
    // outro processo espera em vez de os dois lerem "sem a coluna").
    migrate.immediate();
  } finally {
    if (fkWasOn) d.pragma('foreign_keys = ON');
  }
  assertNoForeignKeyViolations(d);
}

/** Linhas de uma tabela (0 se a tabela não existe). */
function countRows(d: Database.Database, table: string): number {
  const row = d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Backup consistente do banco ANTES do rebuild destrutivo.
 *
 * `VACUUM INTO` (SQLite 3.27+) copia o banco inteiro num arquivo novo
 * com o WAL consolidado: é o equivalente online do
 * `wal_checkpoint(TRUNCATE)` + `copyFileSync`, sem a janela em que a
 * cópia fica pela metade.
 */
function backupBeforeMigration(d: Database.Database, dbFile: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${dbFile}.pre-channel.bak`;
  if (fs.existsSync(target)) {
    // Um diretório (ou qualquer coisa que não seja arquivo) no lugar do
    // backup não serve: a migração NÃO continua sem uma volta de verdade.
    if (!fs.statSync(target).isFile()) {
      throw new Error(`backup do banco existe mas não é um arquivo: ${target}`);
    }
    // Já existe um backup anterior: cria cópia com timestamp para não sobrescrever
    // nem deixar o estado pré-migração atual sem backup.
    target = `${dbFile}.pre-channel.${stamp}.bak`;
  }
  const escaped = target.replace(/'/g, "''");
  try {
    d.exec(`VACUUM INTO '${escaped}'`);
  } catch (e) {
    // Outro processo pode ter criado o backup no meio do caminho: aí ele
    // serve. Sem ele, a migração NÃO continua (fail-closed).
    if (!fs.existsSync(target)) {
      throw new Error(
        `backup do banco falhou (${target}): ${String(e).slice(0, 200)} — a migração foi abortada`,
      );
    }
  }
  return target;
}

/** Nenhuma referência órfã depois do rebuild (o `clips.ace_id` continua válido). */
function assertNoForeignKeyViolations(d: Database.Database): void {
  const violations = d.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
  }>;
  if (violations.length > 0) {
    throw new Error(
      `foreign_key_check reprovou o banco após a migração (${violations.length} violação(ões))`,
    );
  }
}

/** `channel_id` em `clips`/`discarded_events` (ADD COLUMN é idempotente). */
function migrateChannelColumns(d: Database.Database): void {
  for (const table of ['clips', 'discarded_events'] as const) {
    if (tableColumns(d, table).has('channel_id')) continue;
    try {
      d.exec(
        `ALTER TABLE ${table} ADD COLUMN channel_id TEXT NOT NULL DEFAULT ${CHANNEL_DEFAULT}`,
      );
    } catch (e) {
      // Falha aqui = banco sem `channel_id`: o bot inteiro quebraria no
      // primeiro INSERT. Melhor derrubar no boot (o `getDb` valida).
      throw new Error(
        `migração de channel_id em ${table} falhou: ${String(e).slice(0, 200)}`,
      );
    }
  }
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

/** Nomes das colunas de uma tabela (PRAGMA table_info). */
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
  channelId: string,
): boolean {
  const d = getDb(dbFile);
  const row = d
    .prepare(
      `SELECT 1 FROM ace_events
       WHERE channel_id=? AND match_id=? AND map=? AND round=? AND player=?`,
    )
    .get(channelOf(channelId), matchId, map, round, player);
  return !!row;
}

export function insertAce(
  dbFile: string,
  ace: AceEvent,
  channelId: string,
): number {
  const d = getDb(dbFile);
  const channel = channelOf(channelId);
  // O evento e a escrita precisam ser do mesmo canal. Sem essa checagem,
  // um ace EN poderia ser salvo no BR só porque o chamador passou `br`.
  const aceChannel = channelOf(ace.channelId);
  if (aceChannel !== channel) {
    throw new Error(
      `canal do ace (${aceChannel}) não confere com o canal da escrita (${channel})`,
    );
  }
  const info = d
    .prepare(
      `INSERT OR IGNORE INTO ace_events
       (channel_id, match_id, map, round, player, team1, team2, event, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      channel,
      ace.matchId,
      ace.map,
      ace.round,
      ace.player,
      ace.team1,
      ace.team2,
      ace.event,
      ace.detectedAt,
    );
  // `changes` diz se a linha REALMENTE entrou. `lastInsertRowid` fica no
  // último insert da conexão: com `INSERT OR IGNORE` ignorado, ele
  // devolveria o id de OUTRO ace (o clipe penduraria no evento errado).
  if (info.changes > 0) return Number(info.lastInsertRowid);
  const row = d
    .prepare(
      `SELECT id FROM ace_events
       WHERE channel_id=? AND match_id=? AND map=? AND round=? AND player=?`,
    )
    .get(channel, ace.matchId, ace.map, ace.round, ace.player) as { id: number };
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
    // O canal vem da própria linha do ace: o descarte não pode cair no
    // canal errado quando o chamador esquece de passar.
    const row = d
      .prepare('SELECT channel_id FROM ace_events WHERE id=?')
      .get(aceId) as { channel_id: string } | undefined;
    if (!row) {
      throw new Error(`ace ${aceId} não existe — o descarte não pode ser registrado`);
    }
    const channel = channelOf(row.channel_id);
    d.prepare('DELETE FROM clips WHERE ace_id=?').run(aceId);
    d.prepare('DELETE FROM ace_events WHERE id=?').run(aceId);
    insertDiscarded(d, event, channel);
  });
  tx();
}

/** Registra um descarte que nem chegou a ser gravado em ace_events. */
export function recordDiscardedEvent(
  dbFile: string,
  event: DiscardedEvent,
  channelId: string,
): void {
  insertDiscarded(getDb(dbFile), event, channelOf(channelId));
}

function insertDiscarded(d: Database.Database, event: DiscardedEvent, channelId: string): void {
  d.prepare(
    `INSERT INTO discarded_events
     (channel_id, match_id, map, round, player, reason, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    channelId,
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
  channelId: string,
): number | null {
  const row = getDb(dbFile)
    .prepare(
      `SELECT id FROM ace_events
       WHERE channel_id=? AND match_id=? AND map=? AND round=? AND player=?`,
    )
    .get(channelOf(channelId), matchId, map, round, player) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/**
 * Registra o clipe.
 *
 * - O CANAL vem do ace (`ace_events.channel_id`): o clipe é do mesmo
 *   canal do evento. Passar o canal pelo chamador permitia registrar
 *   (ou re-registrar) um clipe EN como BR — ele contaria na cota e no
 *   dedup do canal errado;
 * - Só as colunas que EXISTEM na tabela entram no INSERT: um banco sem a
 *   migração aplicada não pode derrubar o registro inteiro;
 * - Um clipe do MESMO ace e MESMO formato é ATUALIZADO, não duplicado:
 *   reexecutar o script não pode criar duas linhas para o mesmo Short;
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
  const aceRow = d
    .prepare('SELECT channel_id FROM ace_events WHERE id=?')
    .get(aceId) as { channel_id: string } | undefined;
  if (!aceRow) {
    throw new Error(`ace ${aceId} não existe — o clipe não pode ser registrado`);
  }
  const channel = channelOf(aceRow.channel_id);
  const columns = tableColumns(d, 'clips');
  const values: Record<string, unknown> = {
    ace_id: aceId,
    channel_id: channel,
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
export function findPublishedShorts(
  dbFile: string,
  channelId: string,
): Map<string, string> {
  const rows = getDb(dbFile)
    .prepare(
      `SELECT e.match_id, e.map, e.round, e.player, c.youtube_video_id
       FROM clips c JOIN ace_events e ON e.id = c.ace_id
       WHERE c.is_shorts = 1 AND c.youtube_video_id IS NOT NULL AND c.channel_id = ?`,
    )
    .all(channelOf(channelId)) as Array<{
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
 * `sinceSql` no formato do SQLite ('YYYY-MM-DD HH:MM:SS') — o mesmo
 * formato de `created_at`/`published_at` da tabela `clips`. Serve para a
 * guarda de cota: cada `videos.insert` consome uma chamada do bucket diário
 * de uploads do YouTube, compartilhado pelo bot live e pelo script de Shorts.
 *
 * A contagem é pelo `published_at` (quando o vídeo SUBIU), não pelo
 * `created_at` (quando o clipe foi gravado): um clipe antigo publicado
 * hoje consumiu a cota de HOJE, e um clipe de hoje publicado ontem não
 * consumiu a de hoje. `COALESCE` cobre as linhas antigas (sem
 * `published_at`) sem perder a contagem.
 *
 * `datetime(...)` nos DOIS lados: `published_at` é gravado como ISO
 * (`2026-11-14T03:00:00.000Z`) e `created_at` como `datetime('now')`
 * (`2026-11-14 03:00:00`). Comparar texto direto contra o limite
 * (`YYYY-MM-DD HH:MM:SS`) faz `'T' > ' '` e todo upload do dia UTC da
 * fronteira contar — superestimando a cota e bloqueando upload legítimo.
 */
export function countPublishedClips(
  dbFile: string,
  sinceSql: string,
  channelId: string,
): number {
  const row = getDb(dbFile)
    .prepare(
      `SELECT COUNT(*) AS n FROM clips
       WHERE youtube_video_id IS NOT NULL
         AND channel_id = ?
         AND datetime(COALESCE(published_at, created_at)) >= datetime(?)`,
    )
    .get(channelOf(channelId), sinceSql) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Reserva atomicamente uma vaga de `videos.insert` para este dia/canal. */
export function reserveYouTubeUpload(
  dbFile: string,
  sinceSql: string,
  quotaDay: string,
  channelId: string,
  limit: number,
  reservedUploads: number,
):
  | { allowed: true; reservationId: string; used: number }
  | { allowed: false; reason: string; used: number } {
  const d = getDb(dbFile);
  const canonicalChannel = channelOf(channelId);
  const reserve = d.transaction(() => {
    d.prepare('DELETE FROM youtube_upload_reservations WHERE quota_day < ?').run(quotaDay);
    const published = d.prepare(
      `SELECT COUNT(*) AS n FROM clips
       WHERE youtube_video_id IS NOT NULL AND channel_id = ?
         AND datetime(COALESCE(published_at, created_at)) >= datetime(?)`,
    ).get(canonicalChannel, sinceSql) as { n: number };
    const pending = d.prepare(
      `SELECT COUNT(*) AS n FROM youtube_upload_reservations
       WHERE channel_id = ? AND quota_day = ?`,
    ).get(canonicalChannel, quotaDay) as { n: number };
    const used = Number(published.n) + Number(pending.n);
    const decision = quotaDecision({ used, limit, reservedUploads });
    if (!decision.allowed) {
      return {
        allowed: false as const,
        reason: decision.reason ?? 'limite diário de uploads atingido',
        used,
      };
    }
    const reservationId = crypto.randomUUID();
    d.prepare(
      'INSERT INTO youtube_upload_reservations (reservation_id, channel_id, quota_day) VALUES (?, ?, ?)',
    ).run(reservationId, canonicalChannel, quotaDay);
    return { allowed: true as const, reservationId, used };
  });
  return reserve.immediate();
}

/** Libera a vaga depois do registro do vídeo ou de uma falha de upload. */
export function releaseYouTubeUploadReservation(dbFile: string, reservationId: string): void {
  getDb(dbFile)
    .prepare('DELETE FROM youtube_upload_reservations WHERE reservation_id = ?')
    .run(reservationId);
}
