import { describe, expect, it } from 'vitest';
import { explainMatchLog, formatExplain, type ExplainLogLine } from '../src/diag/explainLog.js';

const T = 1_700_000_000_000;

function line(extra: Partial<ExplainLogLine>): ExplainLogLine {
  return { time: T, ...extra };
}

describe('explainMatchLog', () => {
  it('monta a política resolvida e o candidato de cada round', () => {
    const lines: ExplainLogLine[] = [
      line({ msg: 'live matches filtradas', live: 3, kept: 2, minStars: 2 }),
      line({
        msg: 'iniciando tracker de multikill',
        matchId: '2400208',
        stars: 0,
        minKills: 5,
        passaGeral: false,
        watchlisted: true,
        teams: 'Imperial',
      }),
      line({
        msg: 'round fechado sem multikill',
        matchId: '2400208',
        map: 'Mirage',
        round: 4,
        score: '3-1',
        bestPlayer: 'donk',
        bestKills: 4,
        required: 5,
        blocked: false,
      }),
      line({ msg: 'multikill detectado', matchId: '2400208', player: 'sh1ro', kills: 5, map: 'Mirage', round: 6 }),
      line({ msg: 'round fechado sem multikill', matchId: 'OUTRA', map: 'Mirage', round: 9 }),
    ];

    const result = explainMatchLog(lines, '2400208');
    expect(result.policy).toEqual({
      stars: 0,
      minKills: 5,
      passesGeneral: false,
      watchlisted: true,
      teams: ['Imperial'],
      rankTeams: [],
      rankOnly: null,
      rankRanks: null,
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({
      map: 'Mirage',
      round: 4,
      score: '3-1',
      bestPlayer: 'donk',
      bestKills: 4,
      required: 5,
      blocked: false,
      multikill: null,
    });
    expect(result.rounds[1]).toMatchObject({
      round: 6,
      multikill: { player: 'sh1ro', kills: 5 },
    });
  });

  it('guarda o motivo do descarte e o bloqueio do adversário', () => {
    const lines: ExplainLogLine[] = [
      line({ msg: 'iniciando tracker de multikill', matchId: '1', stars: 2, minKills: 4, passaGeral: true }),
      line({
        msg: 'round fechado sem multikill',
        matchId: '1',
        map: 'Nuke',
        round: 2,
        score: '1-0',
        bestPlayer: 'adversario',
        bestKills: 3,
        required: null,
        blocked: true,
      }),
      line({
        msg: 'multikill descartado',
        matchId: '1',
        map: 'Nuke',
        round: 5,
        dropped: 'kills de rounds diferentes',
      }),
    ];
    const result = explainMatchLog(lines, '1');
    expect(result.rounds[0]).toMatchObject({ blocked: true, required: null });
    expect(result.rounds[1]).toMatchObject({ dropped: 'kills de rounds diferentes' });
  });

  it('partida sem registro no log devolve política nula', () => {
    const result = explainMatchLog([], '999');
    expect(result.policy).toBeNull();
    expect(result.rounds).toEqual([]);
    expect(formatExplain(result)).toContain('sem registro no log');
  });

  it('mostra a regra de rank: times liberados, ranks e "entrou só pelo rank"', () => {
    const lines: ExplainLogLine[] = [
      line({
        msg: 'iniciando tracker de multikill',
        matchId: '2400445',
        stars: 1,
        minKills: 4,
        passaGeral: false,
        watchlisted: false,
        rank: 'BIG, Ninjas in Pyjamas',
        times: '34 x 18',
        rankOnly: true,
      }),
    ];
    const text = formatExplain(explainMatchLog(lines, '2400445'));
    expect(text).toContain('limiar 4k');
    expect(text).toContain('rank [34 x 18] (BIG, Ninjas in Pyjamas)');
    expect(text).toContain('entrou só pelo rank');
  });
});

describe('formatExplain', () => {
  it('resume política, rounds e o quanto faltou', () => {
    const lines: ExplainLogLine[] = [
      line({
        msg: 'iniciando tracker de multikill',
        matchId: '2400208',
        stars: 0,
        minKills: 5,
        passaGeral: false,
        watchlisted: true,
        teams: ['Imperial'],
      }),
      line({
        msg: 'round fechado sem multikill',
        matchId: '2400208',
        map: 'Mirage',
        round: 4,
        score: '3-1',
        bestPlayer: 'donk',
        bestKills: 4,
        required: 5,
        blocked: false,
      }),
    ];
    const text = formatExplain(explainMatchLog(lines, '2400208'));
    expect(text).toContain('partida 2400208');
    expect(text).toContain('0★ · limiar 5k · NÃO passa no filtro geral');
    expect(text).toContain('override da watchlist (Imperial)');
    expect(text).toContain('Mirage r4 | 4k de donk < 5k exigidos | placar 3-1');
    expect(text).toContain('resumo: 1 round(s) · 0 multikill(s) · 0 descartado(s)');
  });
});
