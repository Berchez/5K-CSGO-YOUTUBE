import { describe, expect, it } from 'vitest';
import { evaluateAceCoverage } from '../src/detector/aceCoverage.js';
import type { KillEvent } from '../src/types.js';

function kill(at: number): KillEvent {
  return { killer: 'jcobbb', victim: '', round: 5, map: 'Nuke', at };
}

describe('evaluateAceCoverage (footage do ace no buffer)', () => {
  it('mantém o ace quando pelo menos uma kill está no buffer', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000), kill(200_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(1);
    expect(coverage.truncatedStart).toBe(true);
  });

  it('descarta o evento quando nenhuma kill está no buffer (fantasma)', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000), kill(2_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(true);
    expect(coverage.killsInBuffer).toBe(0);
  });

  it('round longo: âncora fora do buffer, mas com kills no buffer = não descarta', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(190_000), kill(195_000), kill(200_000), kill(205_000)],
      anchorMs: 100_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(4);
    expect(coverage.truncatedStart).toBe(true);
  });

  it('sem segmentos não descarta (o chamador decide o resto)', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: null,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(0);
  });

  it('compara na timeline do vídeo (a latência da stream entra na conta)', () => {
    // O `at` da kill é o instante no relógio do JOGO; o buffer é a
    // timeline do VÍDEO (jogo + latência da stream). Sem a latência, a
    // kill parece anterior ao material gravado e o evento é descartado.
    const coverage = evaluateAceCoverage({
      kills: [kill(140_000)],
      anchorMs: 160_000,
      oldestSegmentStartMs: 150_000,
      streamLatencyMs: 20_000,
    });
    expect(coverage.killsInBuffer).toBe(1);
    expect(coverage.discard).toBe(false);
    const semLatencia = evaluateAceCoverage({
      kills: [kill(140_000)],
      anchorMs: 140_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(semLatencia.killsInBuffer).toBe(0);
  });

  it('desconta o atraso do placar (o `at` é a OBSERVAÇÃO, não o jogo)', () => {
    // O placar mostra a kill 5s depois dela acontecer: sem descontar, a
    // kill parece 5s mais nova no vídeo do que é (e o ace "ganha"
    // footage que ainda não foi gravado).
    const coverage = evaluateAceCoverage({
      kills: [kill(140_000)],
      anchorMs: 140_000,
      oldestSegmentStartMs: 158_000,
      streamLatencyMs: 20_000,
      scoreboardDelayMs: 5_000,
    });
    expect(coverage.killsInBuffer).toBe(0);
    const semDesconto = evaluateAceCoverage({
      kills: [kill(140_000)],
      anchorMs: 140_000,
      oldestSegmentStartMs: 158_000,
      streamLatencyMs: 20_000,
    });
    expect(semDesconto.killsInBuffer).toBe(1);
  });
});

describe('evaluateAceCoverage (cobertura estrita — F5, evidência forte)', () => {
  it('REGRESSÃO: 1ª kill fora do material → descarta com régua conservadora', () => {
    // Caso típico do round longo: as últimas kills estão no buffer, mas
    // a abertura do ace (e a 1ª kill) já saiu — o clipe não é o ace. A
    // régua aqui é o TETO (posição mais tarde possível): se nem ela
    // alcança o buffer, nenhuma latência menor alcança.
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(190_000), kill(200_000)],
      anchorMs: 100_000,
      oldestSegmentStartMs: 150_000,
      strict: true,
      rulerTrusted: true,
    });
    expect(coverage.killsInBuffer).toBe(2);
    expect(coverage.firstKillInBuffer).toBe(false);
    expect(coverage.discard).toBe(true);
    expect(coverage.discardReason).toBe('first-kill-missing');
  });

  it('sem strict mantém o comportamento antigo (produz truncado)', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(200_000)],
      anchorMs: 100_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.truncatedStart).toBe(true);
    expect(coverage.discardReason).toBe('none');
  });

  it('posição EXATA da 1ª kill (killfeed) fora do buffer → descarta', () => {
    // A régua (latência 100s) colocaria a 1ª kill em 195s (dentro), mas
    // o killfeed MEDIU 120s: medição vence estimativa.
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(190_000)],
      anchorMs: 190_000,
      oldestSegmentStartMs: 150_000,
      streamLatencyMs: 100_000,
      scoreboardDelayMs: 5_000,
      strict: true,
      firstKillVideoMsTrusted: 120_000,
    });
    expect(coverage.firstKillInBuffer).toBe(false);
    expect(coverage.discard).toBe(true);
    expect(coverage.discardReason).toBe('first-kill-missing');
  });

  it('posição EXATA da 1ª kill dentro do buffer → régua otimista não derruba', () => {
    // Sem a medição, a régua (latência 0) diria 95s → fora → descartaria.
    // O killfeed mediu 160s: o ace fica.
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(190_000)],
      anchorMs: 190_000,
      oldestSegmentStartMs: 150_000,
      streamLatencyMs: 0,
      strict: true,
      firstKillVideoMsTrusted: 160_000,
    });
    expect(coverage.firstKillInBuffer).toBe(true);
    expect(coverage.discard).toBe(false);
    expect(coverage.discardReason).toBe('none');
  });

  it('REGRESSÃO 2399756: régua não medida + OCR sem a 1ª kill NÃO descarta', () => {
    // O descarte antigo ("killfeed varreu e não viu") destruiu 3 aces
    // bons com 1 kill casada: nomes truncados são comuns (khaN→haN) e
    // régua subestimada move a 1ª kill para fora do buffer no papel.
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(190_000), kill(200_000)],
      anchorMs: 100_000,
      oldestSegmentStartMs: 150_000,
      strict: true,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.discardReason).toBe('none');
  });

  it('régua medida no vídeo (killfeed) que diz "fora" → descarta', () => {
    // Offset do killfeed: a 1ª kill (at 100s, delay 5s) está em 115s —
    // antes do buffer (150s). Régua medida = evidência.
    const coverage = evaluateAceCoverage({
      kills: [kill(100_000), kill(190_000)],
      anchorMs: 115_000,
      oldestSegmentStartMs: 150_000,
      streamLatencyMs: 20_000,
      scoreboardDelayMs: 5_000,
      strict: true,
      rulerTrusted: true,
    });
    expect(coverage.firstKillInBuffer).toBe(false);
    expect(coverage.discard).toBe(true);
    expect(coverage.discardReason).toBe('first-kill-missing');
  });

  it('fantasma (nenhuma kill no buffer) descarta independente do strict', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000), kill(2_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(true);
    expect(coverage.discardReason).toBe('no-kills');
  });
});
