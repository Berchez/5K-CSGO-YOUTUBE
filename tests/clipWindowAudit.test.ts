import { describe, expect, it } from 'vitest';
import { looksLikeReplay, resolveReplayCrop } from '../src/clipper/killfeedSync.js';
import { resolveClipStartAnchor } from '../src/clipper/clipAnchors.js';
import { focusedScoreCrop, parseFocusedScoreText, parseFractionCrop, splitPngFrames } from '../src/clipper/clipWindowOcr.js';
import {
  assessKillfeedCoverage,
  assessOpeningScoreCoverage,
  clipWindowValidationPassed,
  clipWindowValidationRequired,
  clipWindowValidationShouldRun,
  nextOpeningScoreRetryOffsetMs,
  nextClipStartCorrectionMs,
  nextClipEndCorrectionMs,
  clipStartCorrectionReason,
  clipEndCorrectionReason,
  replayStartsWithinOpening,
  auditClipWindow,
  distinctKillRounds,
  killMaxGapMs,
  killSpreadMs,
  suspectKillsSpread,
  trustedRoundEndVideoMs,
} from '../src/clipper/clipWindowAudit.js';
import type { KillEvent } from '../src/types.js';

/**
 * Regressões do caso 2399858_Mirage_r15_makazze (o clipe abriu no REPLAY
 * do round e o 5K ao vivo ficou de fora) e do 2399858_Ancient_r6_kyousuke
 * (a lista de kills misturou dois rounds e o clipe atravessou a partida).
 */

const T = 1_793_625_493_241; // 2026-11-02T13:18:13.241Z (qualquer base serve)

describe('assessKillfeedCoverage (validação do MP4 renderizado)', () => {
  it('só confirma quando todas as kills esperadas aparecem', () => {
    expect(
      assessKillfeedCoverage({ expectedKills: 4, matchedKillIndexes: [0, 1, 2, 3, 3], frames: 36 }),
    ).toEqual({ status: 'verified', matchedKillIndexes: [0, 1, 2, 3] });
  });

  it('marca cobertura parcial como incompleta', () => {
    expect(
      assessKillfeedCoverage({ expectedKills: 4, matchedKillIndexes: [1, 2], frames: 36 }),
    ).toEqual({ status: 'incomplete', matchedKillIndexes: [1, 2] });
  });

  it('não aceita kills lidas longe do horário estimado do ace (provável replay)', () => {
    expect(
      assessKillfeedCoverage({
        expectedKills: 2,
        matchedKillIndexes: [0, 1],
        occurrences: [
          { killIndex: 0, atSec: 54 },
          { killIndex: 1, atSec: 58 },
        ],
        expectedKillAtSec: [15, 22],
        timingToleranceSec: 15,
        frames: 67,
      }),
    ).toEqual({ status: 'incomplete', matchedKillIndexes: [] });
  });

  it('não confunde falta de OCR com clipe validado', () => {
    expect(
      assessKillfeedCoverage({ expectedKills: 4, matchedKillIndexes: [], frames: 0, error: 'OCR indisponível' }),
    ).toEqual({ status: 'unverifiable', matchedKillIndexes: [] });
  });
});

describe('assessOpeningScoreCoverage (round alvo no início do MP4)', () => {
  it('confirma quando o placar anterior aparece no início', () => {
    expect(assessOpeningScoreCoverage({
      expectedBefore: '6-5', expectedAfter: '6-6',
      observations: [{ atSec: 0, score: '6-5' }, { atSec: 1, score: '5-6' }],
    }).status).toBe('verified');
  });

  it('classifica como tardia a abertura que só lê scoreBefore depois do scoreAfter', () => {
    expect(assessOpeningScoreCoverage({
      expectedBefore: '6-5', expectedAfter: '6-6',
      observations: [
        { atSec: 0, score: '6-6' },
        { atSec: 1, score: '6-6' },
        { atSec: 7, score: '6-5' },
        { atSec: 8, score: '6-5' },
      ],
    }).status).toBe('late');
  });

  it('detecta clipe que já começa no placar seguinte, inclusive com lado trocado', () => {
    expect(assessOpeningScoreCoverage({
      expectedBefore: '6-5', expectedAfter: '6-6',
      observations: [{ atSec: 0, score: '6-6' }, { atSec: 1, score: '6-6' }],
    }).status).toBe('late');
  });

  it('retém como inconclusivo quando OCR não consegue ler o placar', () => {
    expect(assessOpeningScoreCoverage({
      expectedBefore: '6-5', expectedAfter: '6-6', observations: [], error: 'OCR indisponível',
    })).toEqual({ status: 'unverifiable', observedScores: [], retryable: false });
  });

  it('tenta outra janela quando o OCR lê placar, mas ainda não consegue confirmá-lo', () => {
    expect(assessOpeningScoreCoverage({
      expectedBefore: '6-5', expectedAfter: '6-6',
      observations: [{ atSec: 1, score: '6-5' }],
    })).toEqual({ status: 'unverifiable', observedScores: ['6-5'], retryable: true });
  });
});

describe('clipWindowValidationPassed (publicação)', () => {
  it('só libera com killfeed e placar de abertura confirmados', () => {
    expect(clipWindowValidationPassed('verified', 'verified')).toBe(true);
    expect(clipWindowValidationPassed('verified', 'verified', 'replay-only')).toBe(false);
    expect(clipWindowValidationPassed('verified', 'verified', 'discard')).toBe(false);
    expect(clipWindowValidationPassed('incomplete', 'verified')).toBe(false);
    expect(clipWindowValidationPassed('verified', 'late')).toBe(false);
    expect(clipWindowValidationPassed('verified', undefined)).toBe(false);
    expect(clipWindowValidationPassed(undefined, undefined)).toBe(false);
  });
});

describe('política da validação visual', () => {
  it('não permite que off/shadow liberem uploads sem executar a medição', () => {
    expect(clipWindowValidationShouldRun(true, 'off')).toBe(true);
    expect(clipWindowValidationRequired(true, 'off')).toBe(true);
    expect(clipWindowValidationShouldRun(true, 'shadow')).toBe(true);
    expect(clipWindowValidationRequired(true, 'shadow')).toBe(true);
    expect(clipWindowValidationShouldRun(false, 'off')).toBe(false);
    expect(clipWindowValidationRequired(false, 'shadow')).toBe(false);
  });
});

describe('nextOpeningScoreRetryOffsetMs (correção de abertura tardia)', () => {
  it('reconstrói em passos de 15s só quando o placar prova abertura tardia', () => {
    expect(nextOpeningScoreRetryOffsetMs('late', 0)).toBe(15_000);
    expect(nextOpeningScoreRetryOffsetMs('late', 45_000)).toBe(60_000);
    expect(nextOpeningScoreRetryOffsetMs('late', 60_000)).toBeNull();
    expect(nextOpeningScoreRetryOffsetMs('unverifiable', 0, true)).toBe(15_000);
    expect(nextOpeningScoreRetryOffsetMs('unverifiable', 0, false)).toBeNull();
    expect(nextOpeningScoreRetryOffsetMs('verified', 0)).toBeNull();
  });
});

describe('nextClipStartCorrectionMs (re-render com mais material anterior)', () => {
  it('avança em passos limitados de 15s até no máximo 60s', () => {
    expect(nextClipStartCorrectionMs(0)).toBe(15_000);
    expect(nextClipStartCorrectionMs(45_000)).toBe(60_000);
    expect(nextClipStartCorrectionMs(60_000)).toBeNull();
  });
});

describe('correção de cauda (re-render com mais material posterior)', () => {
  it('estende o fim em passos limitados de 15s até no máximo 60s', () => {
    expect(nextClipEndCorrectionMs(0)).toBe(15_000);
    expect(nextClipEndCorrectionMs(45_000)).toBe(60_000);
    expect(nextClipEndCorrectionMs(60_000)).toBeNull();
  });

  it('estende só quando a última kill está ausente perto do fim ou só no replay', () => {
    const base = {
      expectedKills: 4,
      matchedKillIndexes: [0, 1, 2],
      expectedLastKillAtSec: 58,
      clipDurationSec: 60,
      replayKillIndexes: [],
    };
    expect(clipEndCorrectionReason(base)).toBe('última kill prevista encostada no fim do clipe');
    expect(clipEndCorrectionReason({ ...base, replayKillIndexes: [3] })).toBe('última kill só apareceu durante replay');
    expect(clipEndCorrectionReason({ ...base, matchedKillIndexes: [0, 1, 2, 3] })).toBeNull();
    expect(clipEndCorrectionReason({ ...base, expectedLastKillAtSec: 30 })).toBeNull();
  });
});

describe('replayStartsWithinOpening (banner no começo do clipe)', () => {
  it('não confunde replay posterior com abertura no replay', () => {
    expect(replayStartsWithinOpening([56, 67, 68])).toBe(false);
    expect(replayStartsWithinOpening([0, 1])).toBe(true);
    expect(replayStartsWithinOpening([1, 3])).toBe(false);
  });
});

describe('clipStartCorrectionReason (corrige a janela antes de desistir)', () => {
  const base = {
    openingScoreStatus: 'verified' as const,
    openingScoreRetryable: false,
    matchedKillIndexes: [0, 1, 2, 3],
    firstExpectedKillAtSec: 24,
    replayKillIndexes: [],
  };

  it('corrige placar tardio ou ambíguo', () => {
    expect(clipStartCorrectionReason({ ...base, openingScoreStatus: 'late' })).toBe('placar do round seguinte na abertura');
    expect(clipStartCorrectionReason({ ...base, openingScoreStatus: 'unverifiable', openingScoreRetryable: true })).toBe('placar de abertura ambíguo');
  });

  it('puxa para trás quando a primeira kill encosta na borda ou só aparece no replay', () => {
    expect(clipStartCorrectionReason({ ...base, matchedKillIndexes: [1, 2, 3], firstExpectedKillAtSec: 8 })).toBe('primeira kill encostada no início do clipe');
    expect(clipStartCorrectionReason({ ...base, matchedKillIndexes: [1, 2, 3], replayKillIndexes: [0] })).toBe('kill esperada só apareceu durante replay');
  });

  it('não refaz uma janela confirmada', () => {
    expect(clipStartCorrectionReason(base)).toBeNull();
  });
});

describe('OCR do placar focado', () => {
  it('deriva o crop central dos dígitos a partir do crop de placar configurado', () => {
    expect(focusedScoreCrop('0.30:0.03:0.40:0.10')).toBe('0.4348:0.0260:0.1408:0.0930');
  });

  it('tolera ruído OCR pequeno entre os dois dígitos do placar', () => {
    expect(parseFocusedScoreText('6 .: 6')).toBe('6-6');
    expect(parseFocusedScoreText('6 2 6')).toBeNull();
    expect(parseFocusedScoreText('bro')).toBeNull();
  });
});

function kill(at: number, victim = 'x', round = 15): KillEvent {
  return { killer: 'makazze', victim, round, map: 'Mirage', at };
}

describe('splitPngFrames (os frames do ffmpeg em pipe)', () => {
  /** PNG sintético: assinatura + IHDR + IEND (o parser só caminha os chunks). */
  function png(payload: string): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    return Buffer.concat([
      signature,
      chunk('IHDR', Buffer.from(payload.padEnd(16, 'x'), 'latin1')),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  it('separa a sequência de PNGs colados', () => {
    const a = png('a');
    const b = png('b');
    const split = splitPngFrames(Buffer.concat([a, b]));
    expect(split.frames).toHaveLength(2);
    expect(split.frames[0]?.equals(a)).toBe(true);
    expect(split.frames[1]?.equals(b)).toBe(true);
    expect(split.rest.length).toBe(0);
  });

  it('não confunde os bytes "IEND" dentro dos dados comprimidos', () => {
    // Procurar a sequência IEND nos bytes crus truncava o frame no meio
    // (o sharp reclamava "unsupported image format").
    const a = png('IEND');
    const b = png('b');
    const split = splitPngFrames(Buffer.concat([a, b]));
    expect(split.frames).toHaveLength(2);
    expect(split.frames[0]?.equals(a)).toBe(true);
    expect(split.frames[1]?.equals(b)).toBe(true);
  });

  it('guarda o resto (frame incompleto) sem perder o que já leu', () => {
    const a = png('a');
    const incomplete = png('b').subarray(0, 12);
    const split = splitPngFrames(Buffer.concat([a, incomplete]));
    expect(split.frames).toHaveLength(1);
    expect(split.rest.length).toBe(incomplete.length);
  });
});

describe('parseFractionCrop (o crop do OCR)', () => {
  it('aceita um crop válido', () => {
    expect(parseFractionCrop('0.00:0.00:0.35:0.10')).toEqual({ x: 0, y: 0, w: 0.35, h: 0.1 });
  });

  it('rejeita crop inválido (fora da tela, sem tamanho, lixo)', () => {
    expect(parseFractionCrop('0.90:0.00:0.30:0.10')).toBeNull();
    expect(parseFractionCrop('0.00:0.00:0.00:0.10')).toBeNull();
    expect(parseFractionCrop('lixo')).toBeNull();
  });
});

describe('looksLikeReplay (banner REPLAY do HLTV)', () => {
  it('reconhece o banner', () => {
    expect(looksLikeReplay('REPLAY')).toBe(true);
    expect(looksLikeReplay('Pp 2138 REPLAY')).toBe(true);
    expect(looksLikeReplay('IEM BEIJING 2026 GROUPSTAGE 8 6')).toBe(false);
  });

  it('aguenta o erro do OCR no banner', () => {
    // O OCR erra o R como P/I: sem tolerância a guarda não pega o replay.
    expect(looksLikeReplay('REPIAY')).toBe(true);
    expect(looksLikeReplay('REPLAV')).toBe(true);
  });

  it('não confunde texto do placar com o banner', () => {
    expect(looksLikeReplay('GROUP STAGE 15-8')).toBe(false);
    expect(looksLikeReplay('')).toBe(false);
    expect(looksLikeReplay('repl')).toBe(false);
  });
});

describe('resolveReplayCrop (o crop do banner por canal)', () => {
  it('usa o crop global quando o canal não tem entrada', () => {
    const r = resolveReplayCrop({ globalCrop: '0.00:0.00:0.35:0.10' });
    expect(r.crop).toBe('0.00:0.00:0.35:0.10');
    expect(r.warnings).toEqual([]);
  });

  it('o crop do canal tem precedência sobre o global', () => {
    const r = resolveReplayCrop({
      globalCrop: '0.00:0.00:0.35:0.10',
      byStreamRaw: '{"gaules": "0.00:0.00:0.30:0.08"}',
      streamName: 'gaules',
    });
    expect(r.crop).toBe('0.00:0.00:0.30:0.08');
  });

  it('o prefixo do canal casa ("gaules" serve para "gaules 2")', () => {
    const r = resolveReplayCrop({
      globalCrop: '0.00:0.00:0.35:0.10',
      byStreamRaw: '{"gaules": "0.00:0.00:0.30:0.08"}',
      streamName: 'Gaules 2',
    });
    expect(r.crop).toBe('0.00:0.00:0.30:0.08');
  });

  it('crop inválido no mapa por canal é AVISADO (não silencioso)', () => {
    const r = resolveReplayCrop({
      globalCrop: '0.00:0.00:0.35:0.10',
      byStreamRaw: '{"gaules": "0.90:0.00:0.30:0.10"}',
      streamName: 'gaules',
    });
    expect(r.warnings.join(' ')).toContain('inválido');
  });

  it('crop global inválido desliga a guarda e avisa', () => {
    const r = resolveReplayCrop({ globalCrop: 'lixo' });
    expect(r.crop).toBeNull();
    expect(r.warnings.join(' ')).toContain('DESLIGADA');
  });
});

describe('resolveClipStartAnchor (a âncora que abre o clipe)', () => {
  it('sem killfeed usa a âncora do placar', () => {
    const a = resolveClipStartAnchor({ scoreboardVideoStartMs: T });
    expect(a.videoStartMs).toBe(T);
    expect(a.source).toBe('placar');
  });

  it('com killfeed mais CEDO, o killfeed abre', () => {
    const a = resolveClipStartAnchor({
      killfeedStartMs: T,
      scoreboardVideoStartMs: T + 10_000,
    });
    expect(a.videoStartMs).toBe(T);
    expect(a.source).toBe('killfeed');
  });

  it('o MENOR vence: âncora do placar mais cedo abre antes (abrir cedo não perde nada)', () => {
    const a = resolveClipStartAnchor({
      killfeedStartMs: T + 10_000,
      scoreboardVideoStartMs: T,
    });
    expect(a.videoStartMs).toBe(T);
    expect(a.source).toBe('placar');
  });

  it('REGRESSÃO 2399858: a âncora do REPLAY (mais tarde) nunca vence o placar', () => {
    // O killfeed leu a linha na REEXIBIÇÃO (13:18:57) e o placar, com o
    // teto de latência, aponta o round ao vivo (13:18:35). A janela
    // errada nasceu de deixar a leitura única vencer.
    const a = resolveClipStartAnchor({
      killfeedStartMs: T + 22_330,
      scoreboardVideoStartMs: T + 5_000,
    });
    expect(a.videoStartMs).toBe(T + 5_000);
    expect(a.source).toBe('placar');
  });

  it('as duas âncoras iguais são registradas como as duas', () => {
    const a = resolveClipStartAnchor({
      killfeedStartMs: T,
      scoreboardVideoStartMs: T,
    });
    expect(a.source).toBe('killfeed+placar');
  });
});

describe('suspectKillsSpread (a lista de kills é de um round só?)', () => {
  it('ace normal (dispersão de 28s) não é suspeito', () => {
    const kills = [kill(T), kill(T + 3_000), kill(T + 28_000)];
    expect(killSpreadMs(kills)).toBe(28_000);
    expect(suspectKillsSpread(kills, { spreadMaxMs: 120_000, gapMaxMs: 90_000 }).suspect).toBe(false);
  });

  it('REGRESSÃO 2399858_Ancient_r6: kills de dois rounds → suspeito', () => {
    const kills = [
      kill(T),
      kill(T + 3_000),
      kill(T + 3_000),
      kill(T + 117_000),
      kill(T + 117_000),
    ];
    const check = suspectKillsSpread(kills, { spreadMaxMs: 120_000, gapMaxMs: 90_000 });
    expect(check.suspect).toBe(true);
    expect(check.spreadMs).toBe(117_000);
    expect(check.maxGapMs).toBe(114_000);
    expect(check.reason).toContain('rounds diferentes');
  });

  it('round DISTINTO no evento é sinal forte (sem depender do relógio)', () => {
    const kills = [kill(T), kill(T + 2_000), kill(T + 4_000, 'y', 16)];
    expect(distinctKillRounds(kills)).toEqual([15, 16]);
    const check = suspectKillsSpread(kills, { spreadMaxMs: 120_000, gapMaxMs: 90_000 });
    expect(check.suspect).toBe(true);
    expect(check.reason).toContain('rounds diferentes');
  });

  it('intervalo enorme entre kills consecutivas é suspeito (mesmo round)', () => {
    const kills = [kill(T), kill(T + 3_000), kill(T + 117_000)];
    const check = suspectKillsSpread(kills, { spreadMaxMs: 120_000, gapMaxMs: 90_000 });
    expect(check.suspect).toBe(true);
    expect(check.reason).toContain('intervalo');
  });

  it('round lento (pós-plant) acima do limite antigo só AVISA, não descarta', () => {
    // 100s entre a 1ª e a 5ª kill do MESMO round: o limite antigo (60s)
    // accusava um round legítimo de mistura de rounds.
    const kills = [kill(T), kill(T + 20_000), kill(T + 45_000), kill(T + 70_000), kill(T + 100_000)];
    const check = suspectKillsSpread(kills, { spreadMaxMs: 120_000, gapMaxMs: 90_000 });
    expect(check.suspect).toBe(false);
    expect(check.warning).toBe(true);
  });

  it('uma kill só não tem dispersão', () => {
    expect(suspectKillsSpread([kill(T)], { spreadMaxMs: 120_000, gapMaxMs: 90_000 }).suspect).toBe(false);
  });

  it('killMaxGapMs mede o maior intervalo entre kills consecutivas', () => {
    expect(killMaxGapMs([kill(T), kill(T + 3_000), kill(T + 20_000)])).toBe(17_000);
  });
});

describe('trustedRoundEndVideoMs (o fim do round é EVIDÊNCIA?)', () => {
  it('só o motivo confident serve como medida do fim do round', () => {
    expect(
      trustedRoundEndVideoMs({ reason: 'confident', roundEndAt: new Date(T).toISOString() }),
    ).toBe(T);
    expect(trustedRoundEndVideoMs({ reason: 'after-only', roundEndAt: new Date(T).toISOString() })).toBeNull();
    expect(
      trustedRoundEndVideoMs({ reason: 'gap-inferred', roundEndAt: new Date(T).toISOString() }),
    ).toBeNull();
    expect(trustedRoundEndVideoMs({ reason: 'no-transition', roundEndAt: new Date(T).toISOString() })).toBeNull();
  });

  it('um fim rejeitado pelos anchors não serve', () => {
    expect(
      trustedRoundEndVideoMs({
        reason: 'confident',
        roundEndAt: new Date(T).toISOString(),
        ocrEndRejected: true,
      }),
    ).toBeNull();
  });

  it('aceita epoch ms e ISO 8601', () => {
    expect(trustedRoundEndVideoMs({ reason: 'confident', roundEndAt: T })).toBe(T);
  });
});

describe('auditClipWindow (invariantes da janela)', () => {
  it('janela dentro das invariantes: publica', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 10_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.action).toBe('ok');
  });

  it('abre depois da 1ª kill → violação (não descarta sem evidência forte)', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 40_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
    });
    expect(verdict.violations).toContain('abre-depois-da-1a-kill');
    expect(verdict.coversFirstKill).toBe(false);
  });

  it('kills de rounds diferentes → descarta', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 117_000, 'y', 16)],
      clipStartMs: T,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
    });
    expect(verdict.violations).toContain('kills-de-rounds-diferentes');
    expect(verdict.action).toBe('discard');
  });

  it('abre depois do fim do round com material ao vivo → descarta', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 60_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      roundEndVideoMs: T + 50_000,
      bufferOldestMs: T - 10_000,
    });
    expect(verdict.violations).toContain('abre-depois-do-fim-do-round');
    expect(verdict.action).toBe('discard');
  });

  it('só tinha replay (material ao vivo fora do buffer) → replay-only, não descarte', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 60_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      roundEndVideoMs: T + 50_000,
      bufferOldestMs: T + 55_000,
    });
    expect(verdict.startsAfterRoundEnd).toBe(true);
    expect(verdict.liveMaterialAvailable).toBe(false);
    expect(verdict.action).toBe('replay-only');
  });

  it('a âncora do killfeed posterior ao fim do round é sinalizada', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 60_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      killfeedFirstKillVideoMs: T + 60_000,
      killfeedReason: 'first-kill-only',
      roundEndVideoMs: T + 50_000,
      bufferOldestMs: T - 10_000,
    });
    expect(verdict.anchorLooksLikeReplay).toBe(true);
  });

  it('o atraso do placar entra na posição esperada (o `at` é o poll)', () => {
    // O kill aconteceu 5s ANTES do `at` (poll do HLTV): a posição
    // esperada no vídeo é (at − 5s) + latência. Sem o desconto, a
    // expectativa erra para o lado tarde.
    const verdict = auditClipWindow({
      kills: [kill(T)],
      clipStartMs: T + 20_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      scoreboardDelayMs: 5_000,
    });
    expect(verdict.expectedFirstKillVideoMs).toBe(T + 20_000);
    expect(verdict.coversFirstKill).toBe(true);
  });

  it('o banner de REPLAY no início do clipe é evidência de janela errada', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 60_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      bufferOldestMs: T - 10_000,
      opensInsideReplay: true,
    });
    expect(verdict.action).toBe('discard');
  });

  it('sem o banner, a janela dentro das invariantes continua publicando', () => {
    const verdict = auditClipWindow({
      kills: [kill(T), kill(T + 20_000)],
      clipStartMs: T + 10_000,
      clipDurationSec: 60,
      startLatencyMs: 25_000,
      endLatencyMs: 25_000,
      opensInsideReplay: false,
    });
    expect(verdict.action).toBe('ok');
  });
});
