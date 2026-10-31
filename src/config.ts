import './env.js';
import { z } from 'zod';
import { parseLatencyMap } from './monitor/streamLatency.js';
import { parseCropList, parseCropMap } from './clipper/scoreboardSync.js';

/** Valores aceitos como "ligado" nas variáveis de ambiente. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'sim']);
/** Valores aceitos como "desligado" nas variáveis de ambiente. */
const FALSEY = new Set(['0', 'false', 'no', 'off', 'nao', 'não']);

/**
 * Lê um valor booleano de env: null quando o valor NÃO é claramente
 * ligado/desligado ("flase", "sim please"...). O mesmo conjunto vale
 * para o .env, para o painel e para o validador — uma fonte só, senão o
 * bot liga uma feature e o painel mostra "desligado".
 */
export function parseBoolEnv(value: string | undefined): boolean | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (TRUTHY.has(v)) return true;
  if (FALSEY.has(v)) return false;
  return null;
}

/**
 * Boolean de env sem pegadinha: "1"/"true"/"yes"/"on" ligam; "0"/
 * "false"/"no"/"off" desligam; vazio usa o default. (O "só 'true'
 * liga" desligava o recurso com POLL_ADAPTIVE=1.)
 */
export function boolEnv(value: string | undefined, defaultValue: boolean): boolean {
  const parsed = parseBoolEnv(value);
  return parsed === null ? defaultValue : parsed;
}

/**
 * Chaves booleanas do schema (registradas aqui para o aviso de startup
 * sobre valor inválido). Derivado do próprio schema: um booleano novo
 * entra na lista sozinho.
 */
const BOOL_ENV_KEYS_SET = new Set<string>();

/** Campo booleano de env: registra a chave e normaliza o valor. */
function boolEnvField(key: string, defaultValue: boolean) {
  BOOL_ENV_KEYS_SET.add(key);
  return z
    .string()
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => boolEnv(v, defaultValue));
}

export const ConfigSchema = z.object({
  HLTV_MATCHES_URL: z.string().url().default('https://www.hltv.org/matches'),
  /** Perfil persistente do browser do monitor (guarda clearance do Cloudflare). */
  HLTV_PROFILE: z.string().default('./data/hltv-profile'),
  /** Headless (o Cloudflare costuma barrar; headed minimizado passa). Aceita 1/true/0/false. */
  HLTV_HEADLESS: boolEnvField('HLTV_HEADLESS', false),
  MIN_STARS: z.coerce.number().min(0).max(5).default(0),
  TOP_TIER_ONLY: boolEnvField('TOP_TIER_ONLY', false),
  POLL_INTERVAL_MS: z.coerce.number().min(5000).default(45000),
  /**
   * Poll adaptativo (idle backoff): true = ocioso espera metade do tempo
   * que falta para a próxima partida (teto 30min); false = sempre no
   * intervalo base (comportamento antigo, kill switch).
   */
  POLL_ADAPTIVE: boolEnvField('POLL_ADAPTIVE', true),
  /**
   * Fechar o browser (headed) durante a espera ociosa: libera RAM/CPU,
   * mas o relançamento no poll seguinte pode piscar na tela (foco em
   * jogo fullscreen). false = mantém o browser aberto.
   */
  HLTV_CLOSE_BROWSER_IDLE: boolEnvField('HLTV_CLOSE_BROWSER_IDLE', true),
  /**
   * Espera mínima (ms) para fechar o browser ocioso. Espera curta não
   * compensa fechar/relançar (e o relançamento é o que incomoda).
   * 0 = fecha em qualquer espera ociosa.
   */
  HLTV_CLOSE_BROWSER_MIN_IDLE_MS: z.coerce.number().min(0).default(600_000),

  STREAM_PRIORITY: z.string().default('official,en'),
  STREAM_PREFERRED_COUNTRY: z.string().default(''),
  STREAM_PREFERRED_MIN_VIEWERS: z.coerce.number().min(0).max(10_000_000).default(0),
  MAX_RECORDINGS: z.coerce.number().min(1).max(4).default(2),
  BUFFER_DIR: z.string().default('./data/buffer'),
  SEGMENT_TIME_SEC: z.coerce.number().min(5).max(30).default(10),
  // 24 × 10s = 240s: round longo (~140s) + contexto + espera do fim ancorado.
  SEGMENT_WRAP: z.coerce.number().min(6).max(60).default(24),
  /**
   * Seletor de formato do yt-dlp para a fonte COMBINADA (áudio + vídeo no
   * mesmo formato). 'best' = a melhor variante combinada que a fonte
   * expõe (sem teto artificial de resolução/FPS).
   *
   * É o kill-switch da camada de captura: se a fonte publicar uma
   * variante combinada ruim (ou pesada demais para o CPU), dá para
   * escolher outra sem mexer no código (ex.: 'best[height<=1080]').
   * NÃO use seletores de vídeo separado ('bv*'): a captura precisa ser
   * UM input com áudio e vídeo — dois inputs trazem o skew A/V de volta
   * (e o subsistema que o corrigia foi removido).
   */
  CAPTURE_FORMAT: z
    .string()
    .default('best')
    .transform((v) => v.trim() || 'best'),
  CLIP_PRE_ROLL_SEC: z.coerce.number().min(15).max(120).default(60),
  CLIP_POST_ROLL_SEC: z.coerce.number().min(5).max(60).default(15),
  /** Contexto antes do 1º kill do ace (o clipe começa aqui). */
  CLIP_CONTEXT_SEC: z.coerce.number().min(0).max(30).default(10),
  /**
   * Replay-aware: corta o clipe antes da AÇÃO do round seguinte (o fim
   * ancorado entrava no replay/freeze e deixava dezenas de segundos de
   * cauda). 'auto' (default): aplica quando o fim fixo passa da retomada
   * com folga; 'on': aplica com qualquer sobreposição (override);
   * 'shadow': só mede/loga; 'off': pula a detecção.
   */
  REPLAY_AWARE: z.enum(['off', 'shadow', 'auto', 'on']).default('auto'),
  /**
   * Contexto quando a âncora de início é incerta (tracker entrou no meio
   * do round, resetou a base, ou a 1ª kill veio da janela de assentamento):
   * começa mais cedo para não perder a abertura real. Confiança alta usa
   * CLIP_CONTEXT_SEC.
   */
  CLIP_CONTEXT_UNCERTAIN_SEC: z.coerce.number().min(0).max(120).default(25),
  /**
   * Margem extra ANTES da 1ª kill (o clipe começa aqui).
   *
   * O erro de latência é assimétrico: com a latência REAL menor que a
   * configurada, o clipe começa DEPOIS da 1ª kill (ela fica fora do
   * clipe — o pior defeito); com a latência real maior, o clipe só
   * abre mais cedo (material extra do round anterior). A margem paga o
   * erro pelo lado barato: o clipe abre CLIP_CONTEXT_SEC +
   * CLIP_START_MARGIN_SEC antes da 1ª kill.
   * Default 5s.
   */
  CLIP_START_MARGIN_SEC: z.coerce.number().min(0).max(60).default(5),
  /**
   * Upscale (opcional) do clipe live: 0 = desligado (resolução nativa
   * da fonte), 1440/2160 = reescala (denoise + scale + sharpen) na
   * MESMA passada do encode. Serve para forçar VP9/AV1 no YouTube
   * (o YouTube entrega 1080p em AV1/H.264). Custa CPU (1440p60 satura
   * o encode) — por isso é opt-in.
   */
  CLIP_UPSCALE_HEIGHT: z.coerce.number().min(0).max(2160).default(0),
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
  /**
   * Aplica a latência ADAPTATIVA (medida por round) nas âncoras.
   *
   * true (default): com CLIP_STREAM_SYNC=auto, início/fim/timestamps usam
   * a latência observada do canal; false: mantém o valor configurado e só
   * registra a medição (shadow). No modo 'log' a medição é registrada mas
   * nunca aplicada (o modo inteiro é shadow).
   */
  CLIP_STREAM_SYNC_ADAPTIVE: boolEnvField('CLIP_STREAM_SYNC_ADAPTIVE', true),
  /**
   * Delta (ms) acima do qual o round é considerado "regime trocou": a
   * medição do fim do round discorda da amostra anterior. O início NÃO é
   * adiantado por essa medição (só antecipado quando ela é menor — a
   * subida pode ter acontecido depois da 1ª kill); o flag dispara o
   * killfeed, que mede o instante exato dentro do vídeo.
   */
  CLIP_STREAM_SYNC_MAX_STEP_MS: z.coerce.number().min(0).max(120_000).default(20_000),
  /**
   * Arquivo do estado de latência por canal (medições + crop que
   * funcionou). Persistir entre reinícios é o que faz a sincronização
   * "entre partidas" ser fácil: o 1º round da partida nova já começa com
   * a latência medida na partida anterior.
   */
  CLIP_STREAM_SYNC_STATE_PATH: z.string().default('./data/stream-latency.json'),
  /**
   * OCR do KILLFEED (nome do jogador no vídeo) como medição primária.
   *
   * 'off': nunca; 'fallback' (default): sempre que o placar do vídeo
   * não produziu transição confiante (inclui 'after-only'/'gap-inferred'
   * — justamente os rounds em que a âncora do placar é fraca); 'always':
   * sempre. Não roda com CLIP_STREAM_SYNC=off (o sync todo desligado).
   * O killfeed dá o instante EXATO da kill no vídeo (independe da
   * latência), mas é mais frágil: overlay escondido, feed rápido e
   * nomes estilizados quebram o OCR — por isso a âncora final do início
   * é exata só quando a 1ª kill foi lida (com corroboração de outra
   * kill) e o corte cai na latência configurada (abre cedo) quando não.
   */
  CLIP_KILLFEED_SYNC: z.enum(['off', 'fallback', 'always']).default('fallback'),
  /**
   * Congela o buffer circular antes dos OCRs. 'auto' (default): copia os
   * segmentos fechados para um diretório privado enquanto o placar/
   * killfeed são lidos — sem isso o anel pode reescrever a abertura do
   * round durante a varredura ('off' volta ao snapshot do fim).
   */
  CLIP_FREEZE: z.enum(['auto', 'off']).default('auto'),
  /**
   * Cobertura estrita do ace: descarta o evento quando a 1ª kill NÃO
   * está no material — mas só com evidência forte: a posição EXATA da
   * 1ª kill (lida pelo killfeed) fora do buffer, ou uma régua de
   * latência que prove ausência (teto de plausibilidade na checagem
   * inicial; offset medido na checagem final). "O OCR varreu e não leu
   * o nome" NÃO descarta — nomes truncados são comuns e esse descarte
   * destruiu aces bons (2399756). Default true.
   */
  CLIP_COVERAGE_STRICT: boolEnvField('CLIP_COVERAGE_STRICT', true),
  /** Crop normalizado x:y:w:h do placar no topo do vídeo. */
  CLIP_SCOREBOARD_CROP: z.string().default('0.30:0.03:0.40:0.10'),
  /**
   * Crop do placar por CANAL: JSON {"gaules": "0.02:0.02:0.30:0.14"}.
   * Cada canal tem o overlay do placar em outro lugar — um crop que não
   * lê nada deixa o canal sem medição (e sem âncora de fim).
   */
  CLIP_SCOREBOARD_CROP_BY_STREAM: z
    .string()
    .default('')
    .transform((v) => parseCropMap(v)),
  /**
   * Crops alternativos (separados por vírgula) tentados quando o crop
   * principal não produz nenhuma leitura. O crop que funciona é
   * memorizado por canal e vira o principal no round seguinte.
   */
  CLIP_SCOREBOARD_CROP_FALLBACKS: z
    .string()
    .default('0.02:0.02:0.30:0.14,0.60:0.02:0.38:0.14,0.18:0.02:0.64:0.14')
    .transform((v) => parseCropList(v)),
  /**
   * Crop do KILLFEED (nome do jogador no vídeo), usado como segunda
   * medição de sincronização. Default: canto superior direito.
   */
  CLIP_KILLFEED_CROP: z.string().default('0.70:0.05:0.30:0.25'),
  /** Crop do killfeed por CANAL: JSON {"gaules": "0.02:0.05:0.30:0.25"}. */
  CLIP_KILLFEED_CROP_BY_STREAM: z
    .string()
    .default('')
    .transform((v) => parseCropMap(v)),
  /** Crops alternativos do killfeed (quando o principal não casa). */
  CLIP_KILLFEED_CROP_FALLBACKS: z
    .string()
    .default('0.02:0.05:0.30:0.25,0.35:0.05:0.30:0.25,0.55:0.05:0.30:0.25')
    .transform((v) => parseCropList(v)),
  /**
   * TEMPO extra de espera quando a transição do placar não é encontrada
   * (o material precisa chegar). NÃO afeta o corte: o fim do clipe sai
   * de CLIP_END_TAIL_SEC. Default 35s.
   */
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
   * Atraso estimado do placar live do HLTV em relação ao jogo real (o
   * placar reflete o kill alguns segundos DEPOIS dele acontecer). O corte
   * começa em (1º kill observado − este valor − CLIP_CONTEXT_SEC), já
   * convertido para a timeline do vídeo por CLIP_STREAM_LATENCY_MS.
   * Suba se o clipe começar DEPOIS da 1ª kill; desça se começar muito antes.
   */
  SCOREBOARD_DELAY_MS: z.coerce.number().min(0).max(120_000).default(5_000),
  /**
   * Atraso do VÍDEO gravado em relação ao jogo (ms). O recorder consome
   * HLS: o conteúdo de um segmento chega ~20-30s depois de ter acontecido,
   * e o mtime do arquivo marca QUANDO ele foi escrito — não quando foi
   * gravado. Sem esta correção, a âncora (que vem do placar, no relógio
   * do jogo) cai ~25s ANTES do material real e o clipe abre no round
   * anterior, antes da 1ª kill.
   *
   * Calibrado no PGL/Nuke (out/2026), onde mediu ~20s; o default é 25s
   * (folga p/ o lado que perde a última kill). Ajuste com o log de
   * "latência observada" (o bot mede a latência real de cada canal
   * quando o OCR acha a virada do placar no vídeo).
   */
  CLIP_STREAM_LATENCY_MS: z.coerce.number().min(0).max(120_000).default(25_000),
  /**
   * Latência por CANAL (ms), quando a fonte não entrega o material com
   * o mesmo atraso do resto: JSON {"Gaules": 22000, "ESL TV": 30000}.
   * Vazio = todos os canais usam CLIP_STREAM_LATENCY_MS. O nome é o da
   * stream escolhida no log ("gravando buffer muxed").
   */
  CLIP_STREAM_LATENCY_BY_STREAM: z
    .string()
    .default('')
    .transform((v) => parseLatencyMap(v)),
  /**
   * Atraso com que o placar do HLTV publica o PLACAR FINAL do round (ms).
   * A coluna K reflete cada kill em poucos segundos, mas o placar da
   * partida só vira depois do round fechar — bem depois do vídeo já ter
   * mostrado o round ending. É esse atraso que ancora o FIM do clipe.
   * Medido no PGL/Nuke (out/2026): ~20s.
   */
  CLIP_SCORE_DELAY_MS: z.coerce.number().min(0).max(120_000).default(20_000),
  /**
   * Cauda extra no FIM do clipe quando o fim é ESTIMADO (o OCR do vídeo
   * não achou a virada do placar, ou a varredura está desligada).
   *
   * O fim estimado depende da latência configurada: se a stream real
   * atrasar MAIS do que o configurado, o corte fecha antes do round e
   * perde a última kill do ace. O erro é assimétrico — clipe curto é
   * pior que clipe longo — então a estimativa leva esta folga.
   * Default 8s (somando com CLIP_END_AFTER_CLOSE_SEC).
   */
  CLIP_END_TAIL_SEC: z.coerce.number().min(0).max(120).default(8),
  /**
   * Tolerância (s) entre o fim do round visto no OCR do vídeo e o fim
   * ESTIMADO. Acima disto o que o OCR leu é o placar de um round
   * POSTERIOR (o overlay some na tela de fim/replay e só volta no round
   * seguinte) — a âncora é descartada e vale a estimativa.
   * Default 60; 0 desliga o clamp.
   */
  CLIP_END_PLAUSIBILITY_SEC: z.coerce.number().min(0).max(300).default(60),
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
  YT_UPLOAD: boolEnvField('YT_UPLOAD', true),
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
  /** Headless (default). Desligado = o perfil persistente é lido corretamente. */
  GEMINI_WEB_HEADLESS: boolEnvField('GEMINI_WEB_HEADLESS', true),
  CHATGPT_PROFILE: z.string().default('./data/chatgpt-profile'),
  /** Janela minimizada (default; sem popup em jogo fullscreen). Desligado = visível (se o challenge implicar, reverta). */
  CHATGPT_MINIMIZED: boolEnvField('CHATGPT_MINIMIZED', true),
  GROK_PROFILE: z.string().default('./data/grok-profile'),
  /** Idem CHATGPT_MINIMIZED. */
  GROK_MINIMIZED: boolEnvField('GROK_MINIMIZED', true),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = ConfigSchema.parse(process.env);
  return cached;
}

/**
 * Envs removidas (subsistema de A/V e upscale): continuam no .env antigo
 * e são IGNORADAS em silêncio pelo zod — o dono acha que ainda valem.
 * O startup avisa quais estão sobrando.
 */
export const DEPRECATED_ENV_KEYS = [
  'CLIP_AV_SYNC',
  'AV_STATIC_OFFSET_MS',
  'AV_STATIC_MATCHES',
  'AV_STREAM_OFFSETS',
];

/** Envs depreciadas que ainda estão definidas no ambiente. */
export function deprecatedEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return DEPRECATED_ENV_KEYS.filter((key) => {
    const raw = env[key];
    return raw != null && String(raw).trim() !== '';
  });
}

/**
 * Envs booleanas conhecidas (derivadas do schema — sem lista manual). */
export const BOOL_ENV_KEYS: string[] = [...BOOL_ENV_KEYS_SET];

/**
 * Envs de âncora/latência que mudam o CORTE do clipe.
 *
 * O INÍCIO do clipe, a cobertura e os timestamps dependem só da
 * diferença (CLIP_STREAM_LATENCY_MS − SCOREBOARD_DELAY_MS): os dois
 * valores não são identificáveis separadamente (medir um exige saber o
 * outro). Um .env antigo com SCOREBOARD_DELAY_MS=10000 desloca o corte
 * em 5s sem nenhuma pista — por isso o startup avisa quando elas estão
 * no ambiente com valor DIFERENTE do default.
 */
export const LATENCY_ENV_KEYS = [
  'SCOREBOARD_DELAY_MS',
  'CLIP_STREAM_LATENCY_MS',
  'CLIP_SCORE_DELAY_MS',
] as const;

/**
 * Envs de âncora/latência do ambiente com valor diferente do default
 * (o `.env.example` já vem com os defaults — copy colado não deve
 * gerar aviso; um `.env` velho, sim).
 */
export function divergentLatencyEnvs(env: NodeJS.ProcessEnv = process.env): string[] {
  const defaults = ConfigSchema.parse({});
  return LATENCY_ENV_KEYS.filter((key) => {
    const raw = env[key];
    if (raw == null || String(raw).trim() === '') return false;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed)) return false;
    return parsed !== defaults[key];
  });
}

/**
 * Valores booleanos que não são claramente ligados/desligados ("flase",
 * "sim please"...). Caiam no default em silêncio — o startup avisa.
 */
export function invalidBoolEnvs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const key of BOOL_ENV_KEYS) {
    const raw = env[key];
    if (raw == null) continue;
    if (!String(raw).trim()) continue;
    if (parseBoolEnv(raw) !== null) continue;
    out.push(`${key}=${String(raw).trim()}`);
  }
  return out;
}

