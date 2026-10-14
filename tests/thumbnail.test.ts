import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildThumbnail, thumbnailOverlay } from '../src/clipper/thumbnail.js';

const ace = {
  matchId: 'm1',
  map: 'mirage',
  round: 12,
  player: 'donk',
  team1: 'Spirit',
  team2: 'FaZe',
  event: 'ESL Pro League Season 24',
  detectedAt: new Date().toISOString(),
  kills: [],
};

describe('thumbnail', () => {
  it('gera overlay SVG válido', () => {
    const buf = thumbnailOverlay(ace);
    const s = buf.toString('utf8');
    expect(s).toContain('ACE!');
    expect(s).toContain('donk');
    expect(s).toContain('Spirit vs FaZe');
  });

  it('não decepa o nº do round em evento+mapa longos', () => {
    const buf = thumbnailOverlay({
      ...ace,
      event: 'ESL Pro League Season 24',
      map: 'EPL Playoffs',
      round: 1,
    }).toString('utf8');
    expect(buf).toContain('Round 1</text>');
  });

  it('inclui placar quando conhecido', () => {
    const buf = thumbnailOverlay({ ...ace, round: 10, score: '6-3' }).toString('utf8');
    expect(buf).toContain('Round 10 • 6-3</text>');
  });

  it('escapa HTML no texto', () => {
    const buf = thumbnailOverlay({ ...ace, player: '<img>x' }).toString('utf8');
    expect(buf).not.toContain('<img>x');
    expect(buf).toContain('&lt;img&gt;x');
  });

  it('selo dinâmico: 4K!/3K! conforme os kills (ACE! sem dado)', () => {
    const four = thumbnailOverlay({
      ...ace,
      kills: [1, 2, 3, 4].map((i) => ({ killer: 'flameZ', victim: `v${i}`, round: 3, map: 'm' })),
    }).toString('utf8');
    expect(four).toContain('4K!');
    expect(four).not.toContain('ACE!');
    const three = thumbnailOverlay({
      ...ace,
      kills: [1, 2, 3].map((i) => ({ killer: 'x', victim: `v${i}`, round: 1, map: 'm' })),
    }).toString('utf8');
    expect(three).toContain('3K!');
  });

  it('compõe 1280x720 a partir de frame qualquer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-test-'));
    const frame = path.join(dir, 'frame.jpg');
    const out = path.join(dir, 'thumb.jpg');
    await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 20, g: 40, b: 80 } },
    })
      .jpeg()
      .toFile(frame);
    await buildThumbnail(frame, out, ace);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(fs.statSync(out).size).toBeGreaterThan(10_000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
