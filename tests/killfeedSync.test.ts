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

describe('matchKillfeedText (tolerante ao ruído do OCR)', () => {
  it('casa killer e vítima no texto do killfeed', () => {
    const kills = [kill(1_000, 'yuurih', 'zywoo'), kill(2_000, 'sh1ro', 'flameZ')];
    expect(matchKillfeedText('yuurih  >  zywoo   AK47', kills)).toEqual([0]);
    expect(matchKillfeedText('sh1ro > flameZ', kills)).toEqual([1]);
  });

  it('não casa quando falta um dos nomes', () => {
    const kills = [kill(1_000, 'yuurih', 'zywoo')];
    expect(matchKillfeedText('yuurih > someoneelse', kills)).toEqual([]);
    expect(matchKillfeedText('AK47', kills)).toEqual([]);
  });

  it('tolera pontuação/caixas do OCR', () => {
    const kills = [kill(1_000, 'm0NESY', 'ZywOo')];
    expect(matchKillfeedText('m0NESY  [AK47]  ZywOo', kills)).toEqual([0]);
  });

  it('casa confusões 0↔O e 1↔l/I do leitor (2399756: KaiR0N- lido "KaiRON-")', () => {
    const kills = [kill(1_000, 'KaiR0N-', 'jL')];
    expect(matchKillfeedText('KaiRON- PP @~ IL', kills)).toEqual([0]);
    expect(matchKillfeedText('KaiR0N- > jL', kills)).toEqual([0]);
  });

  it('casa com 1 caractere perdido/trocado (2399756: khaN lido "haN", ZywOo lido "ZywOe")', () => {
    const kills = [kill(2_000, 'ZywOo', 'khaN')];
    expect(matchKillfeedText('ZywOe pegfPe— haN', kills)).toEqual([0]);
    expect(matchKillfeedText('ZywOo pfPe— khaN', kills)).toEqual([0]);
  });

  it('self-kill exige o nome 2x (2399756: ZywOo→ZywOo casava qualquer frame)', () => {
    const kills = [kill(1_000, 'ZywOo', 'khaN'), kill(2_000, 'ZywOo', 'ZywOo')];
    expect(matchKillfeedText('ZywOo pfPe— khaN', kills)).toEqual([0]);
    expect(matchKillfeedText('ZywOo > ZywOo', kills)).toEqual([1]);
  });

  it('nomes em linhas diferentes do feed não casam (distância no texto)', () => {
    const kills = [kill(1_000, 'yuurih', 'zywoo')];
    // 12 tokens de ruído entre os dois nomes: linhas distintas do feed.
    const ruido = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    expect(matchKillfeedText(`yuurih ${ruido} zywoo`, kills)).toEqual([]);
  });

  it('nome CURTO exige leitura exata (classe de confusão), não distância 1', () => {
    const kills = [kill(1_000, 'jL', 'khaN')];
    // "IL"/"ll" são leituras plausíveis de "jL" (mesma classe j/i/l/1).
    expect(matchKillfeedText('jL > khaN', kills)).toEqual([0]);
    expect(matchKillfeedText('IL > khaN', kills)).toEqual([0]);
    expect(matchKillfeedText('ll > khaN', kills)).toEqual([0]);
    // "al" NÃO é: distância 1 genérica casaria qualquer token de 2-3
    // letras e abriria a porta para âncora (e descarte) falsos.
    expect(matchKillfeedText('al > khaN', kills)).toEqual([]);
  });
});

describe('estimateStreamOffset', () => {
  it('sem kills com timestamp não há calibração', () => {
    const result = estimateStreamOffset([kill(Number.NaN, 'a', 'b')], [], 5_000, 180);
    expect(result.reason).toBe('no-timestamped-kills');
    expect(result.offsetMs).toBeNull();
    expect(result.firstKillVideoMs).toBeNull();
    expect(result.lastKillVideoMs).toBeNull();
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
    expect(result.clusterKills).toBe(4);
    // A âncora é a 1ª APARIÇÃO da linha menos o atraso de amostragem (1s):
    // abrir 1s antes é o lado barato (o corte nunca perde a kill).
    expect(result.firstKillVideoMs).toBe(124_000);
    expect(result.firstKillMatched).toBe(true);
    expect(result.lastKillVideoMs).toBe(214_000);
    // Offset dos timestamps: direto da leitura da 1ª kill (vídeo − at).
    expect(result.killVideoOffsetMs).toBe(24_000);
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
    expect(result.firstKillVideoMs).toBe(124_000);
    // O offset vem do cluster (para os timestamps), não da leitura direta.
    expect(result.killVideoOffsetMs).toBe(25_000);
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
    expect(result.firstKillVideoMs).toBe(124_000);
    expect(result.firstKillMatched).toBe(true);
  });

  it('uma kill casada sem corroboração: âncora exata, offset sem fonte ("first-kill-only")', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
      kill(220_000, 'i', 'j'),
    ];
    const observations: KillfeedObservation[] = [{ killIndex: 0, streamAtMs: 125_000 }];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    // A linha do killfeed só existe quando o kill aconteceu: a âncora é
    // medição direta e vale mesmo sem corroboração. O offset (latência)
    // é que fica sem fonte confiável.
    expect(result.reason).toBe('first-kill-only');
    expect(result.offsetMs).toBeNull();
    expect(result.firstKillVideoMs).toBe(124_000);
    expect(result.firstKillMatched).toBe(true);
    expect(result.lastKillVideoMs).toBe(124_000);
    expect(result.killVideoOffsetMs).toBe(24_000);
  });

  it('casamento falso TARDE (round seguinte) não empurra a última kill (teto)', () => {
    const kills = [kill(100_000, 'a', 'b'), kill(130_000, 'c', 'd')];
    // A linha da 2ª kill nunca foi lida in-round; no round seguinte o
    // mesmo par killer→vítima reapareceu e casou em 280s (offset 155s,
    // ainda dentro do maxLag de varredura). Sem teto, o piso do fim iria
    // para 279s e o clipe pegaria o round seguinte inteiro.
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 280_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    // Teto = âncora (124s) + intervalo placar entre kills (30s) + 25s.
    expect(result.lastKillVideoMs).toBe(179_000);
  });

  it('offsets divididos: a âncora segue o cluster da 1ª kill (corroborado)', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    // Duas famílias de offset (30/31 e 35/35) — o atraso de poll do placar
    // varia por kill (medido: 5,2s/5,3s/16,4s na mesma partida).
    const observations: KillfeedObservation[] = [
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 156_000 },
      { killIndex: 2, streamAtMs: 190_000 },
      { killIndex: 3, streamAtMs: 220_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    // A 1ª kill tem corroboração (2 kills no cluster): âncora exata.
    expect(result.reason).toBe('confident');
    expect(result.firstKillMatched).toBe(true);
    expect(result.firstKillVideoMs).toBe(124_000);
    expect(result.offsetMs).toBe(30_500);
    expect(result.clusterKills).toBe(2);
  });

  it('offsets espalhados sem a 1ª kill: motivo "inconsistent-offsets"', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 1, streamAtMs: 156_000 },
      { killIndex: 2, streamAtMs: 190_000 },
      { killIndex: 3, streamAtMs: 250_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('inconsistent-offsets');
    expect(result.offsetMs).toBeNull();
    expect(result.firstKillVideoMs).toBeNull();
  });

  it('sem âncora (1ª kill não lida e offsets divididos) não expõe a última kill', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
    ];
    const observations: KillfeedObservation[] = [
      { killIndex: 1, streamAtMs: 156_000 },
      { killIndex: 2, streamAtMs: 190_000 },
      { killIndex: 3, streamAtMs: 250_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('inconsistent-offsets');
    // Sem âncora não há teto: a leitura não pode virar piso do fim (um
    // falso positivo no round seguinte empurraria o corte para o replay).
    expect(result.lastKillVideoMs).toBeNull();
  });

  it('teto também vale para a âncora DERIVADA (1ª kill não lida)', () => {
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
      kill(190_000, 'g', 'h'),
      kill(220_000, 'i', 'j'),
    ];
    // Trio corroborado (offset 30s) + um casamento falso no round seguinte.
    const observations: KillfeedObservation[] = [
      { killIndex: 1, streamAtMs: 155_000 },
      { killIndex: 2, streamAtMs: 185_000 },
      { killIndex: 3, streamAtMs: 215_000 },
      { killIndex: 4, streamAtMs: 350_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    expect(result.firstKillMatched).toBe(false);
    expect(result.firstKillVideoMs).toBe(124_000);
    // Teto = âncora derivada (124s) + intervalo placar (120s) + 25s.
    expect(result.lastKillVideoMs).toBe(269_000);
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
