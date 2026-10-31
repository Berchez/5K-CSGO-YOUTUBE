import { describe, expect, it } from 'vitest';
import {
  gameRoundEndMs,
  latencyMapProblem,
  observedLatencyMs,
  parseLatencyMap,
  resolveAdaptiveLatency,
  resolveStreamLatencyMs,
  shouldApplyAdaptive,
  StreamLatencyTracker,
  type LatencySample,
} from '../src/monitor/streamLatency.js';

describe('parseLatencyMap', () => {
  it('lê o JSON do mapa por canal', () => {
    expect(parseLatencyMap('{"Gaules": 22000, "ESL TV": 30000}')).toEqual({
      gaules: 22_000,
      'esl tv': 30_000,
    });
  });

  it('aceita número como string', () => {
    expect(parseLatencyMap('{"Gaules": "22000"}')).toEqual({ gaules: 22_000 });
  });

  it('ignora JSON inválido, arrays e valores fora da faixa', () => {
    expect(parseLatencyMap('não é json')).toEqual({});
    expect(parseLatencyMap('[1,2]')).toEqual({});
    expect(parseLatencyMap('{"a": -1}')).toEqual({});
    expect(parseLatencyMap('{"a": 999999}')).toEqual({});
    expect(parseLatencyMap('{"a": "abc"}')).toEqual({});
  });

  it('vazio quando não configurado', () => {
    expect(parseLatencyMap(undefined)).toEqual({});
    expect(parseLatencyMap('  ')).toEqual({});
  });
});

describe('resolveStreamLatencyMs', () => {
  const byStream = { gaules: 22_000, 'esl tv': 30_000 };

  it('usa o valor do canal quando existe', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'Gaules')).toBe(22_000);
    expect(resolveStreamLatencyMs(25_000, byStream, 'ESL TV')).toBe(30_000);
  });

  it('casa canal com sufixo (prefixo do configurado no nome real)', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'Gaules 2')).toBe(22_000);
  });

  it('não casa por "includes" genérico (tv não casa "ESL TV")', () => {
    // Com includes nos dois sentidos, "tv" casaria "ESL TV" e a ordem
    // de inserção do mapa decidiria o vencedor.
    const mapa = { tv: 9_000, 'esl tv': 30_000 };
    expect(resolveStreamLatencyMs(25_000, mapa, 'ESL TV')).toBe(30_000);
    expect(resolveStreamLatencyMs(25_000, { tv: 9_000 }, 'ESL TV')).toBe(25_000);
  });

  it('prefixo mais longo vence (Gaules 2 não cai no "gaules gaules")', () => {
    const mapa = { gaules: 20_000, 'gaules 2': 33_000 };
    expect(resolveStreamLatencyMs(25_000, mapa, 'Gaules 2')).toBe(33_000);
  });

  it('cai no global quando não há entrada para o canal', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'IEM Katowice')).toBe(25_000);
    expect(resolveStreamLatencyMs(25_000, byStream, undefined)).toBe(25_000);
  });
});

describe('latencyMapProblem (aviso de mapa inválido)', () => {
  it('mapa vazio não é problema', () => {
    expect(latencyMapProblem(undefined)).toBeNull();
    expect(latencyMapProblem('  ')).toBeNull();
  });

  it('detecta JSON inválido, array e valores fora da faixa', () => {
    expect(latencyMapProblem('não é json')).toBe('JSON inválido');
    expect(latencyMapProblem('[1,2]')).toContain('objeto');
    expect(latencyMapProblem('{"a": -1}')).toContain('faixa');
    expect(latencyMapProblem('{}')).toContain('vazio');
  });

  it('mapa válido não gera aviso', () => {
    expect(latencyMapProblem('{"Gaules": 22000}')).toBeNull();
  });
});

describe('observedLatencyMs', () => {
  it('é a virada no vídeo menos o fechamento real do round', () => {
    // Round fechou (relógio do jogo) em T+40s; a virada apareceu no vídeo em T+62s.
    expect(observedLatencyMs(1_062_000, 1_040_000)).toBe(22_000);
  });
});

describe('gameRoundEndMs', () => {
  it('usa o fim real do round quando o placar mostrou "Round over"', () => {
    expect(
      gameRoundEndMs({ aceDetectedAtMs: 1_060_000, scoreDelayMs: 20_000, roundEndedAtMs: 1_040_000 }),
    ).toBe(1_040_000);
  });

  it('sem o fim real, estima pela detecção menos o atraso do placar', () => {
    expect(gameRoundEndMs({ aceDetectedAtMs: 1_060_000, scoreDelayMs: 20_000 })).toBe(1_040_000);
    expect(
      gameRoundEndMs({ aceDetectedAtMs: 1_060_000, scoreDelayMs: 20_000, roundEndedAtMs: null }),
    ).toBe(1_040_000);
  });
});

describe('StreamLatencyTracker', () => {
  it('guarda as últimas 5 amostras por canal e devolve a mediana', () => {
    const tracker = new StreamLatencyTracker();
    [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].forEach((ms) =>
      tracker.record('Gaules', ms),
    );
    expect(tracker.samplesCount('Gaules')).toBe(5);
    // Depois de 60.000 a janela é [20k,30k,40k,50k,60k] → mediana 40k.
    expect(tracker.median('Gaules')).toBe(40_000);
  });

  it('separa os canais e devolve null sem medição', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 22_000);
    expect(tracker.median('gaules')).toBe(22_000);
    expect(tracker.median('ESL TV')).toBeNull();
    expect(tracker.median(undefined)).toBeNull();
  });

  it('ignora valores inválidos', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', Number.NaN);
    expect(tracker.samplesCount('Gaules')).toBe(0);
  });

  it('descarta amostras fora da faixa plausível (OCR casou o round errado)', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', -5_000);
    tracker.record('Gaules', 300_000);
    expect(tracker.samplesCount('Gaules')).toBe(0);
    tracker.record('Gaules', 22_000);
    expect(tracker.median('Gaules')).toBe(22_000);
  });
});

describe('StreamLatencyTracker (amostras com timestamp)', () => {
  it('a amostra mais recente antes de um instante é a do regime vigente', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 40_000, { measuredAtMs: 1_000 });
    tracker.record('Gaules', 55_000, { measuredAtMs: 2_000 });
    tracker.record('Gaules', 70_000, { measuredAtMs: 3_000 });
    // O evento aconteceu em 2.500: a amostra em vigor era a de 2.000.
    expect(tracker.latestBefore('Gaules', 2_500)?.latencyMs).toBe(55_000);
    // Antes da 1ª medição não há amostra (nem inventada).
    expect(tracker.latestBefore('Gaules', 500)).toBeNull();
    expect(tracker.latest('Gaules')?.latencyMs).toBe(70_000);
  });

  it('a janela recente ignora amostras antigas (idade), o histórico não', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 90_000, { measuredAtMs: 1_000 });
    tracker.record('Gaules', 20_000, { measuredAtMs: 2_000 });
    tracker.record('Gaules', 25_000, { measuredAtMs: 3_000 });
    const now = 3_000 + 60_000;
    expect(tracker.recent('Gaules', 3, 61_000, now).map((s) => s.latencyMs)).toEqual([
      20_000,
      25_000,
    ]);
    expect(tracker.recentMax('Gaules', 3, 61_000, now)).toBe(25_000);
    // O histórico completo não perde a amostra antiga (só a janela ignora).
    expect(tracker.allSamples('Gaules')).toHaveLength(3);
    expect(tracker.recent('Gaules', 3, 15 * 60_000, now)).toHaveLength(3);
  });

  it('memoriza o crop do placar que funcionou no canal', () => {
    const tracker = new StreamLatencyTracker();
    expect(tracker.crop('Gaules')).toBeNull();
    tracker.setCrop('Gaules', '0.02:0.02:0.30:0.14');
    expect(tracker.crop('gaules')).toBe('0.02:0.02:0.30:0.14');
    expect(tracker.crop('ESL TV')).toBeNull();
  });

  it('crop do KILLFEED é separado do crop do placar e persiste', () => {
    const tracker = new StreamLatencyTracker();
    tracker.setCrop('gaules', '0.02:0.02:0.30:0.14');
    tracker.setKillfeedCrop('gaules', '0.70:0.05:0.30:0.25');
    expect(tracker.crop('Gaules')).toBe('0.02:0.02:0.30:0.14');
    expect(tracker.killfeedCrop('Gaules')).toBe('0.70:0.05:0.30:0.25');
    const restored = StreamLatencyTracker.fromJSON(JSON.parse(JSON.stringify(tracker.toJSON())));
    expect(restored.crop('Gaules')).toBe('0.02:0.02:0.30:0.14');
    expect(restored.killfeedCrop('Gaules')).toBe('0.70:0.05:0.30:0.25');
  });

  it('serializa e reconstitui o estado (persistência entre reinícios)', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 33_000, {
      measuredAtMs: 1_000,
      source: 'scoreboard',
      quality: 'confident',
      reference: 'timer-hltv',
    });
    tracker.setCrop('Gaules', '0.10:0.02:0.30:0.14');
    const restored = StreamLatencyTracker.fromJSON(JSON.parse(JSON.stringify(tracker.toJSON())));
    expect(restored.median('Gaules')).toBe(33_000);
    expect(restored.latest('Gaules')?.measuredAtMs).toBe(1_000);
    expect(restored.latest('Gaules')?.reference).toBe('timer-hltv');
    expect(restored.crop('Gaules')).toBe('0.10:0.02:0.30:0.14');
    expect(restored.channels()).toEqual(['gaules']);
  });

  it('ignora estado corrompido (JSON de outro formato)', () => {
    const restored = StreamLatencyTracker.fromJSON({ streams: 'nope' });
    expect(restored.channels()).toEqual([]);
    expect(restored.median('Gaules')).toBeNull();
  });

  it('rejeita versão de schema desconhecida (estado vazio)', () => {
    const restored = StreamLatencyTracker.fromJSON({
      version: 99,
      streams: { gaules: { samples: [{ measuredAtMs: 1_000, latencyMs: 30_000, source: 'scoreboard', quality: 'confident' }] } },
    });
    expect(restored.channels()).toEqual([]);
  });

  it('amostras v1 não sobrevivem (after-only envenenado), mas crops sim', () => {
    // v2: after-only deixou de ser latência — as AMOSTRAS do arquivo v1
    // saem; os crops memorizados são independentes do schema e valem
    // (inclusive o do killfeed).
    const restored = StreamLatencyTracker.fromJSON({
      version: 1,
      streams: {
        gaules: {
          samples: [{ measuredAtMs: 1_000, latencyMs: 58_779, source: 'scoreboard', quality: 'after-only' }],
          crop: '0.02:0.02:0.30:0.14',
          killfeedCrop: '0.70:0.05:0.30:0.25',
        },
      },
    });
    expect(restored.median('Gaules')).toBeNull();
    expect(restored.crop('Gaules')).toBe('0.02:0.02:0.30:0.14');
    expect(restored.killfeedCrop('Gaules')).toBe('0.70:0.05:0.30:0.25');
  });

  it('só amostras confident sobrevivem à restauração (after-only não é latência)', () => {
    const restored = StreamLatencyTracker.fromJSON({
      version: 2,
      streams: {
        gaules: {
          samples: [
            { measuredAtMs: 3_000, latencyMs: 58_779, source: 'scoreboard', quality: 'after-only', reference: 'timer-hltv' },
            { measuredAtMs: 4_000, latencyMs: 33_000, source: 'scoreboard', quality: 'confident', reference: 'timer-hltv' },
          ],
        },
      },
    });
    expect(restored.allSamples('Gaules').map((s) => s.latencyMs)).toEqual([33_000]);
  });

  it('rejeita origem/qualidade desconhecidas em vez de normalizar', () => {
    const restored = StreamLatencyTracker.fromJSON({
      version: 2,
      streams: {
        gaules: {
          samples: [
            { measuredAtMs: 1_000, latencyMs: 30_000, source: 'ocr', quality: 'confident' },
            { measuredAtMs: 2_000, latencyMs: 31_000, source: 'scoreboard', quality: 'maybe' },
            { measuredAtMs: 0, latencyMs: 32_000, source: 'scoreboard', quality: 'confident' },
            { measuredAtMs: 3_000, latencyMs: 33_000, source: 'killfeed', quality: 'confident', reference: 'estimada' },
            { measuredAtMs: 4_000, latencyMs: 34_000, source: 'scoreboard', quality: 'confident', reference: 'guess' },
          ],
        },
      },
    });
    expect(restored.channels()).toEqual(['gaules']);
    expect(restored.allSamples('Gaules').map((s) => s.latencyMs)).toEqual([33_000]);
    expect(restored.latest('Gaules')?.reference).toBe('estimada');
  });

  it('ordena por instante e limita as amostras restauradas por canal', () => {
    const samples = [5_000, 1_000, 7_000, 3_000, 6_000, 2_000, 4_000].map((at, index) => ({
      measuredAtMs: at,
      latencyMs: 10_000 + index,
      source: 'scoreboard',
      quality: 'confident',
    }));
    const restored = StreamLatencyTracker.fromJSON({
      version: 2,
      streams: { gaules: { samples } },
    });
    const kept = restored.allSamples('Gaules');
    expect(kept.map((s) => s.measuredAtMs)).toEqual([3_000, 4_000, 5_000, 6_000, 7_000]);
    // Mantém as MAIS RECENTES, como o ring buffer em memória.
    expect(restored.latest('Gaules')?.measuredAtMs).toBe(7_000);
    expect(restored.samplesCount('Gaules')).toBe(5);
  });
});

function sample(measuredAtMs: number, latencyMs: number): LatencySample {
  return { measuredAtMs, latencyMs, source: 'scoreboard', quality: 'confident' };
}

describe('resolveAdaptiveLatency', () => {
  it('sem medição: usa o valor configurado', () => {
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: [],
      recentSamples: [],
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.startLatencyMs).toBe(25_000);
    expect(decision.endLatencyMs).toBe(25_000);
    expect(decision.startSource).toBe('config');
    expect(decision.changed).toBe(false);
  });

  it('REGRESSÃO 2399756: amostra after-only não alimenta o início (cai no configurado)', () => {
    // As 5 amostras do gaules eram after-only (58-63s para 45s reais):
    // usá-las como latência do início abriu o clipe 1s antes da 1ª kill.
    const afterOnly: LatencySample = {
      measuredAtMs: 1_000,
      latencyMs: 60_000,
      source: 'scoreboard',
      quality: 'after-only',
    };
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: [afterOnly],
      recentSamples: [afterOnly],
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.startLatencyMs).toBe(25_000);
    expect(decision.startSource).toBe('config');
    // O FIM continua conservador (fechar mais tarde nunca perde a kill).
    expect(decision.endLatencyMs).toBe(60_000);
  });

  it('a última amostra CONFIDENT anterior vence (mesmo com after-only mais recente)', () => {
    const confident = sample(1_000, 45_000);
    const afterOnly: LatencySample = {
      measuredAtMs: 2_000,
      latencyMs: 62_000,
      source: 'scoreboard',
      quality: 'after-only',
    };
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: [confident, afterOnly],
      recentSamples: [confident, afterOnly],
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.startLatencyMs).toBe(45_000);
    expect(decision.startSource).toBe('prior');
    expect(decision.endLatencyMs).toBe(62_000);
  });

  it('amostra confident com fim ESTIMADO não alimenta o início (erro de CLIP_SCORE_DELAY_MS)', () => {
    // Sem o timer do HLTV, o "fim do round" é detecção − 20s: o erro do
    // atraso de publicação (±20s) ia junto para a âncora do início.
    const estimada: LatencySample = {
      measuredAtMs: 1_000,
      latencyMs: 60_000,
      source: 'scoreboard',
      quality: 'confident',
      reference: 'estimada',
    };
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: [estimada],
      recentSamples: [estimada],
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.startLatencyMs).toBe(25_000);
    expect(decision.startSource).toBe('config');
    // O fim continua conservador (a amostra ainda é candidata).
    expect(decision.endLatencyMs).toBe(60_000);
  });

  it('amostra do fim do round MAIOR não adianta o início (pode ter subido após o kill)', () => {
    const prior = [sample(1_000, 40_000)];
    const current = sample(2_000, 42_000);
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    // A medição é do FIM do round: usá-la no início deslocaria a abertura
    // para frente e poderia cortar a 1ª kill.
    expect(decision.startLatencyMs).toBe(40_000);
    expect(decision.startSource).toBe('prior');
    expect(decision.endLatencyMs).toBe(42_000);
    expect(decision.changed).toBe(false);
  });

  it('round trocou de regime: abre pelo MENOR valor (nunca perde a 1ª kill)', () => {
    const prior = [sample(1_000, 60_000)];
    const current = sample(2_000, 20_000);
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.changed).toBe(true);
    expect(decision.deltaMs).toBe(-40_000);
    expect(decision.startLatencyMs).toBe(20_000);
    expect(decision.startSource).toBe('min-safe');
  });

  it('salto do relógio de origem NÃO move o início por inferência', () => {
    const prior = [sample(1_000, 30_000)];
    const current = sample(2_000, 55_000);
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current,
      pendingShiftMs: 25_000,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    // O salto do PDT é ambíguo (atraso × conteúdo omitido): o início fica
    // na amostra anterior (abre mais cedo) e o killfeed é que mede.
    expect(decision.startLatencyMs).toBe(30_000);
    expect(decision.startSource).toBe('prior');
  });

  it('salto sem medição do round: o fim abre pelo lado conservador', () => {
    const prior = [sample(1_000, 30_000)];
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current: null,
      pendingShiftMs: 25_000,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.startLatencyMs).toBe(30_000);
    expect(decision.endLatencyMs).toBe(55_000);
  });

  it.each([5_000, 10_000, 15_000, 30_000])(
    'aumento de %i ms no meio do round não adianta o início',
    (delta) => {
      const prior = [sample(1_000, 40_000)];
      const current = sample(2_000, 40_000 + delta);
      const decision = resolveAdaptiveLatency({
        configuredMs: 25_000,
        priorSamples: prior,
        recentSamples: prior,
        current,
        maxStepMs: 20_000,
        eventAtMs: 61_000,
      });
      expect(decision.startLatencyMs).toBe(40_000);
      expect(decision.changed).toBe(delta > 20_000);
      // O fim continua usando o valor medido (fechar mais tarde é barato).
      expect(decision.endLatencyMs).toBe(40_000 + delta);
    },
  );

  it.each([5_000, 10_000, 15_000, 30_000])(
    'redução de %i ms no meio do round antecipa o início (seguro)',
    (delta) => {
      const prior = [sample(1_000, 60_000)];
      const current = sample(2_000, 60_000 - delta);
      const decision = resolveAdaptiveLatency({
        configuredMs: 25_000,
        priorSamples: prior,
        recentSamples: prior,
        current,
        maxStepMs: 20_000,
        eventAtMs: 61_000,
      });
      expect(decision.startLatencyMs).toBe(60_000 - delta);
      expect(decision.startSource).toBe(delta > 20_000 ? 'min-safe' : 'current');
    },
  );

  it('sem âncora do OCR: o fim estimado usa o MÁXIMO da janela recente', () => {
    const recent = [sample(1_000, 40_000), sample(2_000, 75_000), sample(3_000, 50_000)];
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: recent,
      recentSamples: recent,
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.endLatencyMs).toBe(75_000);
    expect(decision.startLatencyMs).toBe(50_000);
    expect(decision.startSource).toBe('prior');
  });

  it('medição só "after-only": o fim fica no máximo entre ela e a janela', () => {
    const recent = [sample(1_000, 75_000)];
    const current: LatencySample = {
      measuredAtMs: 2_000,
      latencyMs: 40_000,
      source: 'scoreboard',
      quality: 'after-only',
    };
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: recent,
      recentSamples: recent,
      current,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.endLatencyMs).toBe(75_000);
  });

  it('medição confiante no fim: ela manda (é a mais próxima da última kill)', () => {
    const recent = [sample(1_000, 75_000)];
    const current = sample(2_000, 40_000);
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: recent,
      recentSamples: recent,
      current,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.endLatencyMs).toBe(40_000);
  });

  it('informa a idade da amostra anterior (amostra antiga = confiança baixa)', () => {
    const prior = [sample(1_000, 40_000)];
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: [],
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
    });
    expect(decision.priorAgeMs).toBe(60_000);
    expect(decision.startLatencyMs).toBe(40_000);
  });

  it('amostra anterior velha e MAIOR que o configurado: início usa o configurado', () => {
    const prior = [sample(1_000, 80_000)];
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
      maxPriorAgeMs: 30_000,
    });
    // O regime pode ter mudado (restart/outra partida): abrir pelo
    // configurado é mais cedo que pela amostra velha — não perde a kill.
    expect(decision.startLatencyMs).toBe(25_000);
    expect(decision.startSource).toBe('config');
    expect(decision.priorAgeMs).toBe(60_000);
    // O fim continua conservador (fechar mais tarde é barato).
    expect(decision.endLatencyMs).toBe(80_000);
  });

  it('amostra anterior velha e MENOR que o configurado: mantém a amostra', () => {
    const prior = [sample(1_000, 10_000)];
    const decision = resolveAdaptiveLatency({
      configuredMs: 25_000,
      priorSamples: prior,
      recentSamples: prior,
      current: null,
      maxStepMs: 20_000,
      eventAtMs: 61_000,
      maxPriorAgeMs: 30_000,
    });
    expect(decision.startLatencyMs).toBe(10_000);
    expect(decision.startSource).toBe('prior');
  });
});

describe('shouldApplyAdaptive (modos do sync)', () => {
  it("só aplica no modo 'auto'", () => {
    expect(shouldApplyAdaptive('auto', true)).toBe(true);
    expect(shouldApplyAdaptive('log', true)).toBe(false);
    expect(shouldApplyAdaptive('off', true)).toBe(false);
    expect(shouldApplyAdaptive('auto', false)).toBe(false);
  });
});
