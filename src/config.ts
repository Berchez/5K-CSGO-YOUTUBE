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
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = ConfigSchema.parse(process.env);
  return cached;
}
