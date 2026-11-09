import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createKillerPolicy,
  defaultWatchlistDoc,
  loadWatchlistFile,
  matchTeamAlias,
  normalizeName,
  resolveKillerMinKills,
  resolveMatchRule,
  resolvePlayerRule,
  resolveRoundPolicy,
  resolveTeamRule,
  validateWatchlistDoc,
  watchlistStarsFloorMet,
  WATCHLIST_MISSING_GRACE_MS,
} from '../src/watchlist.js';

const tmpDirs: string[] = [];

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function validDoc(input: unknown) {
  const result = validateWatchlistDoc(input);
  expect(result.ok).toBe(true);
  expect(result.value).toBeDefined();
  return result.value!;
}

describe('normalizeName', () => {
  it('ignora caixa, acentos e espaços extras', () => {
    expect(normalizeName('  FÚRIA   Esports ')).toBe('furia esports');
    expect(normalizeName('paiN Gaming')).toBe('pain gaming');
    expect(normalizeName('Legacy')).toBe('legacy');
  });
});

describe('validateWatchlistDoc', () => {
  it('preenche defaults em documento mínimo', () => {
    const doc = validDoc({ teams: [{ names: ['FURIA'] }] });
    expect(doc.enabled).toBe(true);
    expect(doc.defaults).toEqual({ minKills: 4, minStars: 0, clutch: false });
    expect(doc.teams[0].enabled).toBe(true);
    expect(doc.teams[0].names).toEqual(['FURIA']);
    expect(doc.players).toEqual([]);
  });

  it('aceita o exemplo com limiar por time (Imperial 5, Legacy 4, Fúria 3)', () => {
    const doc = validDoc({
      enabled: true,
      defaults: { minKills: 4 },
      teams: [
        { names: ['FURIA', 'FURIA Esports'], minKills: 3 },
        { names: ['Legacy'], minKills: 4 },
        { names: ['Imperial', 'Imperial Esports'], minKills: 5 },
        { names: ['paiN', 'paiN Gaming'], minKills: 3 },
      ],
    });
    expect(doc.teams).toHaveLength(4);
    expect(doc.teams[0].minKills).toBe(3);
    expect(doc.teams[2].minKills).toBe(5);
  });

  it('rejeita mínimo fora de 2..5 e nomes vazios', () => {
    const badMin = validateWatchlistDoc({ teams: [{ names: ['X'], minKills: 6 }] });
    expect(badMin.ok).toBe(false);
    expect(badMin.errors.join(' ')).toContain('minKills');
    const empty = validateWatchlistDoc({ teams: [{ names: [] }] });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(' ')).toContain('nome');
  });

  it('rejeita alias duplicado entre times (ambíguo)', () => {
    const result = validateWatchlistDoc({
      teams: [{ names: ['FURIA'] }, { names: ['fúria'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('mais de uma vez');
  });

  it('rejeita booleano inválido e documento que não é objeto', () => {
    const badBool = validateWatchlistDoc({ enabled: 'sim' });
    expect(badBool.ok).toBe(false);
    expect(badBool.errors.join(' ')).toContain('true');
    expect(validateWatchlistDoc(null).ok).toBe(false);
    expect(validateWatchlistDoc([]).ok).toBe(false);
  });

  it('ignora campos desconhecidos e normaliza espaços', () => {
    const doc = validDoc({
      foo: 'bar',
      teams: [{ names: ['  FURIA  ', 'FURIA'], qualquer: true }],
    });
    expect(doc.teams[0].names).toEqual(['FURIA']);
  });

  it('aceita jogadores com limiar próprio', () => {
    const doc = validDoc({
      teams: [{ names: ['FURIA'] }],
      players: [{ names: ['KSCERATO'], minKills: 3, clutch: true }],
    });
    expect(doc.players[0].minKills).toBe(3);
    expect(doc.players[0].clutch).toBe(true);
  });

  it('aceita piso de estrelas por time e no default', () => {
    const doc = validDoc({
      defaults: { minStars: 1 },
      teams: [{ names: ['FURIA'], minStars: 3 }, { names: ['Legacy'] }],
    });
    expect(doc.defaults.minStars).toBe(1);
    expect(doc.teams[0].minStars).toBe(3);
    expect(doc.teams[1].minStars).toBeUndefined();
  });

  it('rejeita piso de estrelas fora de 0..5', () => {
    const bad = validateWatchlistDoc({ teams: [{ names: ['X'], minStars: 6 }] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toContain('minStars');
    const badDefault = validateWatchlistDoc({ defaults: { minStars: -1 } });
    expect(badDefault.ok).toBe(false);
    expect(badDefault.errors.join(' ')).toContain('minStars');
    const badFraction = validateWatchlistDoc({ teams: [{ names: ['X'], minStars: 1.5 }] });
    expect(badFraction.ok).toBe(false);
  });
});

describe('resolveMatchRule', () => {
  const doc = validDoc({
    defaults: { minKills: 4, clutch: false },
    teams: [
      { names: ['FURIA', 'FURIA Esports'], minKills: 3 },
      { names: ['Legacy'], minKills: 4 },
      { names: ['Imperial', 'Imperial Esports'], minKills: 5 },
      { names: ['paiN', 'paiN Gaming'], minKills: 3, enabled: false },
    ],
  });

  it('time na lista grava e usa o limiar do time (0 estrelas tanto faz)', () => {
    const rule = resolveMatchRule(doc, ['Fúria', 'MIBR'], 5, 0);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(3);
    expect(rule.matchedTeams).toEqual(['FURIA']);
  });

  it('dois times na lista usam o menor limiar', () => {
    const rule = resolveMatchRule(doc, ['FURIA', 'Legacy'], 5, 0);
    expect(rule.minKills).toBe(3);
    expect(rule.matchedTeams).toEqual(['FURIA', 'Legacy']);
  });

  it('Imperial entra na gravação mas só ace (5)', () => {
    const rule = resolveMatchRule(doc, ['Imperial'], 5, 0);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(5);
  });

  it('time desabilitado e partida sem time da lista caem na regra por estrelas', () => {
    expect(resolveMatchRule(doc, ['paiN'], 5, 0)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(resolveMatchRule(doc, ['MIBR', 'NIP'], 4, 0)).toMatchObject({
      watchlisted: false,
      minKills: 4,
    });
    expect(resolveMatchRule(doc, ['TBD', 'TBD'], 5, 0).watchlisted).toBe(false);
  });

  it('watchlist desligada inteira desliga o override', () => {
    const off = { ...doc, enabled: false };
    expect(resolveMatchRule(off, ['FURIA'], 5, 0)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(resolveMatchRule(null, ['FURIA'], 5, 0).watchlisted).toBe(false);
  });

  it('clutch: regra do time vence o default e OR entre times', () => {
    const clutchDoc = validDoc({
      defaults: { clutch: true },
      teams: [{ names: ['FURIA'], clutch: false }, { names: ['Legacy'], clutch: true }],
    });
    expect(resolveMatchRule(clutchDoc, ['FURIA'], 4, 0).clutch).toBe(false);
    expect(resolveMatchRule(clutchDoc, ['Legacy'], 4, 0).clutch).toBe(true);
    expect(resolveMatchRule(clutchDoc, ['FURIA', 'Legacy'], 4, 0).clutch).toBe(true);
    expect(resolveMatchRule(clutchDoc, ['MIBR'], 4, 0).clutch).toBe(false);
  });

  it('minStars: herda o default e usa o menor entre os times casados', () => {
    const starsDoc = validDoc({
      defaults: { minStars: 1 },
      teams: [
        { names: ['FURIA'], minStars: 3 },
        { names: ['Legacy'], minStars: 2 },
      ],
    });
    expect(resolveMatchRule(starsDoc, ['FURIA'], 5, 5).minStars).toBe(3);
    expect(resolveMatchRule(starsDoc, ['Legacy'], 5, 2).minStars).toBe(2);
    expect(resolveMatchRule(starsDoc, ['FURIA', 'Legacy'], 5, 3).minStars).toBe(2);
    // Sem time da lista: sem piso (não é override).
    expect(resolveMatchRule(starsDoc, ['MIBR'], 5, 5).minStars).toBe(0);
  });

  it('o piso é POR TIME: quem não atendeu não entra no limiar da partida', () => {
    const starsDoc = validDoc({
      defaults: { minKills: 4, minStars: 0 },
      teams: [
        { names: ['FURIA'], minKills: 3, minStars: 3 },
        { names: ['Legacy'], minKills: 4, minStars: 0 },
      ],
    });
    // 1★: FURIA (piso 3) NÃO atende; Legacy (piso 0) atende.
    const rule = resolveMatchRule(starsDoc, ['FURIA', 'Legacy'], 5, 1);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(4); // o 3 do FURIA não vale (piso dele não atendido)
    expect(rule.teams).toEqual([
      expect.objectContaining({ team: 'FURIA', minKills: 3, minStars: 3, floorMet: false }),
      expect.objectContaining({ team: 'Legacy', minKills: 4, minStars: 0, floorMet: true }),
    ]);
    // 3★: FURIA passa a valer e o menor limiar volta a ser 3.
    expect(resolveMatchRule(starsDoc, ['FURIA', 'Legacy'], 5, 3).minKills).toBe(3);
  });

  it('nenhum time atendendo o piso: vale o limiar geral (o time não entra)', () => {
    const starsDoc = validDoc({
      defaults: { minKills: 4, minStars: 0 },
      teams: [{ names: ['FURIA'], minKills: 3, minStars: 3 }],
    });
    const rule = resolveMatchRule(starsDoc, ['FURIA', 'MIBR'], 5, 1);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(5); // fallback geral, não o 3 do FURIA
    expect(rule.minStars).toBe(0);
    expect(rule.teams[0].floorMet).toBe(false);
  });
});

describe('watchlistStarsFloorMet', () => {
  it('piso 0 não restringe (time entra em qualquer partida)', () => {
    expect(watchlistStarsFloorMet(0, 0)).toBe(true);
    expect(watchlistStarsFloorMet(1, 0)).toBe(true);
    expect(watchlistStarsFloorMet(5, 0)).toBe(true);
  });

  it('piso > 0 exige as estrelas no listing (0 = desconhecido NÃO atende)', () => {
    expect(watchlistStarsFloorMet(2, 2)).toBe(true);
    expect(watchlistStarsFloorMet(3, 2)).toBe(true);
    expect(watchlistStarsFloorMet(1, 2)).toBe(false);
    expect(watchlistStarsFloorMet(0, 2)).toBe(false);
  });
});

describe('resolveTeamRule', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [
      { names: ['FURIA', 'FURIA Esports'], minKills: 3, minStars: 2 },
      { names: ['Legacy'], minKills: 4, enabled: false },
    ],
  });

  it('acha o time por alias, ignorando caixa e acentos', () => {
    expect(resolveTeamRule(doc, 'fúria esports')?.minKills).toBe(3);
    expect(resolveTeamRule(doc, 'FURIA')?.minStars).toBe(2);
  });

  it('time desabilitado, desconhecido e watchlist desligada não casam', () => {
    expect(resolveTeamRule(doc, 'Legacy')).toBeNull();
    expect(resolveTeamRule(doc, 'MIBR')).toBeNull();
    expect(resolveTeamRule(doc, null)).toBeNull();
    expect(resolveTeamRule(doc, '')).toBeNull();
    expect(resolveTeamRule({ ...doc, enabled: false }, 'FURIA')).toBeNull();
  });
});

describe('resolvePlayerRule', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [{ names: ['FURIA'], minKills: 3 }],
    players: [
      { names: ['KSCERATO'], minKills: 3 },
      { names: ['FalleN'], minKills: 5, clutch: true },
    ],
  });

  it('jogador sobrescreve o limiar do time e do default', () => {
    expect(resolvePlayerRule(doc, 'kscerato')?.minKills).toBe(3);
    expect(resolvePlayerRule(doc, 'FalleN')?.minKills).toBe(5);
    expect(resolvePlayerRule(doc, 'FalleN')?.clutch).toBe(true);
  });

  it('jogador fora da lista retorna null', () => {
    expect(resolvePlayerRule(doc, 'dev1ce')).toBeNull();
    expect(resolvePlayerRule(doc, '')).toBeNull();
    expect(resolvePlayerRule({ ...doc, enabled: false }, 'KSCERATO')).toBeNull();
  });
});

describe('resolveKillerMinKills', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [{ names: ['FURIA', 'FURIA Esports'], minKills: 3 }],
    players: [{ names: ['KSCERATO'], minKills: 2 }],
  });

  it('jogador do time monitorado usa o limiar do time', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: 'yuriz',
        playerTeam: 'FURIA',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 3, source: 'team' });
  });

  it('jogador listado vence o limiar do time', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: 'KSCERATO',
        playerTeam: 'FURIA',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 2, source: 'player' });
  });

  it('adversário é bloqueado em partida que só entrou pela watchlist', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: ' FalleN',
        playerTeam: 'Imperial',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: null, source: 'blocked' });
  });

  it('jogador listado fura o bloqueio mesmo fora do time monitorado', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: 'KSCERATO',
        playerTeam: 'Imperial',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 2, source: 'player' });
  });

  it('adversário usa a política geral quando a partida passa no filtro geral', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: 'FalleN',
        playerTeam: 'Imperial',
        passesGeneral: true,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 5, source: 'general' });
  });

  it('piso de estrelas não atendido: o limiar do time NÃO vale (volta à geral)', () => {
    // O override está INATIVO (o piso de estrelas do time não foi
    // atendido): o time da lista usa a política geral como todo mundo.
    expect(
      resolveKillerMinKills({
        doc,
        player: 'yuriz',
        playerTeam: 'FURIA',
        passesGeneral: true,
        generalMinKills: 5,
        watchlistOverride: false,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 5, source: 'general' });
    // E, sem a política geral, ninguém gera clipe.
    expect(
      resolveKillerMinKills({
        doc,
        player: 'yuriz',
        playerTeam: 'FURIA',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: false,
        stars: 0,
      }),
    ).toMatchObject({ minKills: null, source: 'blocked' });
    // Jogador listado continua furando o bloqueio.
    expect(
      resolveKillerMinKills({
        doc,
        player: 'KSCERATO',
        playerTeam: 'Imperial',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: false,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 2, source: 'player' });
  });


  it('time desconhecido: só passa pelo filtro geral ou por players', () => {
    expect(
      resolveKillerMinKills({
        doc,
        player: 'FalleN',
        playerTeam: null,
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: null, source: 'blocked' });
    expect(
      resolveKillerMinKills({
        doc,
        player: 'FalleN',
        playerTeam: null,
        passesGeneral: true,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 5, source: 'general' });
  });

  it('watchlist desligada ou ausente: só a política geral vale', () => {
    expect(
      resolveKillerMinKills({
        doc: { ...doc, enabled: false },
        player: 'FalleN',
        playerTeam: 'Imperial',
        passesGeneral: true,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 5, source: 'general' });
    // Partida que não passa no filtro geral não gera clip de ninguém.
    expect(
      resolveKillerMinKills({
        doc: { ...doc, enabled: false },
        player: 'FalleN',
        playerTeam: 'Imperial',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: null, source: 'blocked' });
    expect(
      resolveKillerMinKills({
        doc: null,
        player: 'FalleN',
        playerTeam: 'Imperial',
        passesGeneral: true,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 0,
      }),
    ).toMatchObject({ minKills: 5, source: 'general' });
  });
  it('piso do PRÓPRIO time: quem não atendeu o piso perde o limiar dele', () => {
    const starsDoc = validDoc({
      defaults: { minKills: 4 },
      teams: [
        { names: ['FURIA'], minKills: 3, minStars: 3 },
        { names: ['Legacy'], minKills: 4, minStars: 0 },
      ],
    });
    // Partida de 1★: o override está ativo (Legacy atendeu o piso 0), mas o
    // FURIA NÃO atendeu o piso 3 → o limiar do FURIA não vale.
    expect(
      resolveKillerMinKills({
        doc: starsDoc,
        player: 'yuriz',
        playerTeam: 'FURIA',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 1,
      }),
    ).toMatchObject({ minKills: null, source: 'blocked' });
    // 3★: o limiar do FURIA volta a valer.
    expect(
      resolveKillerMinKills({
        doc: starsDoc,
        player: 'yuriz',
        playerTeam: 'FURIA',
        passesGeneral: false,
        generalMinKills: 5,
        watchlistOverride: true,
        stars: 3,
      }),
    ).toMatchObject({ minKills: 3, source: 'team' });
  });
});

describe('resolveRoundPolicy (a política da partida)', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [{ names: ['FURIA'], minKills: 3, minStars: 2 }],
  });

  it('o override só fica ativo se algum time atendeu o próprio piso', () => {
    const low = resolveRoundPolicy({
      doc,
      stars: 1,
      teams: ['FURIA', 'MIBR'],
      passesGeneral: false,
      generalMinKills: 5,
    });
    expect(low.overrideActive).toBe(false);
    expect(low.rule.watchlisted).toBe(true);
    expect(low.killer('yuriz', 'FURIA')).toMatchObject({ minKills: null, source: 'blocked' });

    const ok = resolveRoundPolicy({
      doc,
      stars: 2,
      teams: ['FURIA', 'MIBR'],
      passesGeneral: false,
      generalMinKills: 5,
    });
    expect(ok.overrideActive).toBe(true);
    expect(ok.killer('yuriz', 'FURIA')).toMatchObject({ minKills: 3, source: 'team' });
  });

  it('hot-reload: o doc entra por parâmetro (vale a watchlist nova sem reiniciar)', () => {
    const novo = validDoc({
      defaults: { minKills: 4 },
      teams: [{ names: ['FURIA'], minKills: 2, minStars: 0 }],
    });
    const antes = resolveRoundPolicy({
      doc,
      stars: 5,
      teams: ['FURIA', 'MIBR'],
      passesGeneral: false,
      generalMinKills: 5,
    });
    expect(antes.killer('yuriz', 'FURIA')).toMatchObject({ minKills: 3, source: 'team' });
    const depois = resolveRoundPolicy({
      doc: novo,
      stars: 5,
      teams: ['FURIA', 'MIBR'],
      passesGeneral: false,
      generalMinKills: 5,
    });
    expect(depois.killer('yuriz', 'FURIA')).toMatchObject({ minKills: 2, source: 'team' });
  });
});

describe('matchTeamAlias (o nome do placar casa com o do listing)', () => {
  it('nome igual (ignorando acento/maiúscula) casa', () => {
    expect(matchTeamAlias('FURIA', ['Furia', 'MIBR'])).toBe('Furia');
    expect(matchTeamAlias('furia', ['FURIA', 'MIBR'])).toBe('FURIA');
  });

  it('o prefixo "team" do placar não impede o casamento', () => {
    expect(matchTeamAlias('Team Vitality', ['Vitality', 'MIBR'])).toBe('Vitality');
    expect(matchTeamAlias('Vitality', ['Team Vitality', 'MIBR'])).toBe('Team Vitality');
  });

  it('nome que não casa devolve null (não inventa time)', () => {
    expect(matchTeamAlias('Imperial', ['FURIA', 'MIBR'])).toBeNull();
    expect(matchTeamAlias('', ['FURIA'])).toBeNull();
    expect(matchTeamAlias(null, ['FURIA'])).toBeNull();
  });
});

describe('createKillerPolicy (a política do round)', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [{ names: ['FURIA'], minKills: 3 }],
    players: [{ names: ['KSCERATO'], minKills: 2 }],
  });

  it('canonicaliza o time do placar para o nome do listing', () => {
    const policy = createKillerPolicy({
      doc,
      passesGeneral: false,
      generalMinKills: 5,
      watchlistOverride: true,
      stars: 0,
      teamAliases: ['FURIA', 'MIBR'],
    });
    // O placar diz "Team FURIA": sem canonicalizar, o time não casaria.
    expect(policy('yuriz', 'Team FURIA')).toMatchObject({ minKills: 3, source: 'team' });
    expect(policy('yuriz', 'FURIA')).toMatchObject({ minKills: 3, source: 'team' });
    // Adversário continua bloqueado.
    expect(policy('FalleN', 'MIBR')).toMatchObject({ minKills: null, source: 'blocked' });
  });

  it('time do placar que não casa com o listing fica bloqueado (fail-closed)', () => {
    const policy = createKillerPolicy({
      doc,
      passesGeneral: false,
      generalMinKills: 5,
      watchlistOverride: true,
      stars: 0,
      teamAliases: ['FURIA', 'MIBR'],
    });
    expect(policy('yuriz', 'VITALITY')).toMatchObject({ minKills: null, source: 'blocked' });
  });
});

describe('loadWatchlistFile', () => {
  it('lê, cacheia por mtime, mantém a última versão boa e preserva no grace', () => {
    const t0 = 1_000_000;
    const file = tmpFile(
      'watchlist.json',
      JSON.stringify({ teams: [{ names: ['FURIA'], minKills: 3 }] }),
    );
    const first = loadWatchlistFile(file, t0);
    expect(first.missing).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.error).toBeNull();
    expect(first.doc.teams[0].names).toEqual(['FURIA']);
    expect(loadWatchlistFile(file, t0 + 500).changed).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ teams: [{ names: ['Legacy'], minKills: 4 }] }), 'utf8');
    const second = loadWatchlistFile(file, t0 + 1000);
    expect(second.changed).toBe(true);
    expect(second.doc.teams[0].names).toEqual(['Legacy']);

    fs.writeFileSync(file, '{ quebrado', 'utf8');
    const third = loadWatchlistFile(file, t0 + 2000);
    expect(third.error).toBeTruthy();
    expect(third.doc.teams[0].names).toEqual(['Legacy']);

    fs.rmSync(file, { force: true });
    const missing = loadWatchlistFile(file, t0 + 3000);
    expect(missing.missing).toBe(true);
    expect(missing.stale).toBe(true);
    expect(missing.changed).toBe(true);
    expect(missing.doc.teams[0].names).toEqual(['Legacy']);

    const stillMissing = loadWatchlistFile(file, t0 + 4000);
    expect(stillMissing.changed).toBe(false);
    expect(stillMissing.stale).toBe(true);
    expect(stillMissing.doc.teams[0].names).toEqual(['Legacy']);

    const expired = loadWatchlistFile(file, t0 + 1000 + WATCHLIST_MISSING_GRACE_MS + 1);
    expect(expired.missing).toBe(true);
    expect(expired.stale).toBe(false);
    expect(expired.changed).toBe(true);
    expect(expired.doc).toEqual(defaultWatchlistDoc());
  });

  it('aceita BOM no início do arquivo (Notepad/PowerShell)', () => {
    const file = tmpFile(
      'bom.json',
      `\uFEFF${JSON.stringify({ teams: [{ names: ['paiN'], minKills: 3 }] })}`,
    );
    const loaded = loadWatchlistFile(file);
    expect(loaded.error).toBeNull();
    expect(loaded.doc.teams[0].names).toEqual(['paiN']);
  });
});
