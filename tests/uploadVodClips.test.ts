import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../src/db.js';
import { findVodClip, registerVodClip } from '../scripts/upload-vod-clips.js';
import type { AceEvent } from '../src/types.js';

const tempDirs: string[] = [];

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'bot.sqlite');
}

function makeAce(): AceEvent {
  return {
    channelId: 'br',
    matchId: '2399958',
    map: 'Inferno',
    round: 12,
    player: 'doc',
    team1: 'Gamers Club',
    team2: 'RED Canids',
    event: 'Gamers Club Masters VII',
    detectedAt: '2026-10-31T21:32:27.875Z',
    kills: [],
  };
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('registro dos clipes VOD', () => {
  it('cria o ace e o clipe VOD quando o sidecar já tem youtubeId', () => {
    const file = tmpDb();
    const ace = makeAce();
    const publishedAt = '2026-11-01T12:00:00.000Z';

    registerVodClip(file, ace, 'data/clips-vod/2399958.mp4', 'private', 'vid-vod', {
      publishedAt,
    });

    const aceRow = getDb(file)
      .prepare('SELECT channel_id FROM ace_events WHERE match_id=?')
      .get(ace.matchId) as { channel_id: string };
    const clipRow = getDb(file)
      .prepare(
        `SELECT channel_id, file_path, youtube_video_id, format, published_at
         FROM clips WHERE youtube_video_id=?`,
      )
      .get('vid-vod') as {
      channel_id: string;
      file_path: string;
      youtube_video_id: string;
      format: string;
      published_at: string;
    };

    expect(aceRow.channel_id).toBe('br');
    expect(clipRow).toMatchObject({
      channel_id: 'br',
      file_path: 'data/clips-vod/2399958.mp4',
      youtube_video_id: 'vid-vod',
      format: 'vod',
      published_at: publishedAt,
    });
    expect(findVodClip(file, ace)).toMatchObject({
      youtubeVideoId: 'vid-vod',
      filePath: 'data/clips-vod/2399958.mp4',
    });
  });

  it('reconcilia o mesmo vídeo sem criar uma segunda linha', () => {
    const file = tmpDb();
    const ace = makeAce();

    registerVodClip(file, ace, 'data/clips-vod/2399958.mp4', 'private', 'vid-vod', {
      title: '5K DO DOC',
      publishedAt: '2026-11-01T12:00:00.000Z',
    });
    registerVodClip(file, ace, 'data/clips-vod/2399958.mp4', 'private', 'vid-vod');

    const row = getDb(file)
      .prepare(
        `SELECT COUNT(*) AS n FROM clips
         WHERE youtube_video_id=? AND COALESCE(format, '')=?`,
      )
      .get('vid-vod', 'vod') as { n: number };
    const clip = getDb(file)
      .prepare('SELECT title, published_at FROM clips WHERE youtube_video_id=?')
      .get('vid-vod') as { title: string; published_at: string };

    expect(row.n).toBe(1);
    expect(clip).toEqual({ title: '5K DO DOC', published_at: '2026-11-01T12:00:00.000Z' });
  });

  it('recusa trocar o youtubeId já registrado', () => {
    const file = tmpDb();
    const ace = makeAce();
    registerVodClip(file, ace, 'data/clips-vod/2399958.mp4', 'private', 'vid-1');

    expect(() =>
      registerVodClip(file, ace, 'data/clips-vod/2399958.mp4', 'private', 'vid-2'),
    ).toThrow(/não confere/);
  });
});
