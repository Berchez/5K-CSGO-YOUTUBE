import { describe, expect, it } from 'vitest';
import {
  isStaleWindow,
  killAtMs,
  killPositionsByKill,
  killPositionsSec,
  planShortWindow,
  shortVideoFilter,
  SHORT_DEFAULT_HEAD_SEC,
} from '../src/clipper/shorts.js';

describe('planShortWindow', () => {
  it('a folga padrão antes da 1ª kill é 4s (o gancho precisa de respiro)', () => {
    expect(SHORT_DEFAULT_HEAD_SEC).toBe(4);
    const w = planShortWindow([30, 35, 40], 120);
    expect(w.startSec).toBe(26);
  });

  it('cobre da 1ª à última kill (com folga antes e depois)', () => {
    const w = planShortWindow([15, 18, 21, 24, 52], 59.14, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.startSec).toBe(13);
    expect(w.endSec).toBe(56);
    expect(w.durSec).toBe(43);
    expect(w.includedKills).toEqual([15, 18, 21, 24, 52]);
    expect(w.droppedKills).toEqual([]);
    expect(w.truncated).toBe(false);
  });

  it('corta a jogada longa e reporta as kills que ficaram de fora', () => {
    // Ace de 80s não cabe em 60s: o Short prioriza o CLÍMAX (a 5ª kill)
    // — um Short que termina sem o ace acaba sem payoff, mesmo que tenha
    // mais kills no meio.
    const w = planShortWindow([5, 20, 40, 60, 85], 120, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.startSec).toBe(38);
    expect(w.durSec).toBe(51);
    expect(w.endSec).toBe(89);
    expect(w.includedKills).toEqual([40, 60, 85]);
    expect(w.droppedKills).toEqual([5, 20]);
    expect(w.truncated).toBe(true);
  });

  it('em empate de kills, a janela que inclui o CLÍMAX (última kill) vence', () => {
    // Duas janelas possíveis de 60s com 3 kills: uma começa na 1ª kill
    // (e corta o clímax), outra começa na 2ª e guarda a última kill. O
    // Short tem que terminar no ace.
    const w = planShortWindow([15, 48.1, 57.2, 82.3], 104.3, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.includedKills).toEqual([48.1, 57.2, 82.3]);
    expect(w.droppedKills).toEqual([15]);
    // Sem rabo morto depois do clímax: a janela termina logo depois.
    expect(w.endSec).toBe(86.3);
    expect(w.durSec).toBe(40.2);
  });

  it('mantém TODAS as kills quando elas cabem (o corte é só da cauda)', () => {
    // 15, 18, 18, 36.1, 70.2 num clipe de 78.19s: cabe em 60s.
    const w = planShortWindow([15, 18, 18, 36.1, 70.2], 78.19, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.includedKills).toEqual([15, 18, 18, 36.1, 70.2]);
    expect(w.droppedKills).toEqual([]);
    expect(w.startSec).toBe(13);
    expect(w.endSec).toBe(73);
  });

  it('a 1ª kill é o gancho: fica no começo da janela', () => {
    const w = planShortWindow([30, 35, 40], 120, { headSec: 2, maxSec: 60 });
    expect(w.startSec).toBe(28);
    expect(w.includedKills[0]).toBe(30);
    // A folga de 30s vai para DEPOIS (a 1ª kill não sai do gancho).
    expect(w.endSec).toBe(58);
  });

  it('a 1ª kill no fim do clipe: fica o último minuto do material', () => {
    const w = planShortWindow([118], 120, { maxSec: 60, headSec: 2, tailSec: 4 });
    expect(w.endSec).toBe(120);
    expect(w.durSec).toBe(30);
    expect(w.droppedKills).toEqual([]);
  });

  it('esticado para a duração mínima (Short de 8s perde retenção)', () => {
    const w = planShortWindow([10, 12], 60, { minSec: 30, maxSec: 60, headSec: 2, tailSec: 4 });
    expect(w.durSec).toBe(30);
    expect(w.padded).toBe(true);
    expect(w.startSec).toBe(8);
    expect(w.endSec).toBe(38);
  });

  it('sem kills: começa do início e respeita o máximo', () => {
    const w = planShortWindow([], 45, { maxSec: 60 });
    expect(w.startSec).toBe(0);
    expect(w.durSec).toBe(45);
    expect(w.includedKills).toEqual([]);
    expect(w.truncated).toBe(false);
  });

  it('clip sem duração: não gera janela', () => {
    const w = planShortWindow([10], 0);
    expect(w.durSec).toBe(0);
    expect(w.startSec).toBe(0);
  });
});

describe('killPositionsSec', () => {
  it('converte o relógio do placar no tempo do clipe (com o offset da latência)', () => {
    const positions = killPositionsSec(
      [
        { at: 1793482031411 },
        { at: 1793482034452 },
        { at: 1793482068598 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positions[0]).toBeCloseTo(15, 1);
    expect(positions[1]).toBeCloseTo(18, 1);
    expect(positions[2]).toBeCloseTo(52.2, 1);
  });

  it('aceita o `at` em ISO (sidecar do script de VOD)', () => {
    const positions = killPositionsSec(
      [{ at: '2026-10-31T21:27:11.411Z' }],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positions.length).toBe(1);
    expect(positions[0]).toBeCloseTo(15, 1);
  });

  it('sem o offset da latência: não inventa posição (o corte sairia errado)', () => {
    expect(
      killPositionsSec([{ at: 1793482031411 }], {
        clipStartMs: 1793482037465,
        clipDurationSec: 59.14,
      }),
    ).toEqual([]);
  });

  it('descarta a kill que caiu fora do clipe', () => {
    const positions = killPositionsSec(
      [{ at: 1793482000000 }, { at: 1793482034452 }],
      {
        clipStartMs: 1793482037465,
        killVideoOffsetMs: 21053.67,
        clipDurationSec: 59.14,
      },
    );
    expect(positions.length).toBe(1);
    expect(positions[0]).toBeCloseTo(18, 1);
  });

  it('sem clipStartMs: não inventa posição', () => {
    expect(killPositionsSec([{ at: 1 }], {})).toEqual([]);
  });

  it('killPositionsByKill devolve o índice da kill (metadados honestos)', () => {
    const positioned = killPositionsByKill(
      [
        { at: 1793482000000 },
        { at: 1793482031411 },
        { at: 1793482034452 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positioned.map((p) => p.index)).toEqual([1, 2]);
    expect(positioned[0].sec).toBeCloseTo(15, 1);
  });

  it('kill ESTIMADA (posição não medida) não entra na janela do Short', () => {
    // Abertura limitada pelo teto = a posição vem do palpite: montar a
    // janela em cima dela cortaria o começo do ace e prometeria um
    // horário que ninguém mediu.
    const positioned = killPositionsByKill(
      [
        { at: 1793482031411, estimated: true },
        { at: 1793482034452, estimated: true },
        { at: 1793482037465 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positioned.map((p) => p.index)).toEqual([2]);
  });
});

describe('killAtMs', () => {
  it('lê número e ISO', () => {
    expect(killAtMs(1793482031411)).toBe(1793482031411);
    expect(killAtMs('2026-10-31T21:27:11.411Z')).toBe(
      Date.parse('2026-10-31T21:27:11.411Z'),
    );
    expect(killAtMs('lixo')).toBeNull();
    expect(killAtMs(null)).toBeNull();
  });
});

describe('shortVideoFilter', () => {
  it('corta 9:16 pela altura e escala para 1080x1920', () => {
    const f = shortVideoFilter({ startSec: 0, durSec: 30 });
    expect(f).toContain('crop=ih*9/16:ih');
    expect(f).toContain('scale=1080:1920');
    expect(f).toContain('setsar=1');
  });

  it('o deslocamento horizontal do crop é parametrizável', () => {
    expect(shortVideoFilter({ startSec: 0, durSec: 30, cropX: 0.7 })).toContain(
      '(iw-ih*9/16)*0.7',
    );
    expect(shortVideoFilter({ startSec: 0, durSec: 30, cropX: 5 })).toContain(
      '(iw-ih*9/16)*1',
    );
  });
});

describe('isStaleWindow (o vertical em disco cobre a janela?)', () => {
  const plan = planShortWindow([30, 35, 40], 120, { headSec: 4, tailSec: 4 });

  it('sem vertical gravado não há o que re-renderizar', () => {
    expect(isStaleWindow(null, plan, false)).toBe(false);
  });

  it('sem marker (janela desconhecida) re-renderiza', () => {
    expect(isStaleWindow(null, plan, true)).toBe(true);
    expect(isStaleWindow({ startSec: NaN, durSec: NaN }, plan, true)).toBe(true);
  });

  it('mesma janela = não re-renderiza', () => {
    expect(
      isStaleWindow({ startSec: plan.startSec, durSec: plan.durSec }, plan, true),
    ).toBe(false);
  });

  it('janela diferente (folga/limite mudados) re-renderiza', () => {
    expect(isStaleWindow({ startSec: plan.startSec + 2, durSec: plan.durSec }, plan, true)).toBe(
      true,
    );
    expect(isStaleWindow({ startSec: plan.startSec, durSec: plan.durSec + 5 }, plan, true)).toBe(
      true,
    );
  });

  it('a tolerância é de 50ms (arredondamento não conta como mudança)', () => {
    expect(
      isStaleWindow(
        { startSec: plan.startSec + 0.04, durSec: plan.durSec - 0.04 },
        plan,
        true,
      ),
    ).toBe(false);
  });
});
