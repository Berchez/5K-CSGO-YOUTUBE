import './env.js';
import { z } from 'zod';

export const ConfigSchema = z.object({
  HLTV_MATCHES_URL: z.string().url().default('https://www.hltv.org/matches'),
  /** Perfil persistente do browser do monitor (guarda clearance do Cloudflare). */
  HLTV_PROFILE: z.string().default('./data/hltv-profile'),
  /** 1 = headless (o Cloudflare costuma barrar; headed minimizado passa). */
  HLTV_HEADLESS: z.string().default('0'),
  MIN_STARS: z.coerce.number().min(0).max(5).default(0),
  TOP_TIER_ONLY: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  POLL_INTERVAL_MS: z.coerce.number().min(5000).default(45000),
  /**
   * Poll adaptativo (idle backoff): true = ocioso espera metade do tempo
   * que falta para a próxima partida (teto 30min); false = sempre no
   * intervalo base (comportamento antigo, kill switch).
   */
  POLL_ADAPTIVE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  STREAM_PRIORITY: z.string().default('official,en'),
  STREAM_PREFERRED_COUNTRY: z.string().default(''),
  STREAM_PREFERRED_MIN_VIEWERS: z.coerce.number().min(0).max(10_000_000).default(0),
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
   * Replay-aware (Fase 1: shadow). 'shadow' (default): detecta a retomada
   * de ação do round seguinte e LOGA o fim alternativo (incluindo o replay)
   * sem aplicar; 'off': pula a detecção; 'on': reservado à Fase 2
   * (por enquanto comporta-se como shadow).
   */
  REPLAY_AWARE: z.enum(['off', 'shadow', 'on']).default('shadow'),
  /**
   * Contexto quando a âncora de início é incerta (tracker entrou no meio
   * do round, resetou a base, ou a 1ª kill veio da janela de assentamento):
   * começa mais cedo para não perder a abertura real. Confiança alta usa
   * CLIP_CONTEXT_SEC.
   */
  CLIP_CONTEXT_UNCERTAIN_SEC: z.coerce.number().min(0).max(120).default(25),
  /**
   * Segundos após a virada do placar do round onde o clipe termina.
   * Default 8: cobre o win panel/freeze sem entrar muito no próximo round.
   */
  CLIP_END_AFTER_CLOSE_SEC: z.coerce.number().min(0).max(60).default(8),
  /**
   * Ancora o fim do clipe na virada do placar do round no vídeo.
   * 'auto' aplica quando encontra a transição; 'log' mede sem alterar os
   * cortes; 'off' desliga a varredura.
   */
  CLIP_STREAM_SYNC: z.enum(['auto', 'log', 'off']).default('auto'),
  /** Maior espera pela transição do placar no buffer. */
  CLIP_STREAM_SYNC_MAX_LAG_SEC: z.coerce.number().min(0).max(180).default(120),
  /** Crop normalizado x:y:w:h do placar no topo do vídeo. */
  CLIP_SCOREBOARD_CROP: z.string().default('0.30:0.03:0.40:0.10'),
  /** Cauda extra quando a transição do placar não é encontrada. */
  CLIP_STREAM_SYNC_FALLBACK_SEC: z.coerce.number().min(0).max(120).default(35),
  /** Mínimo de kills no round em partidas com >= 1 estrela (4 = 4k/5k). */
  MIN_KILLS: z.coerce.number().min(2).max(5).default(4),
  /**
   * Mínimo de kills em partidas SEM estrela (0 no listing): 5 = só ace.
   * A política é 4k+ só em jogos com pelo menos 1 estrela; jogo sem estrela
   * ainda é monitorado, mas rende clipe apenas com 5k.
   */
  MIN_KILLS_NO_STARS: z.coerce.number().min(2).max(5).default(5),
  /**
   * Atraso estimado do placar live do HLTV em relação ao jogo real. O corte
   * começa em (1º kill observado − este valor − CLIP_CONTEXT_SEC). Suba se
   * o clipe começar DEPOIS da 1ª kill; desça se começar muito antes.
   */
  SCOREBOARD_DELAY_MS: z.coerce.number().min(0).max(120_000).default(10_000),
  /** Upscale do clipe p/ forçar VP9/AV1 no YouTube (1440/2160; 0 = desligado). */
  CLIP_UPSCALE_HEIGHT: z.coerce.number().min(0).max(2160).default(1440),
  /**
   * Auto-sync A/V por conteúdo. 'auto' (default) mede e aplica apenas
   * quando o offset passa os gates de confiança e as duas metades concordam.
   * 'log' mede sem aplicar; 'off' pula a medição.
   */
  CLIP_AV_SYNC: z.enum(['auto', 'off', 'log']).default('auto'),
  /**
   * Correção A/V ESTÁTICA (ms de atraso aplicado ao áudio, 0 = desligado).
   * Calibração manual para quando a medição automática não decide (gameplay
   * denso: correlação sem pico dominante) mas o skew é sistemático e conhecido
   * (ex: áudio ~2s adiantado em toda uma stream). Tem PRECEDÊNCIA sobre o
   * 'auto'. Workflow: gere variantes com adelay, escolha ouvindo, sete aqui
   * durante o evento, volte a 0 depois. NÃO é global seguro: o offset varia
   * por stream (uma partida com 0 e outra com 2000 na mesma semana é normal).
   */
  AV_STATIC_OFFSET_MS: z.coerce.number().min(0).max(8000).default(0),
  /**
   * Escopo do offset estático: matchIds separados por vírgula (ex:
   * "2399233,2399204"). Vazio = aplica em TODAS as partidas (global —
   * perigoso: o offset varia por stream; o bot avisa no startup).
   * Fluxo: confirme o skew numa variante, escopete o match, reverta a 0
   * no fim do evento.
   */
  AV_STATIC_MATCHES: z.string().default(''),
  /**
   * Offset por STREAM (canal), ex: "ESL TV=2000,Gaules=0". O nome é o da
   * stream escolhida no log ("gravando buffer") — estável por pipeline de
   * transmissão. Calibre UMA vez por canal (variante + ouvido) e todos os
   * clipes dele saem corrigidos sem revisão por clipe. Canais diferentes
   * têm offsets diferentes (um global quebraria os clipes bons).
   */
  AV_STREAM_OFFSETS: z.string().default(''),
  CLIPS_DIR: z.string().default('./data/clips'),
  /**
   * Espaço livre mínimo em disco (GB) para operar: abaixo disto o render
   * do clipe é ABORTADO com erro claro (em vez de entregar mp4 sem moov)
   * e o recorder avisa a cada ciclo. Sem espaço, os segmentos novos também
   * param de acumular — libere espaço, não reinicie às cegas.
   */
  DISK_MIN_FREE_GB: z.coerce.number().min(1).max(100).default(3),

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
  /**
   * Metadados do YouTube: 'ai' = IA (com fallback determinístico), 'template'
   * = gerador determinístico (offline, instantâneo), 'legacy' = título e
   * descrição fixos de antes (kill switch).
   */
  YT_META_MODE: z.enum(['ai', 'template', 'legacy']).default('ai'),
  /** Ordem dos providers de TEXTO (ia): o 1º preferred, os seguintes são fallback. */
  YT_META_AI_ORDER: z.string().default('gemini,huggingface'),
  /** Timeout por provider de texto (ms). */
  YT_META_AI_TIMEOUT_MS: z.coerce.number().min(5_000).max(600_000).default(45_000),
  YT_META_GEMINI_MODEL: z.string().default('gemini-3-flash-preview'),
  YT_META_HF_MODEL: z.string().default('Qwen/Qwen2.5-7B-Instruct'),
  /** Assinatura do canal: vira hashtag no fim da descrição (vazio = sem assinatura). */
  YT_BRAND: z.string().default(''),
  /** Linha extra (CTA) no fim da descrição. */
  YT_DESC_CTA: z.string().default(''),

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
  /** Perfil do Chrome dentro do user-data-dir (ex.: "Profile 2"). Vazio = default do Chromium. */
  GEMINI_WEB_CHROME_PROFILE: z.string().default(''),
  /** 1 = headless (default). Use 0 para o perfil persistente ser lido corretamente. */
  GEMINI_WEB_HEADLESS: z
    .string()
    .default('1')
    .transform((v) => (v === '0' || v.toLowerCase() === 'false' ? '0' : '1')),
  CHATGPT_PROFILE: z.string().default('./data/chatgpt-profile'),
  /** 1 = janela minimizada (default; sem popup em jogo fullscreen). 0 = visível (se challenge implicar, reverta). */
  CHATGPT_MINIMIZED: z.string().default('1'),
  GROK_PROFILE: z.string().default('./data/grok-profile'),
  /** Idem CHATGPT_MINIMIZED. */
  GROK_MINIMIZED: z.string().default('1'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = ConfigSchema.parse(process.env);
  return cached;
}

/**
 * Parse de AV_STREAM_OFFSETS ("ESL TV=2000,Gaules=0") → Map canal→ms.
 * Entradas inválidas são ignoradas. Puro/testável.
 */
export function parseStreamOffsets(csv: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of csv.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const vStr = part.slice(eq + 1).trim();
    // Valor vazio explícito ("Canal=") é rejeitado: Number('') === 0 seria
    // um typo silencioso virando calibragem zero.
    if (!name || !vStr) continue;
    const ms = Number(vStr);
    if (!Number.isFinite(ms) || ms < 0 || ms > 8000) continue;
    out.set(name, Math.round(ms));
  }
  return out;
}

export type StaticOffsetRule = 'off' | 'global' | 'match' | 'stream';

/**
 * Offset estático efetivo p/ o clipe + qual regra decidiu. Puro/testável.
 * Precedência: escopo por partida > por stream > global legado.
 * Escopo protege os clipes bons: offset global aplica em tudo — inclusive
 * onde não há skew. Sem regra aplicável, 0 (sem correção).
 */
export function resolveStaticOffset(
  offsetMs: number,
  matchesCsv: string,
  matchId: string,
  streamOffsets?: Map<string, number>,
  streamName?: string,
): { ms: number; rule: StaticOffsetRule } {
  const scoped = matchesCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scoped.length > 0) {
    return scoped.includes(matchId)
      ? { ms: offsetMs, rule: 'match' }
      : { ms: 0, rule: 'off' };
  }
  if (streamOffsets && streamName && streamOffsets.has(streamName)) {
    return { ms: streamOffsets.get(streamName) ?? 0, rule: 'stream' };
  }
  if (Number.isFinite(offsetMs) && offsetMs > 0) {
    return { ms: offsetMs, rule: 'global' };
  }
  return { ms: 0, rule: 'off' };
}
