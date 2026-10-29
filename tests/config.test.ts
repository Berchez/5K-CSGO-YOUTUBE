import { describe, expect, it } from 'vitest';
import {
  boolEnv,
  ConfigSchema,
  deprecatedEnvVars,
  divergentLatencyEnvs,
  invalidBoolEnvs,
  parseBoolEnv,
} from '../src/config.js';

describe('boolEnv', () => {
  it('aceita 1/true/yes/on como ligado', () => {
    expect(boolEnv('1', false)).toBe(true);
    expect(boolEnv('true', false)).toBe(true);
    expect(boolEnv('TRUE', false)).toBe(true);
    expect(boolEnv(' yes ', false)).toBe(true);
    expect(boolEnv('on', false)).toBe(true);
  });

  it('aceita 0/false/no/off como desligado', () => {
    expect(boolEnv('0', true)).toBe(false);
    expect(boolEnv('false', true)).toBe(false);
    expect(boolEnv('OFF', true)).toBe(false);
  });

  it('vazio ou valor desconhecido usa o default', () => {
    expect(boolEnv(undefined, true)).toBe(true);
    expect(boolEnv('', true)).toBe(true);
    expect(boolEnv('   ', false)).toBe(false);
    expect(boolEnv('talvez', true)).toBe(true);
  });
});

describe('parseBoolEnv (fonte única de verdade do ligado/desligado)', () => {
  it('aceita as formas de ligado', () => {
    expect(parseBoolEnv('1')).toBe(true);
    expect(parseBoolEnv('true')).toBe(true);
    expect(parseBoolEnv('TRUE')).toBe(true);
    expect(parseBoolEnv('yes')).toBe(true);
    expect(parseBoolEnv('on')).toBe(true);
    expect(parseBoolEnv('sim')).toBe(true);
  });

  it('aceita as formas de desligado (inclusive com acento)', () => {
    expect(parseBoolEnv('0')).toBe(false);
    expect(parseBoolEnv('false')).toBe(false);
    expect(parseBoolEnv('no')).toBe(false);
    expect(parseBoolEnv('off')).toBe(false);
    expect(parseBoolEnv('nao')).toBe(false);
    expect(parseBoolEnv('não')).toBe(false);
  });

  it('valor desconhecido = null (o chamador decide o default)', () => {
    expect(parseBoolEnv('flase')).toBeNull();
    expect(parseBoolEnv('')).toBeNull();
    expect(parseBoolEnv(undefined)).toBeNull();
  });
});

describe('envs depreciadas', () => {
  it('lista as que ainda estão no ambiente', () => {
    expect(deprecatedEnvVars({ CLIP_AV_SYNC: '1', AV_STATIC_OFFSET_MS: '' })).toEqual([
      'CLIP_AV_SYNC',
    ]);
  });

  it('nada definido = nada a avisar', () => {
    expect(deprecatedEnvVars({})).toEqual([]);
  });
});

describe('envs booleanas inválidas', () => {
  it('avisa o valor que não é ligado/desligado', () => {
    expect(invalidBoolEnvs({ GEMINI_WEB_HEADLESS: 'flase' })).toEqual([
      'GEMINI_WEB_HEADLESS=flase',
    ]);
  });

  it('aceita as formas válidas (1/0/true/false/sim/não)', () => {
    expect(
      invalidBoolEnvs({
        TOP_TIER_ONLY: '1',
        POLL_ADAPTIVE: 'false',
        HLTV_CLOSE_BROWSER_IDLE: 'on',
        YT_UPLOAD: '0',
        GEMINI_WEB_HEADLESS: 'TRUE',
        CHATGPT_MINIMIZED: 'no',
        GROK_MINIMIZED: '',
      }),
    ).toEqual([]);
  });

  it('não olha envs que não são booleanas', () => {
    expect(invalidBoolEnvs({ POLL_INTERVAL_MS: 'talvez' })).toEqual([]);
  });
});

describe('config dos clipes (latência e âncoras)', () => {
  it('defaults: 25s de latência, 20s de atraso do placar final e 8s de cauda', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.CLIP_STREAM_LATENCY_MS).toBe(25_000);
    expect(cfg.CLIP_SCORE_DELAY_MS).toBe(20_000);
    expect(cfg.CLIP_END_TAIL_SEC).toBe(8);
    expect(cfg.CLIP_STREAM_LATENCY_BY_STREAM).toEqual({});
  });
  it('lê o mapa de latência por canal', () => {
    const cfg = ConfigSchema.parse({
      CLIP_STREAM_LATENCY_BY_STREAM: '{"Gaules": 22000, "ESL TV": 30000}',
    });
    expect(cfg.CLIP_STREAM_LATENCY_BY_STREAM).toEqual({ gaules: 22_000, 'esl tv': 30_000 });
  });

  it('mapa inválido não derruba o bot (fica vazio = global)', () => {
    const cfg = ConfigSchema.parse({ CLIP_STREAM_LATENCY_BY_STREAM: 'nao é json' });
    expect(cfg.CLIP_STREAM_LATENCY_BY_STREAM).toEqual({});
  });
});

describe('envs de latência com valor diferente do default', () => {
  it('lista as que divergem (o .env antigo desloca o corte)', () => {
    expect(
      divergentLatencyEnvs({ SCOREBOARD_DELAY_MS: '10000', CLIP_STREAM_LATENCY_MS: '25000' }),
    ).toEqual(['SCOREBOARD_DELAY_MS']);
  });

  it('ignora as ausentes, vazias ou iguais ao default (copy do .env.example)', () => {
    expect(divergentLatencyEnvs({})).toEqual([]);
    expect(divergentLatencyEnvs({ SCOREBOARD_DELAY_MS: '  ' })).toEqual([]);
    expect(
      divergentLatencyEnvs({
        SCOREBOARD_DELAY_MS: '5000',
        CLIP_STREAM_LATENCY_MS: '25000',
        CLIP_SCORE_DELAY_MS: '20000',
      }),
    ).toEqual([]);
  });
});

describe('formato de captura', () => {
  it('default = melhor variante combinada da fonte', () => {
    expect(ConfigSchema.parse({}).CAPTURE_FORMAT).toBe('best');
  });

  it('aceita outro seletor combinado (kill-switch da captura)', () => {
    expect(ConfigSchema.parse({ CAPTURE_FORMAT: 'best[height<=1080]' }).CAPTURE_FORMAT).toBe(
      'best[height<=1080]',
    );
  });

  it('seletor vazio volta para o padrão (não derruba o bot)', () => {
    expect(ConfigSchema.parse({ CAPTURE_FORMAT: '  ' }).CAPTURE_FORMAT).toBe('best');
  });
});
