import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aceKey,
  closeDb,
  findPublishedShorts,
  getAceId,
  getDb,
  insertAce,
  insertClip,
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
  return {
    matchId: '2399958',
    map: 'Inferno',
    round: 12,
    player: 'doc',
    team1: 'Gamers Club',
    team2: 'RED Canids',
    event: 'Gamers Club Masters VII',
    detectedAt: '2026-10-31T21:32:27.875Z',
    kills: [],
    ...overrides,
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
    const aceId = insertAce(file, makeAce());
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
    const aceId = insertAce(file, makeAce());
    insertClip(file, aceId, 'data/clips/doc.mp4', 'private', 'vid-long');
    insertClip(file, aceId, 'data/shorts/doc/short.mp4', 'unlisted', 'vid-short', {
      isShorts: true,
      format: 'shorts',
    });
    const published = findPublishedShorts(file);
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
    const aceId = insertAce(file, makeAce());
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
    const aceId = insertAce(file, makeAce());
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
    const aceId = insertAce(file, makeAce());
    expect(getAceId(file, '2399958', 'Inferno', 12, 'doc')).toBe(aceId);
    expect(getAceId(file, '2399958', 'Inferno', 13, 'doc')).toBeNull();
  });

  it('re-registrar sem id NÃO apaga o youtube_video_id já publicado', () => {
    const file = tmpDb();
    const aceId = insertAce(file, makeAce());
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
    const aceId = insertAce(file, makeAce());
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
    const aceId = insertAce(file, makeAce());
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
