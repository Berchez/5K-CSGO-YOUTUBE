import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyRankThreshold,
  buildTeamRanking,
  parseRankingCache,
  rankAllowsTeam,
  rankAllowedTeams,
  rankMatchDecision,
  rankOfTeam,
  rankStarsModeAllows,
  readRankingCache,
  writeRankingCache,
} from '../src/monitor/teamRanking.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-19T12:00:00.000Z');

describe('buildTeamRanking (parser puro da página do ranking)', () => {
  it('aceita "#18" e "18" e normaliza o nome do time', () => {
    const ranking = buildTeamRanking(
      [
        { position: '#18', name: 'Ninjas in Pyjamas' },
        { position: '34', name: 'BIG' },
        { position: '#4', name: 'Team Vitality' },
      ],
      NOW,
    );
    expect(ranking.fetchedAt).toBe(NOW);
    expect(rankOfTeam(ranking, 'Ninjas in Pyjamas')).toBe(18);
    expect(rankOfTeam(ranking, 'big')).toBe(34);
    // "Team Vitality" x "Vitality": o prefixo "team " não separa o time.
    expect(rankOfTeam(ranking, 'Vitality')).toBe(4);
  });

  it('descarta linha sem posição/nome e posição inválida', () => {
    const ranking = buildTeamRanking(
      [
        { position: '', name: 'FURIA' },
        { position: '#7', name: '' },
        { position: '#abc', name: 'Natus Vincere' },
        { position: '#0', name: 'Zero' },
        { position: '#9', name: 'FUT' },
      ],
      NOW,
    );
    expect(Object.keys(ranking.ranks)).toEqual(['fut']);
  });

  it('nome repetido mantém o MELHOR rank (fail-closed)', () => {
    const ranking = buildTeamRanking(
      [
        { position: '#40', name: 'Spirit' },
        { position: '#3', name: 'Spirit' },
      ],
      NOW,
    );
    expect(rankOfTeam(ranking, 'Spirit')).toBe(3);
  });

  it('rankOfTeam: time ausente/vazio = null (sem rank)', () => {
    const ranking = buildTeamRanking([{ position: '#1', name: 'FURIA' }], NOW);
    expect(rankOfTeam(ranking, 'MIBR')).toBeNull();
    expect(rankOfTeam(ranking, '')).toBeNull();
    expect(rankOfTeam(null, 'FURIA')).toBeNull();
  });
});

describe('rankMatchDecision (X soma / Y time forte)', () => {
  const base = { sumMax: 70, strongMax: 30 };

  it('soma abaixo de X libera os DOIS lados', () => {
    // BIG #34 + NIP #18 = 52 < 70.
    const decision = rankMatchDecision({ ...base, rank1: 34, rank2: 18 });
    expect(decision).toEqual({
      qualifies: true,
      bySum: true,
      byStrongTeam: false,
      reason: 'sum',
      allowed: 'both',
    });
  });

  it('soma IGUAL a X não passa (comparação estrita)', () => {
    const decision = rankMatchDecision({ sumMax: 70, strongMax: 0, rank1: 30, rank2: 40 });
    expect(decision.qualifies).toBe(false);
    expect(decision.reason).toBe('none');
  });

  it('soma alta mas um time abaixo de Y: entra liberando só ele', () => {
    // #18 + #60 = 78 (não passa na soma) e #18 < 30.
    const decision = rankMatchDecision({ ...base, rank1: 18, rank2: 60 });
    expect(decision).toEqual({
      qualifies: true,
      bySum: false,
      byStrongTeam: true,
      reason: 'strong-team',
      allowed: 'team1',
    });
    expect(rankAllowedTeams(decision, 'Team A', 'Team B')).toEqual(['Team A']);
  });

  it('time forte no lado 2 libera o lado 2', () => {
    const decision = rankMatchDecision({ ...base, rank1: 60, rank2: 18 });
    expect(decision.allowed).toBe('team2');
    expect(rankAllowedTeams(decision, 'Team A', 'Team B')).toEqual(['Team B']);
  });

  it('os dois abaixo de Y liberam os dois lados', () => {
    // X desligado: só a regra do time forte decide.
    const decision = rankMatchDecision({ sumMax: 0, strongMax: 30, rank1: 18, rank2: 29 });
    expect(decision.allowed).toBe('both');
    expect(rankAllowedTeams(decision, 'A', 'B')).toEqual(['A', 'B']);
  });

  it('rank desconhecido não soma nem libera (fail-closed)', () => {
    expect(rankMatchDecision({ ...base, rank1: 18, rank2: null }).qualifies).toBe(false);
    expect(rankMatchDecision({ ...base, rank1: null, rank2: null }).qualifies).toBe(false);
  });

  it('X e Y em 0 = regra desligada', () => {
    expect(rankMatchDecision({ sumMax: 0, strongMax: 0, rank1: 1, rank2: 2 })).toEqual({
      qualifies: false,
      bySum: false,
      byStrongTeam: false,
      reason: 'none',
      allowed: null,
    });
  });

  it('rankAllowedTeams de decisão que não entrou = vazio', () => {
    const decision = rankMatchDecision({ sumMax: 10, strongMax: 0, rank1: 40, rank2: 50 });
    expect(rankAllowedTeams(decision, 'A', 'B')).toEqual([]);
  });
});

describe('rankAllowsTeam (lado do killer)', () => {
  it('casa pelo nome normalizado (placar x listing)', () => {
    expect(rankAllowsTeam(['FURIA'], 'Furia')).toBe(true);
    expect(rankAllowsTeam(['Team Vitality'], 'Vitality')).toBe(true);
    expect(rankAllowsTeam(['FURIA'], 'MIBR')).toBe(false);
    expect(rankAllowsTeam([], 'FURIA')).toBe(false);
    expect(rankAllowsTeam(['FURIA'], null)).toBe(false);
  });
});

describe('rankStarsModeAllows (estrelas PRÓPRIAS da regra de rank)', () => {
  it('any: vale para qualquer avaliação, inclusive a que o geral aceitou', () => {
    expect(rankStarsModeAllows('any', true)).toBe(true);
    expect(rankStarsModeAllows('any', false)).toBe(true);
  });

  it('below-general: só quando o filtro geral de estrelas RECUSOU a partida', () => {
    expect(rankStarsModeAllows('below-general', true)).toBe(false);
    expect(rankStarsModeAllows('below-general', false)).toBe(true);
  });

  it('ausente cai no default below-general (o rank é o plano B)', () => {
    expect(rankStarsModeAllows(undefined, true)).toBe(false);
    expect(rankStarsModeAllows(undefined, false)).toBe(true);
    expect(rankStarsModeAllows(null, true)).toBe(false);
    expect(rankStarsModeAllows(null, false)).toBe(true);
  });
});

describe('applyRankThreshold (a condição de rank atravessa as estrelas)', () => {
  const rank = { minKills: 4, allowedTeams: ['BIG', 'Ninjas in Pyjamas'] };

  it('time liberado + política geral mais dura: o rank vence (4k)', () => {
    // Partida de 2★ que passa por estrelas: o geral exigiria 5k, mas o rank
    // atendido libera 4k.
    expect(
      applyRankThreshold({
        base: { minKills: 5, source: 'general' },
        rank,
        team: 'BIG',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: 4, source: 'rank' });
  });

  it('time liberado + política já mais permissiva: a política vence (o rank não piora)', () => {
    expect(
      applyRankThreshold({
        base: { minKills: 3, source: 'team' },
        rank,
        team: 'BIG',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: 3, source: 'team' });
  });

  it('time liberado + partida bloqueada pela política geral: o rank abre o caminho', () => {
    expect(
      applyRankThreshold({
        base: { minKills: null, source: 'blocked' },
        rank,
        team: 'Ninjas in Pyjamas',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: 4, source: 'rank' });
  });

  it('time NÃO liberado: segue a política normal (bloqueado continua bloqueado)', () => {
    expect(
      applyRankThreshold({
        base: { minKills: null, source: 'blocked' },
        rank: { minKills: 4, allowedTeams: ['Ninjas in Pyjamas'] },
        team: 'BIG',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: null, source: 'blocked' });
  });

  it('watchlist com override ATIVO manda no bloqueio (o rank não ressuscita o adversário)', () => {
    expect(
      applyRankThreshold({
        base: { minKills: null, source: 'blocked' },
        rank,
        team: 'BIG',
        watchlistOverride: true,
      }),
    ).toEqual({ minKills: null, source: 'blocked' });
  });

  it('watchlist explícita tem precedência: o rank não rebaixa minKills do jogador/time', () => {
    expect(
      applyRankThreshold({
        base: { minKills: 5, source: 'player' },
        rank,
        team: 'BIG',
        watchlistOverride: true,
      }),
    ).toEqual({ minKills: 5, source: 'player' });
    expect(
      applyRankThreshold({
        base: { minKills: 5, source: 'team' },
        rank,
        team: 'BIG',
        watchlistOverride: true,
      }),
    ).toEqual({ minKills: 5, source: 'team' });
  });

  it('regra desligada (sem lados liberados) não muda nada', () => {
    expect(
      applyRankThreshold({
        base: { minKills: 5, source: 'general' },
        rank: null,
        team: 'BIG',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: 5, source: 'general' });
    expect(
      applyRankThreshold({
        base: { minKills: 5, source: 'general' },
        rank: { minKills: 4, allowedTeams: [] },
        team: 'BIG',
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: 5, source: 'general' });
  });

  it('time do killer desconhecido não é liberado (fail-closed)', () => {
    expect(
      applyRankThreshold({
        base: { minKills: null, source: 'blocked' },
        rank,
        team: null,
        watchlistOverride: false,
      }),
    ).toEqual({ minKills: null, source: 'blocked' });
  });
});

describe('cache do ranking em disco', () => {
  it('grava e lê de volta com idade/TTL', () => {
    const file = path.join(tmpDir(), 'team-ranking.json');
    const ranking = buildTeamRanking([{ position: '#18', name: 'Ninjas in Pyjamas' }], NOW);
    writeRankingCache(file, ranking);

    const fresh = readRankingCache(file, NOW + 3_600_000, 12 * 3_600_000);
    expect(fresh.error).toBeNull();
    expect(fresh.ranking?.ranks['ninjas in pyjamas']).toBe(18);
    expect(fresh.ageMs).toBe(3_600_000);
    expect(fresh.stale).toBe(false);

    const stale = readRankingCache(file, NOW + 13 * 3_600_000, 12 * 3_600_000);
    expect(stale.stale).toBe(true);
    expect(stale.ranking?.ranks['ninjas in pyjamas']).toBe(18);
  });

  it('arquivo ausente não é erro; JSON inválido é', () => {
    const dir = tmpDir();
    const missing = readRankingCache(path.join(dir, 'nope.json'), NOW, 3_600_000);
    expect(missing).toEqual({ ranking: null, ageMs: null, stale: false, error: null });

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{oops', 'utf8');
    const read = readRankingCache(broken, NOW, 3_600_000);
    expect(read.ranking).toBeNull();
    expect(read.error).not.toBeNull();
  });

  it('parseRankingCache rejeita formato sem ranks/fetchedAt', () => {
    expect(parseRankingCache(null)).toBeNull();
    expect(parseRankingCache({ fetchedAt: NOW, ranks: {} })).toBeNull();
    expect(parseRankingCache({ ranks: { furia: 1 } })).toBeNull();
    expect(parseRankingCache({ fetchedAt: NOW, ranks: { '#1 FURIA': 0 } })).toBeNull();
    expect(parseRankingCache({ fetchedAt: NOW, ranks: { FURIA: 1 } })).toEqual({
      fetchedAt: NOW,
      ranks: { furia: 1 },
    });
  });
});

import { ensureTeamRanking, resetTeamRankingCache } from '../src/monitor/hltvMonitor.js';

describe('ensureTeamRanking (stale-while-revalidate e limites de cache)', () => {
  it('desligado (enabled=false) devolve null e não toca em disco nem rede', async () => {
    resetTeamRankingCache();
    const res = await ensureTeamRanking({
      enabled: false,
      url: 'https://example.com',
      cacheFile: 'nao-existe.json',
      ttlMs: 3600_000,
    });
    expect(res).toBeNull();
  });

  it('cache em disco dentro do TTL é devolvido imediatamente', async () => {
    resetTeamRankingCache();
    const dir = tmpDir();
    const file = path.join(dir, 'ranking.json');
    writeRankingCache(file, buildTeamRanking([{ position: '#1', name: 'FURIA' }], NOW));

    const res = await ensureTeamRanking({
      enabled: true,
      url: 'https://example.com',
      cacheFile: file,
      ttlMs: 3600_000,
      now: NOW + 1800_000, // 30 min depois (dentro de 1h)
    });
    expect(res?.ranks['furia']).toBe(1);
  });

  it('cache vencido (>14 dias) é descartado por segurança (fail-closed)', async () => {
    resetTeamRankingCache();
    const dir = tmpDir();
    const file = path.join(dir, 'ranking-antigo.json');
    writeRankingCache(file, buildTeamRanking([{ position: '#1', name: 'FURIA' }], NOW));

    // Fetch injetado: teste puro (sem Playwright/rede). O refresh é disparado,
    // mas não há cache aceitável para devolver.
    let refreshes = 0;
    const res = await ensureTeamRanking({
      enabled: true,
      url: 'https://example.com',
      cacheFile: file,
      ttlMs: 3600_000,
      maxStaleMs: 7 * 86_400_000,
      now: NOW + 15 * 86_400_000, // 15 dias depois (ultrapassa 7 dias)
      fetchRanking: async () => {
        refreshes += 1;
        return null;
      },
    });
    expect(res).toBeNull();
    expect(refreshes).toBe(1);
  });
});
