import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aceKey,
  closeDb,
  countPublishedClips,
  discardAce,
  findPublishedShorts,
  getAceId,
  getDb,
  hasAce,
  insertAce,
  insertClip,
  recordDiscardedEvent,
  releaseYouTubeUploadReservation,
  reserveYouTubeUpload,
} from '../src/db.js';
import type { AceEvent } from '../src/types.js';

const tempDirs: string[] = [];

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botdb-'));
  const file = path.join(dir, 'bot.sqlite');
  tempDirs.push(dir);
  return file;
}

function makeAce(overrides: Partial<AceEvent> = {}): AceEvent {
  const { channelId = 'br', ...otherOverrides } = overrides;
  return {
    channelId,
    matchId: '2399958',
    map: 'Inferno',
    round: 12,
    player: 'doc',
    team1: 'Gamers Club',
    team2: 'RED Canids',
    event: 'Gamers Club Masters VII',
    detectedAt: '2026-10-31T21:32:27.875Z',
    kills: [],
    ...otherOverrides,
  };
}

afterEach(() => {
  closeDb();
  // O diretório inteiro sai (o WAL/shm moram junto): apagar só o .sqlite
  // deixava a pasta temporária vazando a cada teste.
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('banco: clips (migração + Shorts)', () => {
  it('a migração adiciona as colunas novas em banco já existente', () => {
    const file = tmpDb();
    // Banco "antigo" (versão anterior do bot): a tabela clips sem as
    // colunas dos Shorts. `CREATE TABLE IF NOT EXISTS` não altera tabela
    // existente — quem faz isso é a migração.
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE ace_events (
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
      CREATE TABLE clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ace_id INTEGER NOT NULL REFERENCES ace_events(id),
        file_path TEXT NOT NULL,
        youtube_video_id TEXT,
        privacy TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw.close();

    const columns = getDb(file).prepare('PRAGMA table_info(clips)').all() as Array<{
      name: string;
    }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('format');
    expect(names).toContain('is_shorts');
    expect(names).toContain('duration_sec');
  });

  it('registra o Short com formato, dimensões e duração', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid123', {
      format: 'shorts',
      width: 1080,
      height: 1920,
      durationSec: 43.2,
      isShorts: true,
      title: 'ACE DOC INFERNO',
      publishedAt: '2026-11-01T12:00:00.000Z',
    });
    const row = getDb(file)
      .prepare('SELECT * FROM clips WHERE youtube_video_id=?')
      .get('vid123') as Record<string, unknown>;
    expect(row.format).toBe('shorts');
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920);
    expect(row.duration_sec).toBeCloseTo(43.2, 1);
    expect(row.is_shorts).toBe(1);
    expect(row.title).toBe('ACE DOC INFERNO');
  });

  it('findPublishedShorts devolve só os Shorts já publicados (chave do ace)', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-long');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-short', {
      isShorts: true,
      format: 'shorts',
    });
    const published = findPublishedShorts(file, 'br');
    // A chave é o ace (match|map|round|player): o mesmo Short gravado em
    // outro diretório continua sendo "o mesmo Short".
    expect(published.get(aceKey('2399958', 'Inferno', 12, 'doc'))).toBe('vid-short');
    expect(published.size).toBe(1);
  });

  it('a migração é idempotente (abrir o banco de novo não duplica coluna)', () => {
    const file = tmpDb();
    getDb(file);
    closeDb();
    const columns = getDb(file).prepare('PRAGMA table_info(clips)').all() as Array<{
      name: string;
    }>;
    const names = columns.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('format');
  });

  it('registrar o MESMO Short de novo atualiza a linha (não duplica)', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-1', {
      isShorts: true,
      format: 'shorts',
      durationSec: 43.2,
    });
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-2', {
      isShorts: true,
      format: 'shorts',
      durationSec: 45.1,
    });
    const rows = getDb(file)
      .prepare('SELECT id, youtube_video_id, duration_sec FROM clips WHERE ace_id=?')
      .all(aceId) as Array<{ id: number; youtube_video_id: string; duration_sec: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].youtube_video_id).toBe('vid-2');
    expect(rows[0].duration_sec).toBeCloseTo(45.1, 1);
  });

  it('o clipe 16:9 e o Short do mesmo ace são linhas diferentes', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-long');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-short', {
      isShorts: true,
      format: 'shorts',
    });
    const rows = getDb(file).prepare('SELECT id FROM clips WHERE ace_id=?').all(aceId);
    expect(rows.length).toBe(2);
  });

  it('getAceId acha o ace pelo UNIQUE (match|map|round|player)', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    expect(getAceId(file, '2399958', 'Inferno', 12, 'doc', 'br')).toBe(aceId);
    expect(getAceId(file, '2399958', 'Inferno', 13, 'doc', 'br')).toBeNull();
  });

  it('re-registrar sem id NÃO apaga o youtube_video_id já publicado', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-publicado');
    // Re-registro sem id (o clipe foi regravado): o id publicado tem que
    // sobreviver, senão o bot "esquece" o vídeo que já subiu e reenvia.
    insertClip(file, aceId, 'data/clips/doc-recortado.mp4', 'private');
    const row = getDb(file)
      .prepare('SELECT youtube_video_id, file_path FROM clips WHERE ace_id=?')
      .get(aceId) as { youtube_video_id: string | null; file_path: string };
    expect(row.youtube_video_id).toBe('vid-publicado');
    expect(row.file_path).toBe('data/clips/doc-recortado.mp4');
  });

  it('o clipe do VOD (format "vod") não sobrescreve o clipe do bot (format vazio)', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-bot');
    insertClip(file, aceId, 'data/clips-vod/doc.mp4', 'private', 'vid-vod', { format: 'vod' });
    const rows = getDb(file)
      .prepare('SELECT file_path, youtube_video_id, format FROM clips WHERE ace_id=? ORDER BY id')
      .all(aceId) as Array<{ file_path: string; youtube_video_id: string; format: string | null }>;
    expect(rows.length).toBe(2);
    expect(rows[0].youtube_video_id).toBe('vid-bot');
    expect(rows[1].youtube_video_id).toBe('vid-vod');
    expect(rows[1].format).toBe('vod');
  });

  it('o índice único impede duas linhas do mesmo ace e formato', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-1', {
      format: 'shorts',
      isShorts: true,
    });
    // Corrida com outro processo: o INSERT bate no índice e vira UPDATE.
    insertClip(file, aceId, 'data/shorts/doc/short2.mp4', 'unlisted', 'vid-2', {
      format: 'shorts',
      isShorts: true,
    });
    const rows = getDb(file)
      .prepare("SELECT id FROM clips WHERE ace_id=? AND COALESCE(format, '')=?")
      .all(aceId, 'shorts');
    expect(rows.length).toBe(1);
  });
});

describe('cota: contagem de publicações do dia', () => {
  it('conta o upload entre 00:00Z e a meia-noite do Pacífico', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    // 2026-11-14T00:30Z = 13/11 16:30 em Los Angeles: é o dia ANTERIOR
    // no Pacífico, então NÃO conta no dia do Pacífico de 14/11.
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-ontem', {
      publishedAt: '2026-11-14T00:30:00.000Z',
    });
    // 2026-11-14T20:00Z = 14/11 12:00 em Los Angeles: conta.
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'private', 'vid-hoje', {
      format: 'shorts',
      publishedAt: '2026-11-14T20:00:00.000Z',
    });
    // Início do dia do Pacífico (14/11 00:00 local = 14/11 08:00Z).
    const inicioPacifico = '2026-11-14 08:00:00';
    expect(countPublishedClips(file, inicioPacifico, 'br')).toBe(1);
    // No dia UTC (14/11 00:00Z), as duas contariam.
    expect(countPublishedClips(file, '2026-11-14 00:00:00', 'br')).toBe(2);
  });

  it('o ISO com "T" e o created_at com espaço são comparados como data', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    // `published_at` ISO com T: comparação por texto ('T' > ' ') contava
    // errado no dia da fronteira.
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-iso', {
      publishedAt: '2026-11-14T09:00:00.000Z',
    });
    expect(countPublishedClips(file, '2026-11-14 08:00:00', 'br')).toBe(1);
    expect(countPublishedClips(file, '2026-11-14 10:00:00', 'br')).toBe(0);
  });

  it('clip sem published_at conta pelo created_at', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce(), 'br');
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-sem-data');
    const db = getDb(file);
    db.prepare("UPDATE clips SET created_at='2026-11-14 12:00:00' WHERE youtube_video_id=?")
      .run('vid-sem-data');
    expect(countPublishedClips(file, '2026-11-14 08:00:00', 'br')).toBe(1);
  });

  it('reserva vagas atomicamente e preserva o espaço para dois uploads manuais', () => {
    const file = tmpDb();
    const first = reserveYouTubeUpload(file, '2026-11-14 08:00:00', '2026-11-14 08:00:00', 'br', 4, 2);
    const second = reserveYouTubeUpload(file, '2026-11-14 08:00:00', '2026-11-14 08:00:00', 'br', 4, 2);
    const third = reserveYouTubeUpload(file, '2026-11-14 08:00:00', '2026-11-14 08:00:00', 'br', 4, 2);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);

    if (first.allowed) {
      releaseYouTubeUploadReservation(file, first.reservationId);
    }
    expect(
      reserveYouTubeUpload(file, '2026-11-14 08:00:00', '2026-11-14 08:00:00', 'br', 4, 2).allowed,
    ).toBe(true);
  });
});

describe('banco multi-canal: migração e isolamento', () => {
  /** Banco da versão single-tenant: sem `channel_id` e com o UNIQUE antigo. */
  function legacyDb(file: string): void {
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE ace_events (
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
      CREATE TABLE clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ace_id INTEGER NOT NULL REFERENCES ace_events(id),
        file_path TEXT NOT NULL,
        youtube_video_id TEXT,
        privacy TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE discarded_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        map TEXT NOT NULL,
        round INTEGER NOT NULL,
        player TEXT NOT NULL,
        reason TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        discarded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO ace_events (id, match_id, map, round, player, team1, team2, event, detected_at)
        VALUES (7, '2399958', 'Inferno', 12, 'doc', 'A', 'B', 'Evento', '2026-10-31T21:32:27.875Z');
      INSERT INTO clips (ace_id, file_path, privacy) VALUES (7, 'data/clips/doc.mp4', 'private');
    `);
    raw.close();
  }

  it('reconstrói ace_events antigo, preserva ids e marca tudo como br', () => {
    const file = tmpDb();
    legacyDb(file);

    const db = getDb(file);
    const ace = db.prepare('SELECT * FROM ace_events WHERE id=7').get() as {
      id: number;
      channel_id: string;
      match_id: string;
    };
    expect(ace.id).toBe(7);
    expect(ace.channel_id).toBe('br');
    expect(ace.match_id).toBe('2399958');
    // O clipe continua apontando para o mesmo ace.
    const clip = db.prepare('SELECT ace_id, channel_id FROM clips WHERE ace_id=7').get() as {
      ace_id: number;
      channel_id: string;
    };
    expect(clip.ace_id).toBe(7);
    expect(clip.channel_id).toBe('br');
    // discarded_events ganhou a coluna com default br.
    const cols = (db.prepare('PRAGMA table_info(discarded_events)').all() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(cols).toContain('channel_id');
  });

  it('o mesmo ace em canais diferentes são linhas separadas', () => {
    const file = tmpDb();
    const brId = insertAce(file, makeAce(), 'br');
    const enId = insertAce(file, makeAce({ channelId: 'en' }), 'en');
    expect(enId).not.toBe(brId);
    expect(hasAce(file, '2399958', 'Inferno', 12, 'doc', 'br')).toBe(true);
    expect(hasAce(file, '2399958', 'Inferno', 12, 'doc', 'en')).toBe(true);
    expect(hasAce(file, '2399958', 'Inferno', 12, 'doc', 'es')).toBe(false);
    expect(getAceId(file, '2399958', 'Inferno', 12, 'doc', 'en')).toBe(enId);
    expect(getAceId(file, '2399958', 'Inferno', 12, 'doc', 'br')).toBe(brId);
  });

  it('cota e Shorts publicados são contados por canal', () => {
    const file = tmpDb();
    const brAce = insertAce(file, makeAce(), 'br');
    const enAce = insertAce(file, makeAce({ channelId: 'en' }), 'en');
    insertClip(file, brAce, 'data/clips/doc.mp4', 'private', 'vid-br', {
      publishedAt: '2026-11-14T20:00:00.000Z',
    });
    insertClip(file, enAce, 'data/clips-en/doc.mp4', 'unlisted', 'vid-en', {
      publishedAt: '2026-11-14T20:00:00.000Z',
    });
    insertClip(file, enAce, 'data/shorts-en/doc.mp4', 'unlisted', 'vid-en-short', {
      format: 'shorts',
      isShorts: true,
    });
    const since = '2026-11-14 08:00:00';
    expect(countPublishedClips(file, since, 'br')).toBe(1);
    expect(countPublishedClips(file, since, 'en')).toBe(2);
    expect(findPublishedShorts(file, 'br').size).toBe(0);
    expect(findPublishedShorts(file, 'en').get(aceKey('2399958', 'Inferno', 12, 'doc'))).toBe(
      'vid-en-short',
    );
  });

  it('o clipe herda o canal do ace (não há como registrar EN como BR)', () => {
    const file = tmpDb();
    const enAce = insertAce(file, makeAce({ channelId: 'en' }), 'en');
    insertClip(file, enAce, 'data/clips-en/doc.mp4', 'unlisted', 'vid-en');
    const row = getDb(file)
      .prepare('SELECT channel_id FROM clips WHERE ace_id=?')
      .get(enAce) as { channel_id: string };
    expect(row.channel_id).toBe('en');
    // Re-registrar o mesmo clipe (UPDATE) não troca o canal.
    insertClip(file, enAce, 'data/clips-en/doc.mp4', 'unlisted');
    const again = getDb(file)
      .prepare('SELECT channel_id FROM clips WHERE ace_id=?')
      .get(enAce) as { channel_id: string };
    expect(again.channel_id).toBe('en');
  });

  it('clipe sem ace correspondente é erro (não grava no BR)', () => {
    const file = tmpDb();
    expect(() => insertClip(file, 999, 'data/clips/doc.mp4', 'private')).toThrow(
      /ace 999 não existe/,
    );
  });

  it('o descarte registra o canal do ace', () => {
    const file = tmpDb();
    const enAce = insertAce(file, makeAce({ channelId: 'en' }), 'en');
    discardAce(file, enAce, {
      matchId: '2399958',
      map: 'Inferno',
      round: 12,
      player: 'doc',
      reason: 'sem footage',
    });
    const row = getDb(file)
      .prepare('SELECT channel_id FROM discarded_events WHERE match_id=?')
      .get('2399958') as { channel_id: string };
    expect(row.channel_id).toBe('en');
    expect(hasAce(file, '2399958', 'Inferno', 12, 'doc', 'en')).toBe(false);
  });

  it('recordDiscardedEvent grava o canal pedido', () => {
    const file = tmpDb();
    recordDiscardedEvent(
      file,
      { matchId: '1', map: 'Dust2', round: 3, player: 'x', reason: 'fantasma' },
      'en',
    );
    const row = getDb(file)
      .prepare('SELECT channel_id FROM discarded_events WHERE match_id=?')
      .get('1') as { channel_id: string };
    expect(row.channel_id).toBe('en');
  });

  it('canal inválido é erro de escrita (não cai no br em silêncio)', () => {
    const file = tmpDb();
    expect(() => insertAce(file, makeAce(), 'EN!')).toThrow(/canal inválido/);
  });

  it('o canal do ace e o canal da escrita precisam ser o mesmo', () => {
    const file = tmpDb();
    expect(() => insertAce(file, makeAce({ channelId: 'en' }), 'br')).toThrow(
      /canal do ace.*não confere/,
    );
  });

  it('descarte de ace inexistente não cai no canal default', () => {
    const file = tmpDb();
    expect(() =>
      discardAce(file, 999, {
        matchId: '1',
        map: 'Dust2',
        round: 1,
        player: 'x',
        reason: 'sem footage',
      }),
    ).toThrow(/ace 999 não existe/);
  });

  it('insertAce devolve o id do ace EXISTENTE quando o evento repete', () => {
    const file = tmpDb();
    const first = insertAce(file, makeAce(), 'br');
    const other = insertAce(file, makeAce({ round: 13 }), 'br');
    // Repete o primeiro: o id tem que ser o do PRIMEIRO, não o do último
    // insert da conexão (`lastInsertRowid` ficaria velho no INSERT OR IGNORE).
    expect(insertAce(file, makeAce(), 'br')).toBe(first);
    expect(first).not.toBe(other);
  });

  it('a migração cria o backup antes do rebuild (o .bak é a volta)', () => {
    const file = tmpDb();
    legacyDb(file);
    getDb(file);
    const backup = `${file}.pre-channel.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    // O backup tem o schema ANTIGO (sem `channel_id`): é o estado de volta.
    const old = new Database(backup, { readonly: true });
    const cols = (
      old.prepare('PRAGMA table_info(ace_events)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    const rows = old.prepare('SELECT COUNT(*) AS n FROM ace_events').get() as { n: number };
    old.close();
    expect(cols).not.toContain('channel_id');
    expect(rows.n).toBe(1);
  });

  it('migração falha: nada de conexão quebrada em cache nem handle aberto', () => {
    const file = tmpDb();
    legacyDb(file);
    // "Backup" que não é arquivo: a migração aborta (fail-closed) ANTES
    // de reescrever qualquer tabela.
    fs.mkdirSync(`${file}.pre-channel.bak`);
    expect(() => getDb(file)).toThrow(/backup/);
    // A segunda chamada falha do mesmo jeito: não devolve handle cacheado
    // com o schema velho (senão todo INSERT quebrava com "no such column").
    expect(() => getDb(file)).toThrow(/backup/);
    // O handle não ficou aberto (no Windows, arquivo aberto não apaga).
    fs.rmSync(`${file}.pre-channel.bak`, { recursive: true, force: true });
    expect(fs.existsSync(`${file}.pre-channel.bak`)).toBe(false);
  });
});
