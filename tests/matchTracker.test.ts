import { describe, expect, it } from 'vitest';
import { RoundTracker } from '../src/detector/aceDetector.js';
import { MAX_KILLS_PER_ROUND, processPoll, shouldResetTracker } from '../src/detector/matchTracker.js';
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
