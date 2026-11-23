import { describe, expect, it } from 'vitest';
import {
  boolEnv,
  cappedLatencyChannels,
  CHANNEL_SCOPED_KEYS,
  channelConfigWarnings,
  channelIsolationErrors,
  channelRegistryErrors,
  ConfigSchema,
  deprecatedEnvVars,
  divergentLatencyEnvs,
  getChannelConfig,
  invalidBoolEnvs,
  invalidShortsOverlayEnvs,
  normalizeShortsHashtag,
  parseBoolEnv,
  parseConfigEnv,
  rankCrossFieldErrors,
  resolveChannelEnv,
  shortsCrossFieldErrors,
  unknownChannelEnvVars,
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

describe('config do adesivo do Short (o .env quebrado NÃO derruba o bot)', () => {
  it('hex sem # é normalizado (o SVG sairia inválido sem isso)', () => {
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_BACKGROUND: 'e10600' }).SHORTS_OVERLAY_BACKGROUND).toBe(
      '#e10600',
    );
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_BACKGROUND: '#E10600' }).SHORTS_OVERLAY_BACKGROUND).toBe(
      '#e10600',
    );
    expect(ConfigSchema.parse({}).SHORTS_OVERLAY_BACKGROUND).toBe('');
  });

  it('env inválido do adesivo cai no default e é listado para o aviso', () => {
    const env = {
      SHORTS_OVERLAY_PRESET: 'foo',
      SHORTS_OVERLAY_UPPERCASE: 'talvez',
      SHORTS_OVERLAY_BORDER_PX: '50',
      SHORTS_OVERLAY_BACKGROUND: 'vermelho',
    };
    const invalid = invalidShortsOverlayEnvs(env);
    expect(invalid.length).toBe(4);
    const { config, invalidOverlayEnvs } = parseConfigEnv(env);
    expect(invalidOverlayEnvs.length).toBe(4);
    expect(config.SHORTS_OVERLAY_PRESET).toBe('polex');
    expect(config.SHORTS_OVERLAY_UPPERCASE).toBeNull();
    expect(config.SHORTS_OVERLAY_BORDER_PX).toBeNull();
    expect(config.SHORTS_OVERLAY_BACKGROUND).toBe('');
  });

  it('erro em outro campo continua falhando alto', () => {
    expect(() => parseConfigEnv({ HLTV_MATCHES_URL: 'nao-e-url' })).toThrow();
  });

  it('env quebrado do TEMPO/POSIÇÃO do adesivo também não derruba o bot', () => {
    // Sem estes campos na lista, o bot INTEIRO caía no boot por um
    // `SHORTS_OVERLAY_HOLD_SEC=abc` digitado à mão.
    const env = {
      SHORTS_OVERLAY_HOLD_SEC: 'abc',
      SHORTS_OVERLAY_FADE_SEC: '99',
      SHORTS_OVERLAY_Y: '5',
    };
    const invalid = invalidShortsOverlayEnvs(env);
    expect(invalid.length).toBe(3);
    const { config, invalidOverlayEnvs } = parseConfigEnv(env);
    expect(invalidOverlayEnvs.length).toBe(3);
    expect(config.SHORTS_OVERLAY_HOLD_SEC).toBe(2);
    expect(config.SHORTS_OVERLAY_FADE_SEC).toBe(0.5);
    expect(config.SHORTS_OVERLAY_Y).toBe(0.54);
  });
});

describe('regras cruzadas dos Shorts', () => {
  it('MIN > MAX é erro', () => {
    const errors = shortsCrossFieldErrors({ minSec: 45, maxSec: 30, width: 1080, height: 1920 });
    expect(errors.length).toBe(1);
    expect(errors[0].key).toBe('SHORTS_MIN_SEC');
  });

  it('MAX acima de 180s é erro (o Short do YouTube tem 3 minutos)', () => {
    const errors = shortsCrossFieldErrors({ minSec: 30, maxSec: 600, width: 1080, height: 1920 });
    expect(errors.length).toBe(1);
    expect(errors[0].key).toBe('SHORTS_MAX_SEC');
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
  it('default: cam no topo, faixa de 600, zoom no fill e jogo centralizado', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_TOP).toBe('cam');
    expect(cfg.SHORTS_CAM_HEIGHT).toBe(600);
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

  it('default: legenda queimada ligada, abaixo da mira, com o whisper local na frente', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_CAPTIONS).toBe(true);
    expect(cfg.SHORTS_CAPTION_POSITION).toBe('below-crosshair');
    expect(cfg.SHORTS_CAPTION_FONT_SIZE).toBe(64);
    expect(cfg.SHORTS_CAPTION_FONT_FAMILY).toBe('Barlow Condensed');
    // O whisper local abre a lista: o tempo da legenda é REAL (o modelo
    // de linguagem inventa o tempo).
    expect(cfg.SHORTS_CAPTION_AI_ORDER).toBe('whisper-cpp,gemini,huggingface');
    expect(cfg.SHORTS_CAPTION_TIMING).toBe('whisper-cpp');
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

describe('adesivo do Short (preset + overrides)', () => {
  it('default: preset polex, texto automático e overrides vazios', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.SHORTS_OVERLAY_TEXT).toBe('auto');
    expect(cfg.SHORTS_OVERLAY_PRESET).toBe('polex');
    expect(cfg.SHORTS_OVERLAY_STYLE).toBe('');
    expect(cfg.SHORTS_OVERLAY_TAG).toBe('');
    expect(cfg.SHORTS_OVERLAY_UPPERCASE).toBeNull();
    expect(cfg.SHORTS_OVERLAY_BACKGROUND).toBe('');
    expect(cfg.SHORTS_OVERLAY_COLOR).toBe('');
    expect(cfg.SHORTS_OVERLAY_BORDER_COLOR).toBe('');
    expect(cfg.SHORTS_OVERLAY_BORDER_PX).toBeNull();
    expect(cfg.SHORTS_OVERLAY_SHADOW_COLOR).toBe('');
    expect(cfg.SHORTS_OVERLAY_SHADOW_PX).toBeNull();
    expect(cfg.SHORTS_OVERLAY_SHADOW_BLUR_PX).toBeNull();
    expect(cfg.SHORTS_OVERLAY_TILT_DEG).toBeNull();
    expect(cfg.SHORTS_OVERLAY_FONT).toBe('');
  });

  it('preset inválido é recusado pelo schema', () => {
    expect(ConfigSchema.safeParse({ SHORTS_OVERLAY_PRESET: 'sticker' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_OVERLAY_PRESET: 'madhouse' }).success).toBe(true);
  });

  it('texto vazio desliga o adesivo; texto longo é inválido sem derrubar o bot', () => {
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_TEXT: '' }).SHORTS_OVERLAY_TEXT).toBe('');
    expect(ConfigSchema.safeParse({ SHORTS_OVERLAY_TEXT: 'x'.repeat(121) }).success).toBe(false);
    expect(
      invalidShortsOverlayEnvs({ SHORTS_OVERLAY_TEXT: 'x'.repeat(121) }),
    ).toContain(`SHORTS_OVERLAY_TEXT=${'x'.repeat(121)}`);
  });

  it('override numérico: vazio = preset e 0 é override válido', () => {
    const empty = ConfigSchema.parse({ SHORTS_OVERLAY_BORDER_PX: '' });
    expect(empty.SHORTS_OVERLAY_BORDER_PX).toBeNull();
    const zero = ConfigSchema.parse({ SHORTS_OVERLAY_BORDER_PX: '0' });
    expect(zero.SHORTS_OVERLAY_BORDER_PX).toBe(0);
  });

  it('cor hex inválida é recusada', () => {
    expect(ConfigSchema.safeParse({ SHORTS_OVERLAY_BACKGROUND: 'vermelho' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ SHORTS_OVERLAY_BACKGROUND: '#e10600' }).success).toBe(true);
  });

  it('caixa alta é tri-estado (vazio = preset)', () => {
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_UPPERCASE: '' }).SHORTS_OVERLAY_UPPERCASE).toBeNull();
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_UPPERCASE: 'on' }).SHORTS_OVERLAY_UPPERCASE).toBe(true);
    expect(ConfigSchema.parse({ SHORTS_OVERLAY_UPPERCASE: 'off' }).SHORTS_OVERLAY_UPPERCASE).toBe(false);
  });
});

describe('cota: fuso do dia', () => {
  it('fuso inválido é recusado pelo schema (não estoura no meio do lote)', () => {
    expect(ConfigSchema.safeParse({ YT_QUOTA_TIMEZONE: 'Mars/Phobos' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ YT_QUOTA_TIMEZONE: 'America/Los_Angeles' }).success).toBe(
      true,
    );
    expect(ConfigSchema.parse({}).YT_QUOTA_TIMEZONE).toBe('America/Los_Angeles');
  });
});

describe('config multi-canal', () => {
  // BR (sem prefixo) + EN (prefixado). O EN tem as chaves ISOLADAS
  // (token/pastas/watchlist/overlay) — sem elas o canal herdaria o BR.
  const env = {
    CHANNELS: 'br,en',
    MIN_STARS: '2',
    MIN_KILLS: '4',
    CLIPS_DIR: './data/clips',
    BUFFER_DIR: './data/buffer',
    SHORTS_DIR: './data/shorts',
    WATCHLIST_FILE: './data/watchlist.json',
    SHORTS_OVERLAY_CONFIG: './config/shorts-overlays.json',
    YT_CLIENT_SECRETS: './client_secrets.json',
    YT_TOKEN_PATH: './token.json',
    DB_PATH: './data/bot.sqlite',
    EN_MIN_STARS: '3',
    EN_MIN_KILLS: '4',
    EN_CLIPS_DIR: './data/clips-en',
    EN_BUFFER_DIR: './data/buffer-en',
    EN_SHORTS_DIR: './data/shorts-en',
    EN_WATCHLIST_FILE: './data/watchlist-en.json',
    EN_SHORTS_OVERLAY_CONFIG: './config/shorts-overlays-en.json',
    EN_YT_CLIENT_SECRETS: './client_secrets-en.json',
    EN_YT_TOKEN_PATH: './token-en.json',
    EN_DB_PATH: './data/outro.sqlite',
    EN_STREAM_GAULES_FALLBACK: 'false',
    EN_STREAM_EN_COUNTRIES: 'US,GB',
    EN_CHANNEL_LANGUAGE: 'en',
  };

  it('default é um canal só (BR), sem mudar o .env atual', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.CHANNELS).toEqual(['br']);
    expect(cfg.CHANNEL_LANGUAGE).toBe('pt-BR');
    // CHANNELS vazio no .env também cai no default (não quebra o boot)
    expect(ConfigSchema.parse({ CHANNELS: '' }).CHANNELS).toEqual(['br']);
    expect(ConfigSchema.parse({ CHANNELS: '   ' }).CHANNELS).toEqual(['br']);
  });

  it('aceita a lista de canais e normaliza para minúsculo', () => {
    const cfg = ConfigSchema.parse({ CHANNELS: 'BR, en ,EN' });
    expect(cfg.CHANNELS).toEqual(['br', 'en', 'en']);
  });

  it('EN_KEY vence KEY e chave de processo não é sobrescrita', () => {
    const resolved = resolveChannelEnv('en', env);
    expect(resolved.MIN_STARS).toBe('3');
    expect(resolved.CLIPS_DIR).toBe('./data/clips-en');
    expect(resolved.DB_PATH).toBe('./data/bot.sqlite');
    expect(resolved.EN_DB_PATH).toBe('./data/outro.sqlite');
  });

  it('o canal default ignora o prefixo (BR_* não cria outra config)', () => {
    const resolved = resolveChannelEnv('br', { ...env, BR_MIN_STARS: '5' });
    expect(resolved.MIN_STARS).toBe('2');
    // `getChannelConfig('br')` e `getConfig()` são a MESMA config.
    expect(getChannelConfig('br', env).MIN_STARS).toBe(2);
  });

  it('canal sem prefixo herda o global (não inventa default)', () => {
    const en = getChannelConfig('en', {
      ...env,
      EN_MIN_STARS: undefined,
      MIN_STARS: '2',
    });
    expect(en.MIN_STARS).toBe(2);
    expect(en.CLIPS_DIR).toBe('./data/clips-en');
  });

  it('string vazia NÃO é override (EN_MIN_STARS= não vira 0)', () => {
    const resolved = resolveChannelEnv('en', { ...env, EN_MIN_STARS: '' });
    expect(resolved.MIN_STARS).toBe('2');
  });

  it('string vazia limpa no texto (marca/CTA/nome)', () => {
    const resolved = resolveChannelEnv('en', {
      ...env,
      EN_YT_BRAND: '',
      EN_YT_DESC_CTA: '',
      EN_CHANNEL_NAME: '',
    });
    expect(resolved.YT_BRAND).toBe('');
    expect(resolved.YT_DESC_CTA).toBe('');
    expect(resolved.CHANNEL_NAME).toBe('');
  });

  it('canal novo não herda publicação/Shorts (fail-closed)', () => {
    const resolved = resolveChannelEnv('en', {
      CHANNELS: 'br,en',
      YT_UPLOAD: 'true',
      SHORTS_ENABLED: 'true',
    });
    expect(resolved.YT_UPLOAD).toBe('false');
    expect(resolved.SHORTS_ENABLED).toBe('false');
  });

  it('kill-switch com valor INVÁLIDO no EN fica DESLIGADO (não o default)', () => {
    // `EN_YT_UPLOAD=flase` não pode virar "ligado" (o default do schema).
    const resolved = resolveChannelEnv('en', {
      CHANNELS: 'br,en',
      YT_UPLOAD: 'true',
      EN_YT_UPLOAD: 'flase',
    });
    expect(resolved.YT_UPLOAD).toBe('false');
    // O canal default não muda: valor inválido cai no default (com aviso).
    const br = resolveChannelEnv('br', { YT_UPLOAD: 'flase' });
    expect(br.YT_UPLOAD).toBe('flase');
  });

  it('canal fora de CHANNELS é erro (não herança silenciosa do BR)', () => {
    expect(() => getChannelConfig('en', { CHANNELS: 'br' })).toThrow(/não está em CHANNELS/);
  });

  it('config efetiva do EN resolve paths, stream e idioma', () => {
    const en = getChannelConfig('en', env);
    expect(en.MIN_STARS).toBe(3);
    expect(en.MIN_KILLS).toBe(4);
    expect(en.CLIPS_DIR).toBe('./data/clips-en');
    expect(en.STREAM_GAULES_FALLBACK).toBe(false);
    expect(en.STREAM_EN_COUNTRIES).toBe('US,GB');
    expect(en.CHANNEL_LANGUAGE).toBe('en');
    // Chave de processo: o EN continua no MESMO banco do BR.
    expect(en.DB_PATH).toBe('./data/bot.sqlite');
  });

  it('chaves de processo ficam fora de CHANNEL_SCOPED_KEYS', () => {
    for (const key of [
      'DB_PATH',
      'HLTV_PROFILE',
      'LOG_FILE',
      'CLIP_STREAM_SYNC_STATE_PATH',
      'MAX_TOTAL_RECORDINGS',
      'CHANNELS',
    ]) {
      expect(CHANNEL_SCOPED_KEYS).not.toContain(key);
    }
  });

  it('registro inválido é listado (vazio, duplicado, default fora da lista)', () => {
    expect(channelRegistryErrors({ CHANNELS: ['br', 'en'] })).toEqual([]);
    expect(channelRegistryErrors({ CHANNELS: [] })).not.toEqual([]);
    expect(channelRegistryErrors({ CHANNELS: ['br', 'br'] })).toHaveLength(1);
    // O canal default (br) é obrigatório: dados legados e runtime BR.
    expect(channelRegistryErrors({ CHANNELS: ['en'] })).toHaveLength(1);
  });

  it('isolamento: chave obrigatória faltando é erro do canal não-default', () => {
    const errors = channelIsolationErrors('en', { CHANNELS: 'br,en' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/EN_YT_TOKEN_PATH é obrigatória/);
    // O canal default não tem erro nenhum.
    expect(channelIsolationErrors('br', { CHANNELS: 'br,en' })).toEqual([]);
  });

  it('isolamento: mesmo caminho do BR é erro (token/pasta compartilhados)', () => {
    const errors = channelIsolationErrors('en', {
      ...env,
      EN_YT_TOKEN_PATH: './token.json',
    });
    expect(errors.join(' ')).toMatch(/EN_YT_TOKEN_PATH/);
    // Mesmo arquivo escrito de outro jeito ('token.json' x './token.json').
    const same = channelIsolationErrors('en', { ...env, EN_YT_TOKEN_PATH: 'token.json' });
    expect(same.join(' ')).toMatch(/EN_YT_TOKEN_PATH/);
  });

  it('isolamento: config completa e separada não gera erro', () => {
    expect(channelIsolationErrors('en', env)).toEqual([]);
  });

  it('aviso por canal: bool inválida no EN é vista (não vira default)', () => {
    const warnings = channelConfigWarnings('en', { ...env, EN_YT_UPLOAD: 'flase' });
    expect(warnings.join(' ')).toMatch(/YT_UPLOAD=flase/);
    // O global continua sendo avisado à parte (canal default).
    expect(channelConfigWarnings('br', { ...env, YT_UPLOAD: 'flase' }).join(' ')).not.toMatch(
      /YT_UPLOAD/,
    );
  });

  it('env EN_* fora do escopo é avisada (EN_DB_PATH não faz nada)', () => {
    const ignored = unknownChannelEnvVars('en', env);
    expect(ignored.join(' ')).toMatch(/EN_DB_PATH \(chave global/);
    // Chave que nem existe no schema também é avisada.
    expect(unknownChannelEnvVars('en', { ...env, EN_ENABLED: 'true' }).join(' ')).toMatch(
      /EN_ENABLED \(chave desconhecida\)/,
    );
  });
});

describe('config da regra de rank', () => {
  it('RANK_MIN_KILLS precisa ser inteiro', () => {
    expect(ConfigSchema.safeParse({ RANK_MIN_KILLS: '4' }).success).toBe(true);
    expect(ConfigSchema.safeParse({ RANK_MIN_KILLS: '4.5' }).success).toBe(false);
  });

  it('Y só precisa ser menor que X quando as duas regras estão ligadas', () => {
    expect(rankCrossFieldErrors({ sumMax: 0, strongMax: 0 })).toEqual([]);
    expect(rankCrossFieldErrors({ sumMax: 0, strongMax: 30 })).toEqual([]);
    expect(rankCrossFieldErrors({ sumMax: 70, strongMax: 0 })).toEqual([]);
    expect(rankCrossFieldErrors({ sumMax: 70, strongMax: 30 })).toEqual([]);
    expect(rankCrossFieldErrors({ sumMax: 70, strongMax: 70 })).toHaveLength(1);
    expect(rankCrossFieldErrors({ sumMax: 70, strongMax: 80 })).toHaveLength(1);
  });
});
