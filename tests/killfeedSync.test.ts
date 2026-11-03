import { describe, expect, it } from 'vitest';
import {
  estimateStreamOffset,
  killfeedExpectedWindowStartMs,
  killfeedScanWindowMs,
  matchKillfeedText,
  orderCrops,
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
  it('começa no instante MAIS CEDO plausível, sem depender do hint (regressão 2399858)', () => {
    // Hint de 45s fazia a janela começar em at1+25s — exatamente onde o
    // corte abre. A 1ª kill (no vídeo ~at1+20s) nunca era lida.
    const kills = [kill(100_000, 'a', 'b'), kill(160_000, 'a', 'c')];
    const window = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 45_000,
      latencyMaxMs: 90_000,
    });
    // A tolerância ANTES da kill é de 5s (=|MIN_ALLOWED_OFFSET_MS|): antes
    // disso a leitura seria DESCARTADA pelo filtro de faixa — varrer era
    // custo de OCR sem chance de match.
    expect(window).toEqual({ startMs: 90_000, endMs: 260_000 });
  });

  it('o hint não muda o início (só o limite superior)', () => {
    const kills = [kill(100_000, 'a', 'b'), kill(160_000, 'a', 'c')];
    const base = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 25_000,
    });
    const higher = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 70_000,
    });
    expect(base!.startMs).toBe(higher!.startMs);
    expect(higher!.endMs).toBeGreaterThan(base!.endMs);
  });

  it('com faixa invertida, o fim usa o maior dos dois (nunca corta a kill)', () => {
    const kills = [kill(100_000, 'a', 'b')];
    const window = killfeedScanWindowMs({
      kills,
      scoreboardDelayMs: 5_000,
      latencyHintMs: 70_000,
      latencyMaxMs: 25_000,
    });
    expect(window).toEqual({ startMs: 90_000, endMs: 180_000 });
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

describe('orderCrops (custo do OCR)', () => {
  const crops = [
    { raw: 'a:0:0:1:1' },
    { raw: 'b:0:0:1:1' },
    { raw: 'c:0:0:1:1' },
  ];

  it('sem crop usado, mantém a ordem original', () => {
    expect(orderCrops(crops, null).map((c) => c.raw)).toEqual(['a:0:0:1:1', 'b:0:0:1:1', 'c:0:0:1:1']);
  });

  it('o crop que já leu o killfeed vai PRIMEIRO (sticky)', () => {
    // Cada segmento da janela testava a cadeia inteira de crops (4×
    // ffmpeg + ~10 frames de tesseract): o custo do OCR é o gargalo.
    expect(orderCrops(crops, 'b:0:0:1:1').map((c) => c.raw)).toEqual([
      'b:0:0:1:1',
      'a:0:0:1:1',
      'c:0:0:1:1',
    ]);
  });

  it('crop usado que não está na lista não muda nada', () => {
    expect(orderCrops(crops, 'z:0:0:1:1').map((c) => c.raw)).toEqual([
      'a:0:0:1:1',
      'b:0:0:1:1',
      'c:0:0:1:1',
    ]);
  });

  it('não mexe na lista original', () => {
    const original = [...crops];
    orderCrops(crops, 'c:0:0:1:1');
    expect(crops).toEqual(original);
  });
});

describe('killfeedExpectedWindowStartMs (janela esperada)', () => {
  it('é o instante da 1ª kill + a latência estimada − a tolerância', () => {
    const kills = [kill(100_000, 'a', 'b'), kill(160_000, 'a', 'c')];
    // 100.000 − 5.000 (atraso do placar) + 25.000 (latência) − 5.000
    expect(
      killfeedExpectedWindowStartMs({
        kills,
        scoreboardDelayMs: 5_000,
        latencyHintMs: 25_000,
      }),
    ).toBe(115_000);
  });

  it('sem kills com timestamp não há janela esperada', () => {
    expect(
      killfeedExpectedWindowStartMs({
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
    // O offset vem do cluster (para os timestamps), não da leitura direta —
    // e desconta o atraso de aparecimento do killfeed (1s), como a âncora
    // derivada: sem isso as marcas de tempo ficavam 1s fora do vídeo.
    expect(result.killVideoOffsetMs).toBe(24_000);
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

  it('falso positivo na banda negativa NÃO come a leitura legítima', () => {
    // A janela começa 15s antes do tempo de jogo da kill: um falso
    // positivo do OCR nessa banda era o "first seen" e, descartado
    // depois pelo MIN_ALLOWED, levava junto a leitura legítima (a kill
    // ficava sem observação → 'insufficient-matches').
    const kills = [kill(100_000, 'a', 'b'), kill(130_000, 'c', 'd')];
    const observations: KillfeedObservation[] = [
      // Falso positivo: offset −8s (abaixo de MIN_ALLOWED = −5s).
      { killIndex: 0, streamAtMs: 87_000 },
      // Leitura legítima: offset +30s.
      { killIndex: 0, streamAtMs: 125_000 },
      { killIndex: 1, streamAtMs: 155_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    expect(result.matchedKills).toBe(2);
    expect(result.offsetMs).toBe(30_000);
    // A âncora é a leitura legítima (125s), não o falso positivo.
    expect(result.firstKillVideoMs).toBe(124_000);
    expect(result.firstKillMatched).toBe(true);
  });

  it('leitura de REPLAY é rejeitada e NÃO vira âncora', () => {
    // A linha lida com o banner "REPLAY" na tela é a REXIBIÇÃO da kill
    // (o replay repete o killfeed do round): usá-la como âncora abre o
    // clipe depois do round e perde o ace ao vivo (2399858_Mirage_r15).
    const kills = [
      kill(100_000, 'a', 'b'),
      kill(130_000, 'c', 'd'),
      kill(160_000, 'e', 'f'),
    ];
    const observations: KillfeedObservation[] = [
      // A 1ª kill só apareceu na REXIBIÇÃO (bem depois do round).
      { killIndex: 0, streamAtMs: 200_000, replay: true },
      { killIndex: 1, streamAtMs: 155_000 },
      { killIndex: 2, streamAtMs: 185_000 },
    ];
    const result = estimateStreamOffset(kills, observations, 5_000, 180);
    expect(result.reason).toBe('confident');
    // Só as 2 leituras ao vivo entram no cluster.
    expect(result.matchedKills).toBe(2);
    expect(result.firstKillMatched).toBe(false);
    // A âncora vem do offset do cluster (125s), não da leitura de replay.
    expect(result.firstKillVideoMs).toBe(124_000);
    const rejected = (result.rejected ?? []).filter((entry) => entry.reason === 'replay');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.killIndex).toBe(0);
    expect(rejected[0]?.streamAtMs).toBe(200_000);
  });
});
