import { describe, expect, it } from 'vitest';
import {
  boolEnv,
  cappedLatencyChannels,
  ConfigSchema,
  deprecatedEnvVars,
  divergentLatencyEnvs,
  invalidBoolEnvs,
  normalizeShortsHashtag,
  parseBoolEnv,
  shortsCrossFieldErrors,
  validateConfigCrossFields,
} from '../src/config.js';

describe('cappedLatencyChannels (aviso do teto de abertura)', () => {
  const base = {
    capMs: 25_000,
    globalMs: 25_000,
    byStream: {} as Record<string, number>,
    applyAdaptive: true,
  };

  it('não avisa nada quando tudo cabe no teto', () => {
    expect(cappedLatencyChannels(base)).toEqual([]);
  });

  it('avisa o canal configurado acima do teto', () => {
    expect(
      cappedLatencyChannels({
        ...base,
        byStream: { gaules: 45_000 },
      }),
    ).toEqual([{ channel: 'gaules', configuredMs: 45_000 }]);
  });

  it('avisa o global acima do teto', () => {
    expect(
      cappedLatencyChannels({
        ...base,
        globalMs: 40_000,
      }),
    ).toEqual([{ channel: '(global)', configuredMs: 40_000 }]);
  });

  it('canal COM MEDIÇÃO não é avisado (o teto não age nele)', () => {
    expect(
      cappedLatencyChannels({
        ...base,
        byStream: { gaules: 45_000 },
        measuredChannels: ['Gaules'],
      }),
    ).toEqual([]);
  });

  it('com o adaptativo desligado o teto não age (nada a avisar)', () => {
    expect(
      cappedLatencyChannels({
        ...base,
        applyAdaptive: false,
        byStream: { gaules: 45_000 },
        globalMs: 40_000,
      }),
    ).toEqual([]);
  });

  it('teto desligado (0) não avisa', () => {
    expect(
      cappedLatencyChannels({
        ...base,
        capMs: 0,
        globalMs: 40_000,
        byStream: { gaules: 45_000 },
      }),
    ).toEqual([]);
  });
});

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
  it('teto da latência do início: 25s por default (0 desliga)', () => {
    expect(ConfigSchema.parse({}).CLIP_START_LATENCY_MAX_MS).toBe(25_000);
    expect(ConfigSchema.parse({ CLIP_START_LATENCY_MAX_MS: '0' }).CLIP_START_LATENCY_MAX_MS).toBe(0);
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

describe('hashtag dos Shorts', () => {
  it('normaliza: sem aspas, com aspas, sem # e vazio', () => {
    expect(normalizeShortsHashtag('#Shorts')).toBe('#Shorts');
    expect(normalizeShortsHashtag('"#Shorts"')).toBe('#Shorts');
    expect(normalizeShortsHashtag("'#Shorts'")).toBe('#Shorts');
    expect(normalizeShortsHashtag('Shorts')).toBe('#Shorts');
    expect(normalizeShortsHashtag('')).toBe('#Shorts');
    expect(normalizeShortsHashtag(undefined)).toBe('#Shorts');
  });

  it('o schema aplica a normalização (o # solto no .env chega vazio)', () => {
    expect(ConfigSchema.parse({ SHORTS_HASHTAG: '"#Shorts"' }).SHORTS_HASHTAG).toBe('#Shorts');
    expect(ConfigSchema.parse({}).SHORTS_HASHTAG).toBe('#Shorts');
  });
});

describe('regras cruzadas dos Shorts', () => {
  it('MIN > MAX é erro', () => {
    const errors = shortsCrossFieldErrors({ minSec: 45, maxSec: 30, width: 1080, height: 1920 });
    expect(errors.length).toBe(1);
    expect(errors[0].key).toBe('SHORTS_MIN_SEC');
  });

  it('largura >= altura é erro (o Short é vertical)', () => {
    const errors = shortsCrossFieldErrors({ minSec: 30, maxSec: 60, width: 1920, height: 1080 });
    expect(errors.length).toBe(1);
    expect(errors[0].key).toBe('SHORTS_WIDTH');
  });

  it('config consistente não gera erro', () => {
    expect(shortsCrossFieldErrors({ minSec: 30, maxSec: 60, width: 1080, height: 1920 })).toEqual([]);
    expect(shortsCrossFieldErrors({ minSec: 60, maxSec: 60, width: 1080, height: 1920 })).toEqual([]);
  });

  it('validateConfigCrossFields lança na inconsistência', () => {
    const cfg = ConfigSchema.parse({ SHORTS_MIN_SEC: '45', SHORTS_MAX_SEC: '30' });
    expect(() => validateConfigCrossFields(cfg)).toThrow(/SHORTS_MIN_SEC/);
  });

  it('o getConfig NÃO valida as regras cruzadas (o bot live não depende delas)', () => {
    // A config quebrada dos Shorts não pode impedir o bot de subir: quem
    // recusa é o script de Shorts e o painel.
    const cfg = ConfigSchema.parse({ SHORTS_MIN_SEC: '45', SHORTS_MAX_SEC: '30' });
    expect(cfg.SHORTS_MIN_SEC).toBe(45);
    expect(cfg.SHORTS_MAX_SEC).toBe(30);
  });

  it('cam do topo maior que a saída deixa o jogo sem espaço', () => {
    const errors = shortsCrossFieldErrors({
      minSec: 30,
      maxSec: 60,
      width: 1080,
      height: 1920,
      camHeight: 1900,
    });
    expect(errors.map((e) => e.key)).toContain('SHORTS_CAM_HEIGHT');
  });
});

describe('layout dos Shorts (cam no topo)', () => {
  it('default: cam no topo, faixa de 660, zoom no fill e jogo centralizado', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_TOP).toBe('cam');
    expect(cfg.SHORTS_CAM_HEIGHT).toBe(660);
    expect(cfg.SHORTS_CAM_FIT).toBe('cover');
    expect(cfg.SHORTS_CAM_ANCHOR).toBe(0.35);
    expect(cfg.SHORTS_GAME_CROP).toBe(0.95);
    expect(cfg.SHORTS_GAME_Y).toBe(0.5);
    expect(cfg.SHORTS_GAME_FIT).toBe('blur');
    expect(cfg.SHORTS_GAME_ASPECT).toBe(1);
    expect(cfg.SHORTS_CAM_BOX_BY_STREAM.gaules).toBe('0.816:0.310:0.177:0.240');
    expect(cfg.SHORTS_CAM_BOX).toBe('');
  });

  it('default: Short de 60s a 90s', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_MIN_SEC).toBe(60);
    expect(cfg.SHORTS_MAX_SEC).toBe(90);
  });

  it('default: legenda queimada ligada, abaixo da mira, com Gemini na frente', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_CAPTIONS).toBe(true);
    expect(cfg.SHORTS_CAPTION_POSITION).toBe('below-crosshair');
    expect(cfg.SHORTS_CAPTION_FONT_SIZE).toBe(54);
    expect(cfg.SHORTS_CAPTION_FONT_FAMILY).toBe('Barlow Condensed');
    expect(cfg.SHORTS_CAPTION_AI_ORDER).toBe('gemini,huggingface');
    expect(cfg.SHORTS_CAPTION_GEMINI_MODEL).toBe('gemini-3-flash-preview');
    expect(cfg.SHORTS_CAPTION_HF_MODEL).toBe('openai/whisper-large-v3-turbo');
  });

  it('legenda desligada é aceita (sem IA no render)', () => {
    const cfg = ConfigSchema.parse({ SHORTS_CAPTIONS: 'false' });
    expect(cfg.SHORTS_CAPTIONS).toBe(false);
  });

  it('modo de legenda inválido é corrigido pelo boolEnv (não lança)', () => {
    const cfg = ConfigSchema.parse({ SHORTS_CAPTIONS: 'talvez' });
    expect(cfg.SHORTS_CAPTIONS).toBe(true);
  });

  it('mapa de cam por canal: entrada inválida é ignorada', () => {
    const cfg = ConfigSchema.parse({
      SHORTS_CAM_BOX_BY_STREAM: '{"gaules":"0.1:0.2:0.3:0.4","x":"lixo"}',
    });
    expect(cfg.SHORTS_CAM_BOX_BY_STREAM).toEqual({ gaules: '0.1:0.2:0.3:0.4' });
  });

  it('topo inválido é recusado pelo schema', () => {
    expect(ConfigSchema.safeParse({ SHORTS_TOP: 'sticker' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_TOP: 'text' }).success).toBe(true);
  });

  it('preenchimento da cam inválido é recusado', () => {
    expect(ConfigSchema.safeParse({ SHORTS_CAM_FIT: 'sticker' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_CAM_FIT: 'blur' }).success).toBe(true);
  });

  it('preenchimento do jogo inválido é recusado', () => {
    expect(ConfigSchema.safeParse({ SHORTS_GAME_FIT: 'sticker' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_FIT: 'cover' }).success).toBe(true);
  });

  it('proporção do jogo fora da faixa é recusada', () => {
    expect(ConfigSchema.safeParse({ SHORTS_GAME_ASPECT: 0.1 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_ASPECT: 5 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_ASPECT: 1.5 }).success).toBe(true);
  });

  it('âncora e crop do jogo fora da faixa são recusados', () => {
    expect(ConfigSchema.safeParse({ SHORTS_CAM_ANCHOR: 1.5 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_CAM_ANCHOR: -0.1 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_CROP: 0.1 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_CROP: 1.1 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_GAME_Y: 2 }).success).toBe(false);
  });
});
