import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  HLTV_MATCHES_URL: z.string().url().default('https://www.hltv.org/matches'),
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
  SEGMENT_WRAP: z.coerce.number().min(6).max(60).default(18),
  CLIP_PRE_ROLL_SEC: z.coerce.number().min(15).max(120).default(60),
  CLIP_POST_ROLL_SEC: z.coerce.number().min(5).max(60).default(15),
  /** Contexto antes do 1º kill do ace (o clipe começa aqui). */
  CLIP_CONTEXT_SEC: z.coerce.number().min(0).max(30).default(10),
  CLIPS_DIR: z.string().default('./data/clips'),

  DB_PATH: z.string().default('./data/bot.sqlite'),
  LOG_FILE: z.string().default('./logs/bot.log'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),

  YT_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),
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
