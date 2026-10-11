import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AceEvent } from './types.js';

let db: Database.Database | null = null;
let dbPath = '';

export function getDb(dbFile: string): Database.Database {
  if (db && dbPath === dbFile) return db;
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
  `);
  return db;
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

export function insertClip(
  dbFile: string,
  aceId: number,
  filePath: string,
  privacy: string,
  youtubeVideoId?: string,
): void {
  getDb(dbFile)
    .prepare(
      'INSERT INTO clips (ace_id, file_path, youtube_video_id, privacy) VALUES (?, ?, ?, ?)',
    )
    .run(aceId, filePath, youtubeVideoId ?? null, privacy);
}
