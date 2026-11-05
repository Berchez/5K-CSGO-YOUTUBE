import './env.js';
import { z } from 'zod';
import { parseLatencyMap } from './monitor/streamLatency.js';
import { parseCropList, parseCropMap } from './clipper/scoreboardSync.js';
import { PROVIDER_IDS } from './transcription/registry.js';

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

/**
 * Hashtag de classificação do Shorts.
 *
 * O dotenv trata `#` como início de comentário: `SHORTS_HASHTAG=#Shorts`
 * (sem aspas) chega VAZIO. O painel, que lê o .env na mão, mostra
 * "#Shorts" — as duas pontas discordavam. Aqui o valor é normalizado:
 * aspas tiradas, vazio cai no default e o `#` é garantido.
 */
export function normalizeShortsHashtag(value: string | undefined): string {
  let v = (value ?? '').trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  if (!v) return '#Shorts';
  return v.startsWith('#') ? v : `#${v}`;
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
   * Teto da latência aplicada ao INÍCIO quando o canal NÃO tem medição
   * nenhuma (nem do placar, nem do killfeed).
   *
   * A latência do `.env` vem de uma leitura do placar e erra para MAIS
   * quando o placar atrasa a publicação (2399858/gaules: 45s configurados
   * para ~26s de offset real → o corte abria ~20s DEPOIS da 1ª kill, as
   * primeiras kills ficavam fora). O killfeed é a única medição dentro do
   * vídeo; sem ele, abrir mais cedo (material do round anterior) é o
   * lado barato e nunca perde a abertura.
   *
   * Com QUALQUER medição (placar ou killfeed) o teto não age: silenciar
   * uma medição seria mudar o corte sem motivo. Ele mexe só na
   * ABERTURA — os timestamps e a cobertura seguem a estimativa (para
   * eles não existe lado barato).
   * Default 25s. 0 = desligado.
   */
  CLIP_START_LATENCY_MAX_MS: z.coerce.number().min(0).max(120_000).default(25_000),
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
   * 1ª kill (lida pelo killfeed E corroborada por outra kill — sem
   * corroboração pode ser o killfeed de outro round), ou uma régua de
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
   * Crop do aviso de REPLAY (o banner "REPLAY" do HLTV, no canto
   * superior esquerdo).
   *
   * É o que separa a LINHA AO VIVO do killfeed da LINHA DO REPLAY: o
   * replay reexibe as mesmas kills mais tarde e, lida como âncora,
   * abre o clipe DEPOIS do round (o caso 2399858_Mirage_r15_makazze — o
   * clipe começou no replay e perdeu o 5K ao vivo). Vazio desliga a
   * guarda.
   */
  CLIP_KILLFEED_REPLAY_CROP: z.string().default('0.00:0.00:0.35:0.10'),
  /**
   * Crop do banner de replay por CANAL: JSON {"gaules": "0.00:0.00:0.30:0.08"}.
   * O banner muda de lugar conforme o organizador do HLTV; com o crop
   * errado a guarda de replay nunca age (e ninguém percebe) — por isso
   * o crop inválido é avisado no log.
   */
  CLIP_KILLFEED_REPLAY_CROP_BY_STREAM: z.string().default(''),
  /**
   * Validação da JANELA depois de renderizar o clipe.
   *
   * - `off`: não valida;
   * - `shadow`: valida, LOGA e grava no sidecar, mas nunca descarta
   *   (modo de observação — é o que a repo usa para comportamento de
   *   corte novo: `REPLAY_AWARE=shadow`, `CLIP_STREAM_SYNC=log`);
   * - `on`: valida e descarta o clipe cuja janela está fora das
   *   invariantes (o descarte é DESTRUTIVO: o ace sai do banco).
   *
   * O descarte só acontece com evidência forte (o fim do round
   * MEDIDO com confiança no vídeo e o material ao vivo disponível).
   *
   * `auto` e `always` são ACEITOS como apelidos de `on`: o `auto` de
   * antes se comportava como `always` (o "só quando há evidência" era
   * a própria auditoria) — quem tinha `auto` no .env continua com o
   * mesmo comportamento.
   */
  CLIP_VALIDATE: z
    .enum(['off', 'shadow', 'on', 'auto', 'always'])
    .default('on')
    .transform((value) => (value === 'auto' || value === 'always' ? 'on' : value)),
  /**
   * Dispersão MÁXIMA (s) entre a 1ª e a última kill do ace. Acima
   * disso a lista de kills provavelmente mistura rounds.
   *
   * O `at` do HLTV é o instante do POLL (atrasa 5..16s por kill) e um
   * round lento (post-plant/retake) pode passar de 60s entre a 1ª e a
   * 5ª kill — por isso o limite é folgado e a decisão principal é o
   * GAP entre kills consecutivas (ver CLIP_KILLS_GAP_MAX_SEC).
   */
  CLIP_KILLS_SPREAD_MAX_SEC: z.coerce.number().min(30).max(600).default(120),
  /**
   * GAP máximo (s) entre duas kills CONSECUTIVAS do ace. Acima disso
   * a lista juntou rounds diferentes (o caso 2399858_Ancient_r6: 3s e
   * depois 114s). Dentro de um round o intervalo entre kills é de
   * poucos segundos a ~1min.
   */
  CLIP_KILLS_GAP_MAX_SEC: z.coerce.number().min(10).max(600).default(90),
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
  /** Onde os Shorts verticais (mp4 + marker + report) são gravados. */
  SHORTS_DIR: z.string().default('./data/shorts'),
  /**
   * Shorts verticais (9:16) para o feed Shorts do YouTube.
   *
   * O material é 16:9 (transmissão da HLTV) e o Shorts só aparece no
   * feed VERTICAL — então o 9:16 é produzido no render (crop central +
   * scale), nunca na captura.
   */
  /** Liga a geração dos Shorts (o script `publish:shorts`). */
  SHORTS_ENABLED: boolEnvField('SHORTS_ENABLED', false),
  /**
   * Mínimo de kills para virar Short. O bot grava também 3K/4K (não só
   * ace) e no feed Shorts um 4K é tão bom quanto um ace.
   */
  SHORTS_MIN_KILLS: z.coerce.number().min(2).max(5).default(3),
  /**
   * Duração máxima do Short.
   *
   * O YouTube aceita Shorts de até 3min (180s), mas ACIMA DE 1MIN um
   * Short com claim de copyright ativo é bloqueado globalmente — e a
   * transmissão de torneio é justamente o conteúdo que é claimed. Por
   * isso o corte é 90s.
   */
  SHORTS_MAX_SEC: z.coerce.number().min(10).max(180).default(90),
  /** Duração mínima (abaixo disso o Short é rápido demais e perde retenção). */
  SHORTS_MIN_SEC: z.coerce.number().min(5).max(180).default(60),
  /** Folga antes da 1ª kill (o gancho do Short). */
  SHORTS_HEAD_SEC: z.coerce.number().min(0).max(20).default(4),
  /** Folga depois da última kill. */
  SHORTS_TAIL_SEC: z.coerce.number().min(0).max(30).default(4),
  /** Largura de saída (1080 = Full HD vertical). */
  SHORTS_WIDTH: z.coerce.number().min(360).max(2160).default(1080),
  /** Altura de saída (1920 = 9:16). */
  SHORTS_HEIGHT: z.coerce.number().min(640).max(3840).default(1920),
  /**
   * Posição horizontal do crop (0 = esquerda, 0.5 = centro, 1 = direita).
   * O crop 9:16 de um 16:9 tira ~2/3 da largura: o HUD (placar no topo,
   * killfeed na direita) pode ficar de fora — este é o ajuste para
   * puxar a janela sem mexer no código.
   */
  SHORTS_CROP_X: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Layout do topo do Short:
   * - `cam` (padrão): a cam do STREAMER (caixa por canal) num painel no
   *   topo, jogo embaixo. Canal sem caixa mapeada cai na faixa de texto;
   * - `text`: faixa escura com o título do vídeo (substitui a cam);
   * - `center`: o crop central 9:16 antigo (fallback/comparação).
   */
  SHORTS_TOP: z.enum(['cam', 'text', 'center']).default('cam'),
  /**
   * Altura (px) da faixa do topo. O resto da saída é o jogo.
   * Default 660 (34% de 1920): a cam do streamer ganha altura (com 660
   * ~80% da caixa da webcam do gaules cabe no quadro) e o jogo, com
   * proporção 1:1, continua em 1080x1080 sobre o fundo desfocado.
   */
  SHORTS_CAM_HEIGHT: z.coerce.number().int().min(160).max(1800).default(660),
  /**
   * Como a cam preenche a faixa do topo:
   * - `cover` (padrão): a cam é ZOOMADA até preencher a faixa (corta o
   *   topo/base da caixa, sem distorcer) — sem barras pretas nas laterais;
   * - `blur`: a cam inteira sobre um fundo desfocado da cena.
   */
  SHORTS_CAM_FIT: z.enum(['cover', 'blur']).default('cover'),
  /**
   * Âncora vertical do corte da cam no modo `cover` (0 = topo, 0.5 =
   * centro, 1 = base). A caixa da cam é um retrato e a faixa é 2:1: o
   * corte tem que pegar o rosto, não o meio da cena.
   */
  SHORTS_CAM_ANCHOR: z.coerce.number().min(0).max(1).default(0.35),
  /**
   * Fração da altura da FONTE usada pelo crop do jogo. Default 0.95: o
   * resto é a margem da transmissão (com 0.8 o HUD de vida/munição e a
   * parte de baixo do quadro ficam fora).
   */
  SHORTS_GAME_CROP: z.coerce.number().min(0.3).max(1).default(0.95),
  /**
   * Posição vertical do crop do jogo (0 = topo, 0.5 = centro, 1 = base).
   * Default 0.5 (centralizado: corta um pouco em cima e um pouco embaixo
   * em vez de comer o topo inteiro e deixar o rodapé de fora). Só vale
   * no modo `cover`.
   */
  SHORTS_GAME_Y: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Como o JOGO preenche a faixa de baixo do vertical:
   * - `cover`: o 16:9 é CORTADO no 9:16 da faixa (a ação fica grande,
   *   mas o killfeed, o placar, o rodapé e as laterais saem do quadro —
   *   só ~42% da largura da transmissão aparece);
   * - `blur` (padrão): o crop entra na faixa com a proporção de
   *   `SHORTS_GAME_ASPECT`, centralizado sobre um fundo desfocado da
   *   própria cena (sem distorcer).
   */
  SHORTS_GAME_FIT: z.enum(['cover', 'blur']).default('blur'),
  /**
   * Proporção (largura/altura) do crop do jogo no modo `blur`.
   *
   * Mais largo = mais da transmissão no quadro (e o jogo encolhe):
   * 1 = quadrado (~53% da largura), 4:3 = 1.3333 (~71%), 3:2 = 1.5
   * (~80%), 16:9 = 1.7778 (~95%). 0.7826 é o 9:16 do crop antigo.
   */
  SHORTS_GAME_ASPECT: z.coerce.number().min(0.3).max(2).default(1),
  /**
   * Legenda QUEIMADA no Short (o texto entra no próprio mp4, via libass).
   *
   * `on`: o áudio da janela do Short é transcrito pela IA e a legenda é
   * gravada no vertical (funciona sem depender do caption do YouTube).
   * `off`: o Short sai sem legenda.
   */
  SHORTS_CAPTIONS: boolEnvField('SHORTS_CAPTIONS', true),
  /**
   * Ordem dos providers de transcrição (`gemini,huggingface`).
   * O Gemini transcreve e (se o áudio não for português) traduz na mesma
   * chamada; o Whisper do HuggingFace é a reserva (traz os tempos reais).
   */
  SHORTS_CAPTION_AI_ORDER: z.string().default('gemini,huggingface'),
  /** Modelo do Gemini usado na transcrição. */
  SHORTS_CAPTION_GEMINI_MODEL: z.string().default('gemini-3-flash-preview'),
  /** Modelo do Whisper (HuggingFace) usado na reserva. */
  SHORTS_CAPTION_HF_MODEL: z.string().default('openai/whisper-large-v3-turbo'),
  /**
   * Modelo ggml do whisper.cpp LOCAL (`SHORTS_CAPTION_AI_ORDER` com
   * `whisper-cpp`): `large-v3-turbo-q5_0` é o melhor custo/qualidade
   * desta máquina.
   */
  SHORTS_CAPTION_WHISPER_MODEL: z.string().default('large-v3-turbo-q5_0'),
  /**
   * Modelo DEDICADO de transcrição (Interactions API): é a reserva
   * quando a cota do Gemini de texto acaba — a cota dele é outra.
   */
  SHORTS_CAPTION_DEDICATED_MODEL: z.string().default('gemini-3.5-transcribe'),
  /**
   * O silêncio de um provider é FINAL? (`on` = sim, padrão)
   *
   * `off`: um provider que devolveu "ninguém falou" deixa o próximo
   * ser consultado (um falso-negativo não mata a legenda) — mas o
   * whisper local sem VAD pode inventar fala no silêncio.
   */
  SHORTS_CAPTION_SILENCE_FINAL: boolEnvField('SHORTS_CAPTION_SILENCE_FINAL', true),
  /** Teto de tempo da transcrição (upload do áudio + inferência). */
  SHORTS_CAPTION_TIMEOUT_MS: z.coerce.number().min(10_000).max(600_000).default(180_000),
  /** Tamanho da fonte da legenda (px, na saída de 1080). */
  SHORTS_CAPTION_FONT_SIZE: z.coerce.number().int().min(24).max(160).default(54),
  /**
   * Família da fonte da legenda. O padrão é a fonte VERSÃO NO REPO
   * (assets/fonts/BarlowCondensed-Bold.ttf): o libass a acha pelo
   * `fontsdir` e a legenda sai igual em toda máquina (uma fonte do
   * sistema cairia num fallback diferente em cada host).
   */
  SHORTS_CAPTION_FONT_FAMILY: z.string().default('Barlow Condensed'),
  /**
   * Posição da legenda no vertical:
   * - `below-crosshair` (padrão): um pouco abaixo da mira do player, no
   *   centro da área do jogo;
   * - `game-top`: logo abaixo da faixa da cam, no topo da área do jogo;
   * - `bottom`: no rodapé do vertical (posição clássica de legenda).
   */
  SHORTS_CAPTION_POSITION: z
    .enum(['below-crosshair', 'game-top', 'bottom'])
    .default('below-crosshair'),
  /**
   * Passe REVISOR da legenda: uma segunda chamada ao Gemini corrige só
   * nome de jogador/time/termo de CS (sem reescrever a fala). Custa uma
   * chamada por Short; desligue para economizar cota.
   */
  SHORTS_CAPTION_REFINE: boolEnvField('SHORTS_CAPTION_REFINE', true),
  /**
   * Tradução da legenda para pt-BR quando o streamer fala outra língua
   * (en/es/ru...). O texto original continua no `.orig.txt`.
   */
  SHORTS_CAPTION_TRANSLATE: boolEnvField('SHORTS_CAPTION_TRANSLATE', true),
  /**
   * Provider de transcrição usado pelo adapter (`src/transcription`).
   * Local = sem custo e sem enviar o áudio; nuvem = mais preciso/rápido,
   * mas exige a chave do provider. `PROVIDER_IDS` é a fonte única.
   */
  TRANSCRIPTION_PROVIDER: z.enum(PROVIDER_IDS).default('gemini'),
  /** Modelo do provider (vazio = modelo padrão do provider). */
  TRANSCRIPTION_MODEL: z.string().default(''),
  /** Idioma: `auto` deixa o provider detectar; `pt`, `en`... força. */
  TRANSCRIPTION_LANGUAGE: z.string().default('auto'),
  /** VAD (pula silêncio) nos providers locais que suportam. */
  TRANSCRIPTION_VAD: boolEnvField('TRANSCRIPTION_VAD', true),
  /** Teto de tempo da transcrição (extração do áudio + inferência). */
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().min(10_000).max(1_800_000).default(600_000),
  /** Formato padrão da legenda exportada pelo adapter. */
  TRANSCRIPTION_OUTPUT_FORMAT: z.enum(['srt', 'vtt', 'txt']).default('srt'),
  /** Python do venv local (vazio = .tools/py312 ou PATH). */
  TRANSCRIPTION_PYTHON: z.string().default(''),
  /** Caixa da cam do streamer (x:y:w:h, fração do frame) para QUALQUER canal. */
  SHORTS_CAM_BOX: z.string().default(''),
  /**
   * Caixa da cam POR CANAL (JSON {"gaules":"0.816:0.310:0.177:0.240"}).
   * O overlay de cada streamer fica num canto/forma diferente — sem o
   * mapa o `cam` do Short cortaria o quadro errado. As medidas abaixo
   * foram tiradas dos clipes reais (1080p); ajuste no .env quando o
   * streamer mudar a cena. Canal fora do mapa (ou caixa inválida) cai na
   * faixa de texto.
   *
   * A borda ESQUERDA tem que cair exatamente onde a webcam começa: o
   * `cover` amplia a caixa ~3x, então 10px de cena (parede do mapa) na
   * borda viram uma tarja de ~35px na faixa do Short. No gaules a
   * webcam tem moldura azul de 4px — a caixa começa DEPOIS dela
   * (interior), então nem a moldura nem a cena aparecem na faixa.
   */
  SHORTS_CAM_BOX_BY_STREAM: z
    .string()
    .default(
      '{"gaules":"0.816:0.310:0.177:0.240","forg1":"0.795:0.331:0.187:0.192","dayneez":"0.820:0.324:0.180:0.171","nightkkid":"0.809:0.259:0.170:0.204"}',
    )
    .transform((v) => parseCropMap(v)),
  /** Visibilidade do Short no upload (unlisted = testa sem risco de claim). */
  SHORTS_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('unlisted'),
  /**
   * Hashtag de classificação do Shorts.
   *
   * (A classificação do Shorts no feed é pelo formato VERTICAL do vídeo; a
   * hashtag é a convenção que o canal usa e o que a busca enxerga.)
   */
  SHORTS_HASHTAG: z
    .string()
    .default('#Shorts')
    .transform((v) => normalizeShortsHashtag(v)),
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
  /**
   * Thumb COMPOSTA: a IA gera só o FUNDO e a montagem local (sharp) faz
   * retrato do jogador, logos, mapa e textos (nunca alucinados).
   * O chatgpt ignora: a thumb dele já é completa.
   */
  THUMB_COMPOSITE: boolEnvField('THUMB_COMPOSITE', true),
  HF_TOKEN: z.string().default(''),
  HF_IMAGE_MODEL: z.string().default('black-forest-labs/FLUX.1-schnell'),
  GEMINI_API_KEY: z.string().default(''),
  /** Chaves dos providers de transcrição por API (vazio = requer setup). */
  OPENAI_API_KEY: z.string().default(''),
  GROQ_API_KEY: z.string().default(''),
  DEEPGRAM_API_KEY: z.string().default(''),
  ASSEMBLYAI_API_KEY: z.string().default(''),
  ELEVENLABS_API_KEY: z.string().default(''),
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

/** Erro de validação CRUZADA (depende de dois campos ao mesmo tempo). */
export interface ConfigCrossFieldError {
  key: string;
  message: string;
}

/**
 * Regras que dependem de DOIS campos.
 *
 * O schema é um objeto simples de propósito (o painel usa
 * `ConfigSchema.shape[key]` para editar campo a campo): validação
 * cruzada não cabe em `.refine()` (viraria ZodEffects e quebraria o
 * painel). Ela acontece aqui, depois do parse.
 *
 * Quem CHAMA decide o que fazer com o erro: o script de Shorts aborta
 * (a config é dele), o painel recusa a gravação. O `getConfig()` NÃO
 * chama — a feature dos Shorts é opcional e desligada por padrão, e um
 * `.env` com valor inconsistente não pode impedir o bot de subir.
 */
export function shortsCrossFieldErrors(values: {
  minSec: number;
  maxSec: number;
  width: number;
  height: number;
  camHeight?: number;
}): ConfigCrossFieldError[] {
  const errors: ConfigCrossFieldError[] = [];
  if (values.minSec > values.maxSec) {
    errors.push({
      key: 'SHORTS_MIN_SEC',
      message: `SHORTS_MIN_SEC (${values.minSec}) não pode ser maior que SHORTS_MAX_SEC (${values.maxSec})`,
    });
  }
  if (values.width >= values.height) {
    errors.push({
      key: 'SHORTS_WIDTH',
      message: `SHORTS_WIDTH (${values.width}) tem que ser menor que SHORTS_HEIGHT (${values.height}) — o Short é vertical`,
    });
  }
  const camHeight = values.camHeight ?? 0;
  if (camHeight > 0 && camHeight + 160 > values.height) {
    errors.push({
      key: 'SHORTS_CAM_HEIGHT',
      message: `SHORTS_CAM_HEIGHT (${camHeight}) deixa menos de 160px para o jogo em ${values.height}px de saída`,
    });
  }
  return errors;
}

/** Valida as regras cruzadas e LANÇA na primeira inconsistência. */
export function validateConfigCrossFields(cfg: AppConfig): void {
  const errors = shortsCrossFieldErrors({
    minSec: cfg.SHORTS_MIN_SEC,
    maxSec: cfg.SHORTS_MAX_SEC,
    width: cfg.SHORTS_WIDTH,
    height: cfg.SHORTS_HEIGHT,
    camHeight: cfg.SHORTS_CAM_HEIGHT,
  });
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }
}

/**
 * Canais cuja latência CONFIGURADA ficaria acima do teto de abertura
 * (o corte abriria mais cedo que o configurado enquanto o canal não
 * tiver medição).
 */
export interface CappedLatencyChannel {
  /** Nome do canal ('(global)' = o valor padrão do config). */
  channel: string;
  /** Latência configurada (ms). */
  configuredMs: number;
}

/**
 * Aviso de teto de abertura: quais canais ENTREGAM o valor configurado
 * acima do teto (ms) e, portanto, vão abrir pelo teto enquanto não
 * tiverem medição. Puro/testável.
 *
 * Só avisa o que REALMENTE acontece:
 * - com o adaptativo desligado (modo 'log' ou `CLIP_STREAM_SYNC_ADAPTIVE
 *   =false`) o teto não age — não há o que avisar;
 * - canal COM MEDIÇÃO (placar ou killfeed) não é limitado — o teto é
 *   para o palpite, não para a medição.
 *
 * O valor explícito por canal (`CLIP_STREAM_LATENCY_BY_STREAM`) NÃO é
 * isento: o teto existe para o caso em que esse valor é um palpite
 * inflado (o 2399756 tem 45s configurados para uma latência real menor).
 */
export function cappedLatencyChannels(params: {
  /** Teto da latência de abertura (ms). 0 = desligado. */
  capMs: number;
  /** Latência global configurada (ms). */
  globalMs: number;
  /** Latências por canal (ms). */
  byStream: Record<string, number>;
  /** Canais que já têm MEDIÇÃO (latência completa ou do início). */
  measuredChannels?: Iterable<string>;
  /** O modo adaptativo está sendo aplicado? */
  applyAdaptive: boolean;
}): CappedLatencyChannel[] {
  if (!params.applyAdaptive || params.capMs <= 0) return [];
  const measured = new Set(
    [...(params.measuredChannels ?? [])].map((channel) => channel.trim().toLowerCase()),
  );
  const out: CappedLatencyChannel[] = [];
  const globalChannel = '(global)';
  // O valor global é um fato do CONFIG: ele avisa sempre que estiver
  // acima do teto (vale para todo canal que não tem valor próprio).
  if (params.globalMs > params.capMs) {
    out.push({ channel: globalChannel, configuredMs: params.globalMs });
  }
  for (const [channel, ms] of Object.entries(params.byStream)) {
    if (!Number.isFinite(ms) || ms <= params.capMs) continue;
    // Canal com medição própria: o teto não age nele.
    if (measured.has(channel.trim().toLowerCase())) continue;
    out.push({ channel, configuredMs: ms });
  }
  return out;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  // Sem `validateConfigCrossFields`: a config dos Shorts é opcional e o
  // bot live não pode depender dela (ver shortsCrossFieldErrors).
  const parsed = ConfigSchema.parse(process.env);
  cached = parsed;
  return parsed;
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

