import { describe, expect, it } from 'vitest';
import {
  applyKillfeedToSidecar,
  buildClipSidecar,
  normalizeClipSidecar,
  sidecarToAce,
} from '../src/clipper/sidecar.js';

const CLIP_START_MS = 1_794_577_737_066;

/**
 * O sidecar REAL do kyousuke no Anubis r13 (match 2400205): o placar
 * pareou a 4ª vítima errada (TeSeS) e o killfeed não tinha chegado
 * (arma/headshot/assistência nulos).
 */
function sidecarReal(): ReturnType<typeof normalizeClipSidecar> {
  return normalizeClipSidecar({
    schemaVersion: 2,
    kind: 'clip',
    createdAt: '2026-11-13T13:53:31.919Z',
    detectedAt: '2026-11-13T13:49:55.432Z',
    match: { id: '2400205', event: 'BLAST Rivals 2026 Season 2', team1: 'G2', team2: 'Falcons' },
    player: { name: 'kyousuke', team: 'Falcons', opponent: 'G2' },
    round: { map: 'Anubis', number: 13, scoreBefore: '6-6', scoreAfter: '6-7' },
    clip: {
      file: '2400205_Anubis_r13_kyousuke.mp4',
      startMs: CLIP_START_MS,
      durationSec: 79.37,
    },
    kills: [
      { killer: 'kyousuke', victim: 'r1nkle', atMs: 1794577749309, videoSec: 16.063 },
      { killer: 'kyousuke', victim: 'NertZ', atMs: 1794577752317, videoSec: 19.071 },
      { killer: 'kyousuke', victim: 'huNter-', atMs: 1794577755326, videoSec: 22.08 },
      { killer: 'kyousuke', victim: 'TeSeS', atMs: 1794577782407, videoSec: 49.161 },
      { killer: 'kyousuke', victim: 'MATYS', atMs: 1794577795432, videoSec: 62.186 },
    ],
    stats: { killCount: 5, weapons: [null, null, null, null, null], victims: [], assists: [] },
  });
}

const ENRICHMENT = {
  kills: [
    { victim: 'r1nkle', weapon: 'glock', headshot: true },
    { victim: 'NertZ', weapon: 'glock', headshot: true },
    { victim: 'huNter-', weapon: 'glock', headshot: true, assistBy: 'm0NESY' },
    { victim: 'HeavyGod', weapon: 'glock', headshot: true },
    { victim: 'MATYS', weapon: 'glock', headshot: true, assistBy: 'm0NESY' },
  ],
  paired: 5,
  feedKills: 5,
  eventIds: ['1', '2', '3', '4', '5'],
};

describe('sidecar: bloco do killfeed', () => {
  it('um sidecar sem killfeed normaliza com o bloco null', () => {
    const side = sidecarReal();
    expect(side.killfeed).toBeNull();
  });

  it('o backfill corrige a vítima e completa arma/headshot/assistência', () => {
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(side, ENRICHMENT, '2026-11-14T00:00:00.000Z');
    expect(updated.kills.map((k) => k.victim)).toEqual([
      'r1nkle',
      'NertZ',
      'huNter-',
      'HeavyGod',
      'MATYS',
    ]);
    expect(updated.kills.every((k) => k.weapon === 'glock')).toBe(true);
    expect(updated.kills.every((k) => k.headshot === true)).toBe(true);
    expect(updated.kills[2].assistBy).toBe('m0NESY');
    expect(updated.kills[4].assistBy).toBe('m0NESY');
  });

  it('preserva o instante/posição da kill (o feed não tem tempo)', () => {
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(side, ENRICHMENT, '2026-11-14T00:00:00.000Z');
    expect(updated.kills[3].atMs).toBe(1794577782407);
    expect(updated.kills[3].videoSec).toBe(49.161);
  });

  it('reescreve as stats (armas, vítimas, assistências, headshots)', () => {
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(side, ENRICHMENT, '2026-11-14T00:00:00.000Z');
    expect(updated.stats.killCount).toBe(5);
    expect(updated.stats.weapons).toEqual(['glock', 'glock', 'glock', 'glock', 'glock']);
    expect(updated.stats.victims).toEqual([
      'r1nkle',
      'NertZ',
      'huNter-',
      'HeavyGod',
      'MATYS',
    ]);
    expect(updated.stats.assists).toEqual([
      { by: 'm0NESY', killIndex: 3 },
      { by: 'm0NESY', killIndex: 5 },
    ]);
    expect(updated.stats.headshots).toBe(5);
    expect(updated.stats.mainWeapon).toBe('glock');
  });

  it('normaliza a arma do feed (o backfill grava a chave canônica)', () => {
    // O scorebot manda `m4a1_silencer`; o live grava `m4a1silencer`.
    // Sem normalizar, o enrich não era idempotente e a mesma arma
    // contava duas vezes em `mostUsedWeapon`.
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(
      side,
      {
        ...ENRICHMENT,
        kills: ENRICHMENT.kills.map((k) => ({ ...k, weapon: 'm4a1_silencer' })),
      },
      '2026-11-14T00:00:00.000Z',
    );
    expect(updated.kills[0].weapon).toBe('m4a1silencer');
    expect(updated.stats.weapons[0]).toBe('m4a1silencer');
    expect(updated.stats.mainWeapon).toBe('m4a1silencer');
  });

  it('grava a telemetria do pareamento no bloco killfeed', () => {
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(side, ENRICHMENT, '2026-11-14T00:00:00.000Z');
    expect(updated.killfeed).toEqual({
      source: 'scorebot',
      paired: 5,
      total: 5,
      feedKills: 5,
      eventIds: ['1', '2', '3', '4', '5'],
      enrichedAt: '2026-11-14T00:00:00.000Z',
    });
  });

  it('o ace reconstruído do sidecar leva a telemetria', () => {
    const side = sidecarReal();
    const updated = applyKillfeedToSidecar(side, ENRICHMENT, '2026-11-14T00:00:00.000Z');
    const ace = sidecarToAce(updated);
    expect(ace.killfeed).toEqual({
      paired: 5,
      total: 5,
      feedKills: 5,
      eventIds: ['1', '2', '3', '4', '5'],
    });
    expect(ace.summary?.victims).toContain('HeavyGod');
    expect(ace.summary?.victims).not.toContain('TeSeS');
  });

  it('campo ausente no feed não sobrescreve o que o sidecar tinha', () => {
    const side = sidecarReal();
    const partial = {
      ...ENRICHMENT,
      kills: ENRICHMENT.kills.map((k, i) => (i === 0 ? { victim: k.victim } : k)),
    };
    const updated = applyKillfeedToSidecar(side, partial, '2026-11-14T00:00:00.000Z');
    expect(updated.kills[0].weapon).toBeNull();
    expect(updated.kills[0].headshot).toBeNull();
  });

  it('o drift de round do feed fica gravado no sidecar', () => {
    // O round do feed é contado por `RoundStart` e o do placar é
    // `ct+t+1`: o contador diz quantas kills foram afetadas pelo
    // desencontro (o detalhe que faltou tem uma explicação).
    const ace = sidecarToAce(sidecarReal());
    ace.killfeed = {
      paired: 3,
      total: 5,
      feedKills: 4,
      eventIds: ['1', '2'],
      roundDrift: 2,
    };
    const side = buildClipSidecar({
      ace,
      clip: { startMs: 0, durationSec: 30 },
    });
    expect(side.killfeed?.roundDrift).toBe(2);
  });
});
