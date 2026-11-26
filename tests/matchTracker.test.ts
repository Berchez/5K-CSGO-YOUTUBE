import { describe, expect, it } from 'vitest';
import { RoundTracker } from '../src/detector/aceDetector.js';
import {
  indexPlayerTeams,
  MAX_KILLS_PER_ROUND,
  parseRoundTimer,
  playerTeamKey,
  processPoll,
  roundOverObservation,
  shouldResetTracker,
} from '../src/detector/matchTracker.js';
import type { RoundSnapshot } from '../src/detector/matchTracker.js';

function snap(
  ct: number,
  t: number,
  players: Array<{ name: string; kills: number; deaths?: number }>,
  map = 'inferno',
): RoundSnapshot {
  return { players, ctScore: ct, tScore: t, map, round: ct + t + 1 };
}

describe('processPoll (ordem fecha-antes-de-limpar)', () => {
  it('dispara o 3k na virada de round com os kills acumulados', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'rain', kills: 10 }]), last, 3);
    last = r.lastTotal;
    expect(r.event).toBeNull();
    r = processPoll(tr, snap(3, 3, [{ name: 'rain', kills: 13 }]), last, 3);
    last = r.lastTotal;
    expect(r.event).toBeNull(); // mesmo round: ainda não fecha
    // virou p/ 4-3: fecha e dispara com os 3 kills
    r = processPoll(tr, snap(4, 3, [{ name: 'rain', kills: 13 }]), last, 3);
    expect(r.event?.player).toBe('rain');
    expect(r.event?.kills).toHaveLength(3);
    expect(r.lastTotal).toBe(7);
  });

  it('REGRESSÃO: o 1o poll ancora mapa e round no placar (nada de "unknown")', () => {
    // O tracker nasce sem mapa e com round 1: sem ancorar no 1o poll, o
    // 1o multikill saia com map "unknown" e round errado.
    const tr = new RoundTracker();
    let r = processPoll(tr, snap(3, 3, [{ name: 'rain', kills: 10 }]), -1, 3);
    r = processPoll(tr, snap(4, 3, [{ name: 'rain', kills: 13 }]), r.lastTotal, 3);
    expect(r.event?.player).toBe('rain');
    expect(r.event?.round).toBe(7);
    expect(r.event?.kills[0]?.map).toBe('inferno');
  });

  it('REGRESSÃO: setContext antes do close esvaziava tudo (nada disparava)', () => {
    const tr = new RoundTracker('inferno', 7);
    // simula o loop BUGGY antigo: setContext (limpa!) e só depois closeRound
    tr.syncBaseline([{ name: 'x', kills: 0 }]);
    tr.syncBaseline([{ name: 'x', kills: 3 }]);
    tr.setContext('inferno', 8); // <- o bug: limpa o acumulado do round 7
    const { player } = tr.closeRound(3);
    expect(player).toBeNull(); // prova que a ordem antiga perdia o evento
    // e a ordem certa (processPoll) preserva:
    const tr2 = new RoundTracker('inferno', 7);
    let last2 = -1;
    let rr = processPoll(tr2, snap(3, 3, [{ name: 'x', kills: 0 }]), last2, 3);
    last2 = rr.lastTotal;
    rr = processPoll(tr2, snap(3, 3, [{ name: 'x', kills: 3 }]), last2, 3);
    last2 = rr.lastTotal;
    rr = processPoll(tr2, snap(4, 3, [{ name: 'x', kills: 3 }]), last2, 3);
    expect(rr.event?.player).toBe('x');
    expect(rr.event?.kills).toHaveLength(3);
  });

  it('REGRESSÃO: kills atrasados da coluna K entram no round que fecha, não no novo', () => {
    // Cenário real: o 3k acontece no fim do round 7, o placar de score
    // vira ANTES da coluna K atualizar (scorebot atrasa). O diff de K
    // chega junto com o placar já virado — pertence ao round 7.
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 10 }]), last, 3);
    last = r.lastTotal;
    expect(r.event).toBeNull();
    // virou p/ 4-3 E o mesmo snapshot traz x=13 (K atrasado)
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 13 }]), last, 3);
    last = r.lastTotal;
    expect(r.event?.player).toBe('x');
    expect(r.event?.kills).toHaveLength(3);
    expect(r.event?.round).toBe(7); // round do 3k real, não o 8
    // round novo: mesmo K de novo, NADA vaza (round 8 começa limpo)
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 13 }]), last, 3);
    expect(r.event).toBeNull();
    expect(tr.pending).toBe(0);
  });

  it('não duplica: mesmo round fechado 1x, e sem multikill não dispara', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'a', kills: 1 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'a', kills: 1 }]), last, 3);
    expect(r.event).toBeNull();
    expect(r.lastTotal).toBe(7);
  });

  it('limiar por jogador (watchlist) fecha o round com 2k só do listado', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'KSCERATO', kills: 10 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(3, 3, [{ name: 'KSCERATO', kills: 12 }]), last, 3);
    last = r.lastTotal;
    expect(r.event).toBeNull();
    const minKillsFor = (p: string) => (p.toLowerCase() === 'kscerato' ? 2 : 3);
    r = processPoll(tr, snap(4, 3, [{ name: 'KSCERATO', kills: 12 }]), last, minKillsFor);
    expect(r.event?.player).toBe('KSCERATO');
    expect(r.event?.kills).toHaveLength(2);
  });

  it('limiar por jogador não afrouxa quem está fora da lista', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'KSCERATO', kills: 10 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(3, 3, [{ name: 'KSCERATO', kills: 12 }]), last, 3);
    last = r.lastTotal;
    const minKillsFor = (p: string) => (p.toLowerCase() === 'kscerato' ? 2 : 3);
    r = processPoll(tr, snap(4, 3, [{ name: 'KSCERATO', kills: 12 }]), last, minKillsFor);
    expect(r.event?.player).toBe('KSCERATO');
    // Round novo: 2 kills de quem NÃO está na lista — não dispara.
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'KSCERATO', kills: 12 }, { name: 'outro', kills: 0 }]), last, minKillsFor);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'KSCERATO', kills: 12 }, { name: 'outro', kills: 2 }]), last, minKillsFor);
    last = r.lastTotal;
    r = processPoll(tr, snap(5, 3, [{ name: 'KSCERATO', kills: 12 }, { name: 'outro', kills: 2 }]), last, minKillsFor);
    expect(r.event).toBeNull();
  });

  it('REGRESSÃO: round sem multikill não consulta a política com jogador vazio', () => {
    // A política por time (watchlist/rank) responde "bloqueado" quando não há
    // autor. Consultá-la com "" disparava o aviso "time do killer não
    // resolvido" em TODA partida bloqueada (regra de rank entrava assim).
    const asked: string[] = [];
    const minKillsFor = (p: string) => {
      asked.push(p);
      return p ? 4 : Number.POSITIVE_INFINITY;
    };
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 1 }]), last, minKillsFor);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 1 }]), last, minKillsFor);
    expect(r.event).toBeNull();
    expect(asked).not.toContain('');
  });

  it('descarta multikill impossível (>5, gap corrompeu a base)', () => {
    expect(MAX_KILLS_PER_ROUND).toBe(5);
    const tr = new RoundTracker('inferno', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'x', kills: 0 }]), last, 3);
    last = r.lastTotal;
    // apagão: placar pula e o mesmo poll traz +22 de uma vez
    r = processPoll(tr, snap(3, 0, [{ name: 'x', kills: 22 }]), last, 3);
    expect(r.event).toBeNull();
    expect(r.dropped).toContain('22 kills');
  });
  it('REGRESSÃO: stats reiniciadas no break descartam kills fantasmas (5K do jcobbb)', () => {
    const tr = new RoundTracker('Nuke', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'jcobbb', kills: 0 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    // Coluna K repovoada com stats do mapa anterior durante o break (+5),
    // sem o placar virar (0-0): tudo isso ficava pendente para o round 1.
    r = processPoll(tr, snap(0, 0, [{ name: 'jcobbb', kills: 5 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    expect(tr.pending).toBe(5);
    // Mapa novo começa e a coluna K zera: época nova — kills antigas caem.
    r = processPoll(tr, snap(0, 0, [{ name: 'jcobbb', kills: 0 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    expect(tr.pending).toBe(0);
    // Round 1 fecha 0-1 sem kills reais: nada dispara.
    r = processPoll(tr, snap(1, 0, [{ name: 'jcobbb', kills: 0 }], 'Nuke'), last, 3);
    expect(r.event).toBeNull();
  });

  it('descarta pendentes quando o reset só aparece no poll de fechamento', () => {
    const tr = new RoundTracker('Nuke', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'x', kills: 0 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    // repovoamento +5 durante o break (0-0)
    r = processPoll(tr, snap(0, 0, [{ name: 'x', kills: 5 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    expect(tr.pending).toBe(5);
    // placar vira 1-0 E a coluna K zera no MESMO poll
    r = processPoll(tr, snap(1, 0, [{ name: 'x', kills: 0 }], 'Nuke'), last, 3);
    expect(r.event).toBeNull();
    expect(r.dropped).toContain('reiniciaram');
    expect(tr.pending).toBe(0);
  });

  it('descarta multikill com 1ª kill fora da janela do round (stats de outra época)', () => {
    const tr = new RoundTracker('Nuke', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'jcobbb', kills: 0 }], 'Nuke'), last, 3);
    last = r.lastTotal;
    // 5 kills sintetizadas há 5 min (repovoamento do HLTV) e NENHUMA queda
    // depois: o guard de reset não vê, mas a janela do round rejeita.
    const oldAt = Date.now() - 300_000;
    for (let i = 0; i < 5; i++) tr.addKill('jcobbb', `v${i}`, { at: oldAt + i * 5000 });
    r = processPoll(tr, snap(1, 0, [{ name: 'jcobbb', kills: 0 }], 'Nuke'), last, 3);
    expect(r.event).toBeNull();
    expect(r.dropped).toContain('fora da janela');
    expect(tr.pending).toBe(0);
  });

  it('grava o placar antes/depois do round no evento', () => {
    const tr = new RoundTracker('inferno', 7);
    const before = snap(5, 2, [{ name: 'nilo', kills: 10 }]);
    const after = snap(6, 2, [{ name: 'nilo', kills: 13 }]);
    let r = processPoll(tr, before, -1, 3, 10_000, before);
    expect(r.event).toBeNull();
    r = processPoll(tr, after, r.lastTotal, 3, 10_000, before);
    expect(r.event?.scoreBefore).toBe('5-2');
    expect(r.event?.scoreAfter).toBe('6-2');
  });

  it('reset no fechamento sem kills pendentes não loga descarte falso', () => {
    const tr = new RoundTracker('Nuke', 1);
    let last = -1;
    const players = [
      { name: 'a', kills: 5 },
      { name: 'b', kills: 5 },
    ];
    let r = processPoll(tr, snap(0, 0, players, 'Nuke'), last, 3);
    last = r.lastTotal;
    expect(tr.pending).toBe(0);
    // Placar vira e as duas stats zeram: reset amplo sem nada pendente.
    r = processPoll(
      tr,
      snap(1, 0, [{ name: 'a', kills: 0 }, { name: 'b', kills: 0 }], 'Nuke'),
      last,
      3,
    );
    expect(r.dropped).toBeNull();
    expect(r.roundClosed).toEqual({
      map: 'Nuke',
      // Round que TERMINOU (o placar já virou para o 2) + diagnóstico vazio.
      round: 1,
      score: '1-0',
      bestPlayer: null,
      bestKills: 0,
      required: null,
      blocked: false,
    });
  });

  it('round fechado sem multikill registra o melhor candidato e o limiar', () => {
    const tr = new RoundTracker('Mirage', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'donk', kills: 0 }], 'Mirage'), last, 5);
    last = r.lastTotal;
    // 4 kills no round: abaixo do limiar de ACE (5).
    r = processPoll(tr, snap(0, 0, [{ name: 'donk', kills: 4 }], 'Mirage'), last, 5);
    last = r.lastTotal;
    expect(r.event).toBeNull();
    // Placar vira com a coluna K ainda no valor do round (sem reset de stats).
    r = processPoll(tr, snap(1, 0, [{ name: 'donk', kills: 4 }], 'Mirage'), last, 5);
    expect(r.event).toBeNull();
    expect(r.roundClosed).toMatchObject({
      map: 'Mirage',
      round: 1,
      bestPlayer: 'donk',
      bestKills: 4,
      required: 5,
      blocked: false,
    });
  });

  it('candidato bloqueado (só watchlist) sai como blocked, sem limiar numérico', () => {
    const tr = new RoundTracker('Mirage', 1);
    const bloqueado = () => Number.POSITIVE_INFINITY;
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'adversario', kills: 0 }], 'Mirage'), last, bloqueado);
    last = r.lastTotal;
    r = processPoll(tr, snap(0, 0, [{ name: 'adversario', kills: 3 }], 'Mirage'), last, bloqueado);
    last = r.lastTotal;
    r = processPoll(tr, snap(1, 0, [{ name: 'adversario', kills: 3 }], 'Mirage'), last, bloqueado);
    expect(r.roundClosed).toMatchObject({
      bestPlayer: 'adversario',
      bestKills: 3,
      required: null,
      blocked: true,
    });
  });

  it('resolver NaN não descarta um 5k válido (usa o máximo)', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 0 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 5 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 5 }]), last, () => Number.NaN);
    expect(r.event?.player).toBe('x');
    expect(r.event?.kills).toHaveLength(5);
  });
});

describe('shouldResetTracker', () => {
  it('reseta após apagão longo ou salto de round', () => {
    const now = 1_000_000;
    expect(shouldResetTracker(-1, 5, 0, now)).toBe(false);
    expect(shouldResetTracker(7, 7, now - 10_000, now)).toBe(false);
    expect(shouldResetTracker(7, 8, now - 10_000, now)).toBe(false);
    expect(shouldResetTracker(7, 7, now - 200_000, now)).toBe(true);
    expect(shouldResetTracker(7, 10, now - 10_000, now)).toBe(true);
  });
});

describe('parseRoundTimer (timer do round no placar do HLTV)', () => {
  it('lê o relógio do round', () => {
    expect(parseRoundTimer('1:07')).toEqual({ sec: 67, state: 'running' });
    expect(parseRoundTimer('0:17')).toEqual({ sec: 17, state: 'running' });
  });

  it('reconhece o fim do round', () => {
    expect(parseRoundTimer('Round over')).toEqual({ sec: null, state: 'round-over' });
    expect(parseRoundTimer('round over')).toEqual({ sec: null, state: 'round-over' });
  });

  it('formato desconhecido não inventa relógio', () => {
    expect(parseRoundTimer('')).toEqual({ sec: null, state: 'unknown' });
    expect(parseRoundTimer('12:90')).toEqual({ sec: null, state: 'unknown' });
    expect(parseRoundTimer('banana')).toEqual({ sec: null, state: 'unknown' });
  });
});

describe('roundOverObservation (instante do fim do round)', () => {
  const T = 1_700_000_000_000;

  it('usa o instante do POLL que viu o "Round over"', () => {
    expect(roundOverObservation(null, 'round-over', T, { round: 7, atMs: T - 3_000 })).toEqual({
      round: 7,
      atMs: T,
    });
  });

  it('a primeira observação do MESMO round vence', () => {
    expect(
      roundOverObservation({ round: 7, atMs: T - 10_000 }, 'round-over', T, { round: 7, atMs: T - 3_000 }),
    ).toEqual({ round: 7, atMs: T - 10_000 });
  });

  it('REGRESSÃO: observação de outro round não bloqueia o round atual', () => {
    // O placar do HLTV mostra "Round over" do round anterior durante o
    // freeze do seguinte: com a regra global antiga, esse valor vazava
    // para o evento do round novo (latência de 94s/238s).
    expect(
      roundOverObservation({ round: 7, atMs: T - 10_000 }, 'round-over', T, { round: 8, atMs: T - 3_000 }),
    ).toEqual({ round: 8, atMs: T });
  });

  it('não data o break anterior ao tracking (sem timer rodando recente)', () => {
    expect(roundOverObservation(null, 'round-over', T, null)).toBeNull();
    expect(roundOverObservation(null, 'round-over', T, { round: 7, atMs: T - 121_000 })).toBeNull();
  });

  it('estado que não é "round over" não produz instante', () => {
    expect(roundOverObservation(null, 'running', T, { round: 7, atMs: T - 3_000 })).toBeNull();
    expect(roundOverObservation(null, 'unknown', T, { round: 7, atMs: T - 3_000 })).toBeNull();
  });
});

describe('roundEndedAt (fim real do round no relógio do jogo)', () => {
  it('o evento carrega o instante do "Round over" quando o placar o mostrou', () => {
    const tr = new RoundTracker('inferno', 7);
    // 5-2 = 7 rounds jogados: o round EM ANDAMENTO é o 8 (ct+t+1). O
    // tracker nasce desatualizado e se ancora no placar no 1o poll.
    const before = snap(5, 2, [{ name: 'nilo', kills: 10 }]);
    const after = snap(6, 2, [{ name: 'nilo', kills: 13 }]);
    let r = processPoll(tr, before, -1, 3, 10_000, before);
    r = processPoll(tr, after, r.lastTotal, 3, 10_000, before, {
      round: 8,
      atMs: 1_700_000_000_000,
    });
    expect(r.event?.round).toBe(8);
    expect(r.event?.roundEndedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('REGRESSÃO: "Round over" de OUTRO round não data o evento', () => {
    const tr = new RoundTracker('inferno', 7);
    const before = snap(5, 2, [{ name: 'nilo', kills: 10 }]);
    const after = snap(6, 2, [{ name: 'nilo', kills: 13 }]);
    let r = processPoll(tr, before, -1, 3, 10_000, before);
    r = processPoll(tr, after, r.lastTotal, 3, 10_000, before, {
      round: 7,
      atMs: 1_700_000_000_000,
    });
    expect(r.event?.roundEndedAt).toBeUndefined();
  });

  it('sem timer no placar, o evento não carrega o instante (a estimativa vale)', () => {
    const tr = new RoundTracker('inferno', 7);
    const before = snap(5, 2, [{ name: 'nilo', kills: 10 }]);
    const after = snap(6, 2, [{ name: 'nilo', kills: 13 }]);
    let r = processPoll(tr, before, -1, 3, 10_000, before);
    r = processPoll(tr, after, r.lastTotal, 3, 10_000, before, null);
    expect(r.event?.roundEndedAt).toBeUndefined();
  });
  it('usa snap.score quando o round terminou NO MESMO round das kills', () => {
    // Cenário: round 12 termina com 3 kills de nilo, placar final 6-5
    const tr = new RoundTracker('inferno', 11);
    const before = snap(5, 5, [{ name: 'nilo', kills: 10 }]);

    let r = processPoll(tr, before, -1, 3, 10_000, before);

    // Virada: 5-5 → 6-5, nilo da 3ª kill (10→13)
    const after = snap(6, 5, [{ name: 'nilo', kills: 13 }]);

    // roundEnded tem o MESMO round das kills (12), então usa snap.score
    r = processPoll(tr, after, r.lastTotal, 3, 10_000, before, { round: 12, atMs: 0 });

    expect(r.event?.scoreAfter).toBe('6-5');
  });
});

describe('anchorConfidence (confiança na 1ª kill)', () => {
  it('estreia com placar > 0: joinedMidRound no evento', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    // tracking começou com o jogo já no round 7 (3-3): round em andamento
    let r = processPoll(tr, snap(3, 3, [{ name: 'rain', kills: 10 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(3, 3, [{ name: 'rain', kills: 13 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'rain', kills: 13 }]), last, 3);
    expect(r.event?.player).toBe('rain');
    expect(r.event?.anchorConfidence?.joinedMidRound).toBe(true);
    expect(r.event?.anchorConfidence?.resetThisRound).toBe(false);
  });

  it('estreia no 0-0: confiança alta', () => {
    const tr = new RoundTracker('inferno', 1);
    let last = -1;
    let r = processPoll(tr, snap(0, 0, [{ name: 'x', kills: 0 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(0, 0, [{ name: 'x', kills: 3 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(1, 0, [{ name: 'x', kills: 3 }]), last, 3);
    expect(r.event?.player).toBe('x');
    expect(r.event?.anchorConfidence?.joinedMidRound).toBe(false);
    expect(r.event?.anchorConfidence?.resetThisRound).toBe(false);
  });

  it('reset no meio do round: resetThisRound no evento', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 0 }]), last, 3);
    last = r.lastTotal;
    tr.reset(); // gap: base reancorada, kills anteriores perdidas
    r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 3 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 6 }]), last, 3);
    last = r.lastTotal;
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 6 }]), last, 3);
    expect(r.event?.player).toBe('x');
    expect(r.event?.kills).toHaveLength(3);
    expect(r.event?.anchorConfidence?.resetThisRound).toBe(true);
  });

  it('settleKills conta kills da janela de assentamento', () => {
    const tr = new RoundTracker('inferno', 7);
    let last = -1;
    let r = processPoll(tr, snap(3, 3, [{ name: 'x', kills: 0 }]), last, 3);
    last = r.lastTotal;
    // K observado junto com o placar virado (tudo "agora" em teste):
    // cai na janela de 12s → contado como settle
    r = processPoll(tr, snap(4, 3, [{ name: 'x', kills: 3 }]), last, 3);
    expect(r.event?.player).toBe('x');
    expect(r.event?.anchorConfidence?.settleKills).toBe(3);
  });
});

describe('índice jogador → time (watchlist)', () => {
  it('normaliza o nome do jogador (case e espaços)', () => {
    expect(playerTeamKey('  Yuriz  ')).toBe('yuriz');
    expect(playerTeamKey('yuRiz')).toBe('yuriz');
  });

  it('amarra cada jogador ao time do cabeçalho do placar', () => {
    const index = indexPlayerTeams([
      { name: 'yuriz', kills: 3, team: 'FURIA' },
      { name: 'KSCERATO', kills: 1, team: 'Imperial' },
    ]);
    expect(index.get('yuriz')).toBe('FURIA');
    expect(index.get('kscerato')).toBe('Imperial');
  });

  it('mescla polls: jogador que some do placar mantém o time', () => {
    const index = indexPlayerTeams([{ name: 'yuriz', kills: 3, team: 'FURIA' }]);
    indexPlayerTeams([{ name: 'kn1ght', kills: 2, team: 'FURIA' }], index);
    expect(index.get('yuriz')).toBe('FURIA');
    expect(index.get('kn1ght')).toBe('FURIA');
  });

  it('jogador sem time no placar não entra no índice', () => {
    const index = indexPlayerTeams([{ name: 'yuriz', kills: 3 }]);
    expect(index.size).toBe(0);
  });
});
