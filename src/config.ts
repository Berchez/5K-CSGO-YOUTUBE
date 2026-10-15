import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  HLTV_MATCHES_URL: z.string().url().default('https://www.hltv.org/matches'),
  /** Perfil persistente do browser do monitor (guarda clearance do Cloudflare). */
  HLTV_PROFILE: z.string().default('./data/hltv-profile'),
  /** 1 = headless (o Cloudflare costuma barrar; headed minimizado passa). */
  HLTV_HEADLESS: z.string().default('0'),
  MIN_STARS: z.coerce.number().min(0).max(5).default(4),
  TOP_TIER_ONLY: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  POLL_INTERVAL_MS: z.coerce.number().min(5000).default(45000),

  STREAM_PRIORITY: z.string().default('official,en'),
  MAX_RECORDINGS: z.coerce.number().min(1).max(4).default(2),
  BUFFER_DIR: z.string().default('./data/buffer'),
  SEGMENT_TIME_SEC: z.coerce.number().min(5).max(30).default(10),
  // 24 × 10s = 240s: round longo (~140s) + contexto + espera do fim ancorado.
  SEGMENT_WRAP: z.coerce.number().min(6).max(60).default(24),
  CLIP_PRE_ROLL_SEC: z.coerce.number().min(15).max(120).default(60),
  CLIP_POST_ROLL_SEC: z.coerce.number().min(5).max(60).default(15),
  /** Contexto antes do 1º kill do ace (o clipe começa aqui). */
  CLIP_CONTEXT_SEC: z.coerce.number().min(0).max(30).default(10),
  /**
   * Segundos após o fechamento REAL do round onde o clipe termina:
   * fim = (detecção − SCOREBOARD_DELAY_MS) + este valor. Default 8: mira
   * ~5s antes da ação do round seguinte (win panel + freeze ≈ 13s).
   * Em timeout/pausa tática o gap estica e a margem só cresce — nunca
   * sangra para o próximo round (a âncora antiga, detecção + delay + cauda,
   * caía 10-20s dentro do round seguinte por causa do lag do placar).
   */
  CLIP_END_AFTER_CLOSE_SEC: z.coerce.number().min(0).max(60).default(8),
  /** Mínimo de kills no round para gerar clipe (3 = 3k/4k/5k). */
  MIN_KILLS: z.coerce.number().min(2).max(5).default(3),
  /**
   * Atraso estimado do placar live do HLTV em relação ao jogo real. O corte
   * começa em (1º kill observado − este valor − CLIP_CONTEXT_SEC). Suba se
   * o clipe começar DEPOIS da 1ª kill; desça se começar muito antes.
   */
  SCOREBOARD_DELAY_MS: z.coerce.number().min(0).max(120_000).default(10_000),
  /** Upscale do clipe p/ forçar VP9/AV1 no YouTube (1440/2160; 0 = desligado). */
  CLIP_UPSCALE_HEIGHT: z.coerce.number().min(0).max(2160).default(1440),
  /**
   * Auto-sync A/V por conteúdo. 'log' (default): mede o offset real em todo
   * clipe e registra no log/sidecar SEM aplicar correção (diagnóstico).
   * 'auto': mede E aplica a compensação (só com medida válida: |δ|≥0.5s,
   * proeminência ≥1.5 e metades consistentes). 'off': pula a medição.
   * Em gameplay real a correlação luminância↔loudness raramente produz
   * medida válida (prom ~1.0-1.6 em produção) — por isso 'auto' NÃO é o
   * default: um falso positivo aplicaria shift de até ±8s num clipe bom.
   */
  CLIP_AV_SYNC: z.enum(['auto', 'off', 'log']).default('log'),
  CLIPS_DIR: z.string().default('./data/clips'),

  DB_PATH: z.string().default('./data/bot.sqlite'),
  LOG_FILE: z.string().default('./logs/bot.log'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),

  YT_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),
  /** false = gera o clipe e mantém local, sem fazer upload. */
  YT_UPLOAD: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  YT_CLIENT_SECRETS: z.string().default('./client_secrets.json'),
  YT_TOKEN_PATH: z.string().default('./token.json'),
  YT_CATEGORY_ID: z.string().default('20'),
  YT_DEFAULT_TAGS: z.string().default('cs2,ace,5k,counter-strike,highlights'),

  // Thumbnails: composed = frame + selo (grátis, instantâneo, default).
  // ai = tenta fundo IA (pollinations grátis e/ou gemini pago) com fallback p/ composed.
  THUMB_MODE: z.enum(['composed', 'ai']).default('composed'),
  THUMB_AI_ORDER: z.string().default('huggingface'),
  /** Timeout por provider IA da thumb (ms). Web (chatgpt/grok/gemini-web) às vezes leva >5min p/ renderizar. */
  THUMB_AI_TIMEOUT_MS: z.coerce.number().min(60_000).max(3_600_000).default(600_000),
  HF_TOKEN: z.string().default(''),
  HF_IMAGE_MODEL: z.string().default('black-forest-labs/FLUX.1-schnell'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_IMAGE_MODEL: z.string().default('gemini-3.1-flash-lite-image'),
  GEMINI_WEB_PROFILE: z.string().default('./data/gemini-profile'),
  CHATGPT_PROFILE: z.string().default('./data/chatgpt-profile'),
  /** 1 = janela minimizada (corre risco de challenge; 0 = visível, funciona) */
  CHATGPT_MINIMIZED: z.string().default('0'),
  GROK_PROFILE: z.string().default('./data/grok-profile'),
  GROK_MINIMIZED: z.string().default('0'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = ConfigSchema.parse(process.env);
  return cached;
}
