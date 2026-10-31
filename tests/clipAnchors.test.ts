import { describe, expect, it } from 'vitest';
import { computeAceEndMs, computeClipAnchors, killVideoOffsetMs } from '../src/clipper/clipAnchors.js';

const T = 1_700_000_000_000;

function anchors(overrides: Partial<Parameters<typeof computeClipAnchors>[0]> = {}) {
  return computeClipAnchors({
    aceStartedAtMs: T,
    streamLatencyMs: 25_000,
    scoreboardDelayMs: 5_000,
    scoreDelayMs: 20_000,
    endAfterCloseSec: 8,
    endTailSec: 8,
    contextSec: 10,
    aceDetectedAtMs: T + 60_000,
    scoreboardEndMs: null,
    syncApplied: false,
    syncScanned: true,
    ...overrides,
  });
}

describe('computeClipAnchors (placar → timeline do vídeo)', () => {
  it('converte a âncora do placar para a timeline do vídeo', () => {
    const a = anchors();
    expect(a.videoStartMs).toBe(T + 25_000);
    expect(a.estimatedClipStartMs).toBe(T + 25_000 - 10_000);
    // O offset dos timestamps: latência da stream − atraso do placar.
    expect(a.killVideoOffsetMs).toBe(20_000);
  });

  it('sem âncora de início não inventa clipStart', () => {
    const a = anchors({ aceStartedAtMs: undefined });
    expect(a.videoStartMs).toBeUndefined();
    expect(a.estimatedClipStartMs).toBeUndefined();
  });

  it('a margem do início abre o corte antes (erro de latência assimétrico)', () => {
    const semMargem = anchors({ contextSec: 10, startMarginSec: 0 });
    const comMargem = anchors({ contextSec: 10, startMarginSec: 5 });
    expect(semMargem.estimatedClipStartMs).toBe(T + 15_000);
    expect(comMargem.estimatedClipStartMs).toBe(T + 10_000);
  });

  it('fim ancorado no vídeo: instante do OCR + margem de fechamento', () => {
    const a = anchors({ scoreboardEndMs: T + 200_000, syncApplied: true });
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.usedEstimatedEnd).toBe(false);
    expect(a.usedFallback).toBe(false);
    expect(a.endMs).toBe(T + 208_000);
  });

  it('fim estimado: detecção − atraso do placar + latência + cauda', () => {
    const a = anchors();
    expect(a.usedScoreboardEnd).toBe(false);
    expect(a.usedEstimatedEnd).toBe(true);
    expect(a.usedFallback).toBe(true);
    // 60.000 − 20.000 + 25.000 + 8.000 (fechamento) + 8.000 (cauda)
    expect(a.endMs).toBe(T + 81_000);
  });

  it('a cauda protege o fim estimado (latência subestimada não corta a última kill)', () => {
    const semCauda = anchors({ endTailSec: 0 });
    const comCauda = anchors({ endTailSec: 8 });
    expect(comCauda.endMs - semCauda.endMs).toBe(8_000);
  });

  it('sem OCR (sync desligado) o fim continua estimado, mas sem espera extra', () => {
    const a = anchors({ syncScanned: false });
    expect(a.usedEstimatedEnd).toBe(true);
    expect(a.usedFallback).toBe(false);
  });
});

describe('computeClipAnchors (sanidade do fim lido no OCR)', () => {
  it('REGRESSÃO: virada muito depois do fim estimado é o round seguinte — descarta', () => {
    // Estimativa base: T+81s. A virada lida 119s depois disso é
    // implausível (overlay ilegível na tela de fim/replay).
    const a = anchors({
      scoreboardEndMs: T + 200_000,
      syncApplied: true,
      endPlausibilitySec: 60,
    });
    expect(a.ocrEndRejected).toBe(true);
    expect(a.usedScoreboardEnd).toBe(false);
    expect(a.usedEstimatedEnd).toBe(true);
    expect(a.endMs).toBe(T + 81_000);
  });

  it('virada dentro da tolerância continua ancorando o fim', () => {
    const a = anchors({
      scoreboardEndMs: T + 130_000,
      syncApplied: true,
      endPlausibilitySec: 60,
    });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.endMs).toBe(T + 138_000);
  });

  it('assimetria: virada MAIS CEDO que a estimativa é aceita', () => {
    const a = anchors({
      scoreboardEndMs: T + 50_000,
      syncApplied: true,
      endPlausibilitySec: 60,
    });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.endMs).toBe(T + 58_000);
  });

  it('sem tolerância configurada o clamp fica desligado (compatível)', () => {
    const a = anchors({ scoreboardEndMs: T + 1_000_000, syncApplied: true });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
  });

  it('REGRESSÃO 2399756: virada ANTES do fim do round no jogo é leitura errada — descarta', () => {
    // O vídeo é sempre posterior ao jogo: virada lida 30s antes do round
    // fechar é o placar de outro round (r4/r10: −11s e −10,3s de
    // "latência" → "render vazio").
    const a = anchors({
      scoreboardEndMs: T + 50_000,
      syncApplied: true,
      endPlausibilitySec: 60,
      gameRoundEndedAtMs: T + 80_000,
    });
    expect(a.ocrEndRejected).toBe(true);
    expect(a.usedScoreboardEnd).toBe(false);
    expect(a.endMs).toBe(T + 81_000);
  });

  it('virada depois do fim real do round continua valendo (latência ≥ 0)', () => {
    const a = anchors({
      scoreboardEndMs: T + 130_000,
      syncApplied: true,
      endPlausibilitySec: 60,
      gameRoundEndedAtMs: T + 80_000,
    });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.endMs).toBe(T + 138_000);
  });
});

describe('computeClipAnchors (piso do fim)', () => {
  it('a última kill do ace puxa o fim (a âncora do placar pode ter falhado)', () => {
    // Fim estimado T+81s; a última kill lida pelo killfeed em T+90s →
    // piso T+98s vence (r9/r14 perdiam a última kill).
    const a = anchors({ lastKillVideoMs: T + 90_000 });
    expect(a.endMs).toBe(T + 98_000);
    expect(a.endPinnedBy).toBe('last-kill');
  });

  it('âncora do placar depois da última kill: piso não mexe', () => {
    const a = anchors({ scoreboardEndMs: T + 200_000, syncApplied: true, lastKillVideoMs: T + 90_000 });
    expect(a.endMs).toBe(T + 208_000);
    expect(a.endPinnedBy).toBeNull();
  });

  it('duração mínima: fim antes da própria ação do round é corrigido', () => {
    // Fim estimado T+11s (scoreDelay inflado) < 1ª kill + 10s.
    const a = anchors({ scoreDelayMs: 90_000 });
    expect(a.endMs).toBe(T + 35_000);
    expect(a.endPinnedBy).toBe('min-duration');
  });

  it('sem âncora de início não há piso de duração (só o da última kill)', () => {
    const a = anchors({ aceStartedAtMs: undefined, scoreDelayMs: 90_000, lastKillVideoMs: T + 20_000 });
    expect(a.endMs).toBe(T + 28_000);
    expect(a.endPinnedBy).toBe('last-kill');
  });

  it('piso ESTIMADO da última kill existe sem killfeed (placar confiante) e eleva o fim', () => {
    // Fim estimado T+11s (scoreDelay inflado) cairia ANTES da última kill
    // estimada (at T+50s − 5s + 25s + 8s = T+78s): o piso corrige.
    const a = anchors({ scoreDelayMs: 90_000, lastKillAtMs: T + 50_000 });
    expect(a.endMs).toBe(T + 78_000);
    expect(a.endPinnedBy).toBe('last-kill');
    expect(a.endFloorMs).toBe(T + 78_000);
  });

  it('piso estimado abaixo do fim: endMs intocado, mas endFloorMs vai p/ replay-aware', () => {
    // Fim estimado T+81s; piso estimado T+78s (não prende o fim) — mas é
    // o mínimo que o corte replay-aware respeita.
    const a = anchors({ lastKillAtMs: T + 50_000 });
    expect(a.endMs).toBe(T + 81_000);
    expect(a.endPinnedBy).toBeNull();
    expect(a.endFloorMs).toBe(T + 78_000);
  });

  it('killfeed mediu a última kill: o piso ESTIMADO não entra (evita cauda de 20s+)', () => {
    // Caso real (2399756 r9/r11): endLatency é score→score (61,8s) e
    // colocaria a última kill ~20s depois da posição medida. O piso
    // medido (T+90s + 8s) é o que vale — não o estimado (T+114s).
    const a = anchors({
      scoreboardEndMs: T + 95_000,
      syncApplied: true,
      endPlausibilitySec: 60,
      gameRoundEndedAtMs: T + 80_000,
      lastKillVideoMs: T + 90_000,
      lastKillAtMs: T + 90_000,
    });
    expect(a.endFloorMs).toBe(T + 98_000);
    expect(a.endMs).toBe(T + 103_000);
  });

  it('virada GENUÍNA do placar entra no piso (o round acaba depois da última kill)', () => {
    // Fim ancorado T+138s; piso da virada = T+130s (< fim, não prende).
    const a = anchors({
      scoreboardEndMs: T + 130_000,
      syncApplied: true,
      endPlausibilitySec: 60,
      gameRoundEndedAtMs: T + 80_000,
      lastKillAtMs: T + 50_000,
    });
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.endMs).toBe(T + 138_000);
    expect(a.endFloorMs).toBe(T + 130_000);
  });

  it('tolerância de um poll: virada até SCOREBOARD_DELAY antes do timer vale', () => {
    // O "Round over" do HLTV é OBSERVAÇÃO (poll atrasa ~5s): uma virada
    // genuína em T+76s com o timer em T+80s é plausível (5s de tolerância).
    const a = anchors({
      scoreboardEndMs: T + 76_000,
      syncApplied: true,
      endPlausibilitySec: 60,
      gameRoundEndedAtMs: T + 80_000,
    });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
  });

  it('fim do round ESTIMADO alarga a tolerância em CLIP_SCORE_DELAY_MS', () => {
    // Sem o timer do HLTV, o fim do jogo é detecção − CLIP_SCORE_DELAY_MS
    // e carrega o erro do atraso real de publicação (± o próprio scoreDelay).
    // Uma virada 20s antes do fim estimado ainda pode ser genuína.
    const a = anchors({
      scoreboardEndMs: T + 60_000,
      syncApplied: true,
      endPlausibilitySec: 600,
      gameRoundEndedAtMs: T + 80_000,
      gameEndReference: 'estimada',
      scoreDelayMs: 20_000,
    });
    expect(a.ocrEndRejected).toBe(false);
    expect(a.usedScoreboardEnd).toBe(true);
  });

  it('com timer do HLTV a tolerância é só o poll do placar', () => {
    const a = anchors({
      scoreboardEndMs: T + 60_000,
      syncApplied: true,
      endPlausibilitySec: 600,
      gameRoundEndedAtMs: T + 80_000,
      gameEndReference: 'timer-hltv',
      scoreDelayMs: 20_000,
    });
    expect(a.ocrEndRejected).toBe(true);
    expect(a.usedScoreboardEnd).toBe(false);
  });

  it('piso ESTIMADO não passa do fim GENUÍNO do round (sem cauda extra)', () => {
    // endLatency conservador (90s) jogaria o piso estimado para T+143s —
    // muito depois do fim do round lido (T+90s). A última kill é sempre
    // anterior ao fim: o piso é capado no fim + cauda.
    const a = anchors({
      scoreboardEndMs: T + 90_000,
      syncApplied: true,
      endPlausibilitySec: 600,
      endLatencyMs: 90_000,
      lastKillAtMs: T + 50_000,
    });
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.endMs).toBe(T + 98_000);
    expect(a.endFloorMs).toBe(T + 98_000);
  });
});

describe('computeAceEndMs', () => {
  it('mantém a fórmula histórica (detecção − placar + latência + fechamento)', () => {
    expect(computeAceEndMs(T + 15_000, 10_000, 8)).toBe(T + 13_000);
    expect(computeAceEndMs(T + 15_000, 10_000, 8, 25_000)).toBe(T + 38_000);
  });
});

describe('killVideoOffsetMs', () => {
  it('é a latência da stream menos o atraso do placar', () => {
    expect(killVideoOffsetMs(25_000, 5_000)).toBe(20_000);
    expect(killVideoOffsetMs(20_000, 5_000)).toBe(15_000);
  });
});

describe('computeClipAnchors (latência adaptativa por âncora)', () => {
  it('usa a latência do INÍCIO para abrir o corte e a do FIM para fechar', () => {
    const a = anchors({ startLatencyMs: 40_000, endLatencyMs: 70_000 });
    expect(a.videoStartMs).toBe(T + 40_000);
    expect(a.killVideoOffsetMs).toBe(35_000);
    // Fim estimado: 60.000 − 20.000 + 70.000 + 8.000 + 8.000
    expect(a.endMs).toBe(T + 126_000);
    expect(a.startLatencyMs).toBe(40_000);
    expect(a.endLatencyMs).toBe(70_000);
  });

  it('sem latência específica, cai na latência da stream', () => {
    const a = anchors();
    expect(a.startLatencyMs).toBe(25_000);
    expect(a.endLatencyMs).toBe(25_000);
  });
});
