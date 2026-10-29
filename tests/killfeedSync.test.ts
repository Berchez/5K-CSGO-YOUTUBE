import { describe, expect, it } from 'vitest';
import {
  estimateStreamOffset,
  killfeedScanWindowMs,
  matchKillfeedText,
  type KillfeedObservation,
} from '../src/clipper/killfeedSync.js';
import type { KillEvent } from '../src/types.js';

function kill(at: number, killer: string, victim: string): KillEvent {
  return {
    matchId: 'm1',
    killer,
    victim,
    weapon: 'AK47',
    at,
    round: 1,
    team: 'A',
  } as KillEvent;
}

describe('killfeedScanWindowMs', () => {
  it('sem faixa, usa o hint com as tolerâncias (comportamento antigo)', () => {
    const kills = [kill(100_000, 'a', 'b'), kill(160_000, 'a', 'c')];
    const window = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 25_000,
    });
    expect(window).toEqual({ startMs: 105_000, endMs: 195_000 });
  });

  it('com faixa de latência, cobre o kill quando o regime subiu', () => {
    const kills = [kill(100_000, 'a', 'b'), kill(160_000, 'a', 'c')];
    const window = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 25_000,
      latencyMaxMs: 70_000,
    });
    expect(window).toEqual({ startMs: 105_000, endMs: 240_000 });
  });

  it('com faixa invertida, a janela começa pela menor latência', () => {
    const kills = [kill(100_000, 'a', 'b')];
    const window = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 70_000,
      latencyMaxMs: 25_000,
    });
    expect(window).toEqual({ startMs: 105_000, endMs: 180_000 });
  });

  it('sem kills com timestamp não há janela', () => {
    expect(
      killfeedScanWindowMs({
        kills: [kill(Number.NaN, 'a', 'b')],
        scoreboardDelayMs: 5_000,
        latencyHintMs: 25_000,
      }),
    ).toBeNull();
  });
});

describe('matchKillfeedText', () => {  it('casa killer e vítima no texto do killfeed', () => {
    const kills = [kill(1_000, 'yuurih', 'zywoo'), kill(2_000, 'sh1ro', 'flameZ')];
    expect(matchKillfeedText('yuurih  >  zywoo   AK47', kills)).toEqual([0]);
    expect(matchKillfeedText('sh1ro > flameZ', kills)).toEqual([1]);
  });

  it('não casa quando falta um dos nomes', () => {
    const kills = [kill(1_000, 'yuurih', 'zywoo')];
    expect(matchKillfeedText('yuurih > someoneelse', kills)).toEqual([]);
    expect(matchKillfeedText('AK47', kills)).toEqual([]);
  });

  it('tolera pontuação/caiés do OCR', () => {
    const kills = [kill(1_000, 'm0NESY', 'ZywOo')];
    expect(matchKillfeedText('m0NESY  [AK47]  ZywOo', kills)).toEqual([0]);
  });
});

describe('estimateStreamOffset', () => {
  it('sem kills com timestamp não há calibração', () => {
    const result = estimateStreamOffset([kill(Number.NaN, 'a', 'b')], [], 5_000, 180);
    expect(result.reason).toBe('no-timestamped-kills');
    expect(result.offsetMs).toBeNull();
    expect(result.firstKillVideoMs).toBeNull();
  });

  it('calcula o offset pelo conjunto consistente e devolve a 1ª kill no vídeo', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 155_000 },
      { killIndex: 2, streamAtMs: 185_000 },
      { killIndex: 3, streamAtMs: 215_000 },
    ];
    // kill.at − atraso do placar + offset = instante no vídeo.
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    expect(result.offsetMs).toBe(30_000);
    expect(result.matchedKills).toBe(4);
    expect(result.firstKillVideoMs).toBe(125_000);
    expect(result.firstKillMatched).toBe(true);
  });

  it('1ª kill fora do OCR: a âncora é DERIVADA do offset (não a 2ª kill)', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    // O OCR não leu a 1ª kill (nome cortado/feed rápido): sem a correção,
    // a âncora viraria 155s (a 2ª kill) e a 1ª ficaria fora do clipe.
    const observations: KillfeedObservation[] = [
      { killIndex: 1, streamAtMs: 155_000 },
      { killIndex: 2, streamAtMs: 185_000 },
      { killIndex: 3, streamAtMs: 215_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    expect(result.matchedKills).toBe(3);
    expect(result.firstKillMatched).toBe(false);
    expect(result.firstKillVideoMs).toBe(125_000);
  });

  it('descarta a leitura errada (nome parecido) e mantém o cluster', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 155_000 },
      { killIndex: 2, streamAtMs: 185_000 },
      { killIndex: 3, streamAtMs: 999_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    expect(result.offsetMs).toBe(30_000);
    expect(result.matchedKills).toBe(3);
    expect(result.firstKillVideoMs).toBe(125_000);
    expect(result.firstKillMatched).toBe(true);
  });

  it('poucas kills casadas: motivo "insufficient-matches"', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
      kill(220_000, 'i', 'j'),
    ];
    const observations: KillfeedObservation[] = [{ killIndex: 0, streamAtMs: 125_000 }];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('insufficient-matches');
    expect(result.offsetMs).toBeNull();
  });

  it('offsets espalhados: motivo "inconsistent-offsets"', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 156_000 },
      { killIndex: 2, streamAtMs: 190_000 },
      { killIndex: 3, streamAtMs: 220_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('inconsistent-offsets');
    expect(result.offsetMs).toBeNull();
    expect(result.firstKillVideoMs).toBeNull();
  });

  it('offset negativo demais é rejeitado (casou o frame errado)', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 80_000 },
      { killIndex: 1, streamAtMs: 110_000 },
      { killIndex: 2, streamAtMs: 140_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('insufficient-matches');
    expect(result.offsetMs).toBeNull();
  });
});
