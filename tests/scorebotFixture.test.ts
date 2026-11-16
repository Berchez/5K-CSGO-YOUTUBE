import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScorebotLog, type ScorebotKill } from '../src/detector/scorebotLog.js';
import { enrichKillsWithFeed, selectFeedKills } from '../src/detector/killfeedEnrich.js';

/**
 * FIXTURE REAL: o replay do killfeed do scorebot da partida 2400205
 * (BLAST Rivals 2026 Season 2 — G2 vs Falcons).
 *
 * O caso que o fixture trava: no Anubis r13, o kyousuke fez 5 kills e o
 * PLACAR pareou a 4ª vítima errada (TeSeS — o HeavyGod tinha matado o
 * TeSeS um instante antes). O scorebot tem a verdade: HeavyGod, de
 * Glock, headshot, com assistência do m0NESY em duas das kills.
 */
const FIXTURE = path.resolve('tests/fixtures/scorebot-2400205.json');

interface Fixture {
  matchId: string;
  items: unknown[];
}

function loadFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;
}

/** O replay do scorebot (vem do mais novo para o mais antigo). */
function parseReplay(): ScorebotKill[] {
  const fixture = loadFixture();
  return parseScorebotLog(fixture.items, { reverse: true, replay: true });
}

describe('fixture real do scorebot (match 2400205)', () => {
  it('a fixture tem o replay da partida', () => {
    const fixture = loadFixture();
    expect(fixture.matchId).toBe('2400205');
    expect(fixture.items.length).toBeGreaterThan(100);
  });

  it('acha as 5 kills do kyousuke no Anubis r13 (o caso real)', () => {
    const kills = parseReplay();
    const selected = selectFeedKills({
      kills,
      map: 'anubis',
      round: 13,
      player: 'kyousuke',
    });
    expect(selected).toHaveLength(5);
    expect(selected.map((k) => k.victim)).toEqual([
      'r1nkle',
      'NertZ',
      'huNter-',
      'HeavyGod',
      'MATYS',
    ]);
    // Todas de Glock, todas headshot.
    expect(selected.every((k) => k.weapon === 'glock')).toBe(true);
    expect(selected.every((k) => k.headshot === true)).toBe(true);
  });

  it('a assistência do m0NESY vem no evento separado (Assist)', () => {
    const kills = parseReplay();
    const selected = selectFeedKills({
      kills,
      map: 'anubis',
      round: 13,
      player: 'kyousuke',
    });
    const withAssist = selected.filter((k) => k.assistBy === 'm0NESY');
    expect(withAssist.map((k) => k.victim)).toEqual(['huNter-', 'MATYS']);
  });

  it('o round 13 do Anubis tem as mortes dos OUTROS jogadores (o ruído do placar)', () => {
    const kills = parseReplay();
    const doRound = kills.filter((k) => k.map === 'anubis' && k.round === 13);
    // O placar lê a coluna de mortes: o HeavyGod matou o TeSeS no mesmo
    // round — é isso que fazia o pareamento sair errado.
    expect(doRound.some((k) => k.killer === 'HeavyGod' && k.victim === 'TeSeS')).toBe(true);
    expect(doRound.some((k) => k.killer === 'r1nkle')).toBe(true);
  });

  it('corrige a vítima errada do sidecar e completa o detalhe', () => {
    const kills = parseReplay();
    const selected = selectFeedKills({
      kills,
      map: 'anubis',
      round: 13,
      player: 'kyousuke',
    });
    // O sidecar gravado (com a vítima errada e sem arma/HS/assistência).
    const sideKills = [
      { killer: 'kyousuke', victim: 'r1nkle' },
      { killer: 'kyousuke', victim: 'NertZ' },
      { killer: 'kyousuke', victim: 'huNter-' },
      { killer: 'kyousuke', victim: 'TeSeS' },
      { killer: 'kyousuke', victim: 'MATYS' },
    ];
    const result = enrichKillsWithFeed(sideKills, selected);
    expect(result.kills.map((k) => k.victim)).toEqual([
      'r1nkle',
      'NertZ',
      'huNter-',
      'HeavyGod',
      'MATYS',
    ]);
    expect(result.kills.every((k) => k.weapon === 'glock')).toBe(true);
    expect(result.kills.every((k) => k.headshot === true)).toBe(true);
    expect(result.kills.filter((k) => k.assistBy === 'm0NESY')).toHaveLength(2);
    expect(result.paired).toBe(5);
    expect(result.eventIds.length).toBe(5);
  });

  it('o filtro é estrito: outro jogador do mesmo round fica de fora', () => {
    const kills = parseReplay();
    const outros = selectFeedKills({
      kills,
      map: 'anubis',
      round: 13,
      player: 'r1nkle',
    });
    expect(outros.length).toBeGreaterThan(0);
    expect(outros.every((k) => k.round === 13 && k.killer === 'r1nkle')).toBe(true);
  });
});
