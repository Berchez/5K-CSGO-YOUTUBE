import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../logger.js';
import { repoPath } from '../paths.js';
import { resolveFfmpegBin, resolveFfprobeBin } from './segmentProbe.js';
import { isValidCrop } from './scoreboardSync.js';
import { renderShortBannerPng, type ShortBannerText } from './shortBanner.js';
import { escapeAssFilterPath, safeAssName } from './shortCaptions.js';

const execFileAsync = promisify(execFile);

/**
 * Shorts verticais (9:16) de ACE.
 *
 * O material do bot é 16:9 (transmissão da HLTV). O Shorts do YouTube
 * só aparece no feed vertical — então o vertical precisa ser PRODUZIDO no
 * render, não na captura (o capture é `-c copy` e continua 16:9).
 *
 * Duas peças:
 * 1. `planShortWindow` — a janela de 60-90s que cobre a jogada (a 1ª
 *    kill até a última). O clipe do bot tem 60-190s (pre-roll + ação +
 *    cauda) e o YouTube aceita Shorts de até 3min.
 * 2. `renderShortClip` — o vertical numa passada de ffmpeg. Três
 *    layouts (`buildShortLayout`):
 *    - `cam`: a cam do STREAMER (caixa medida por canal) num painel no
 *      topo + o jogo embaixo (mais largo que 9:16);
 *    - `text`: mesma faixa do topo, mas com o título do vídeo (canal sem
 *      cam mapeada — melhor que exibir a caixa errada do quadro);
 *    - `center`: o crop central 9:16 antigo (fallback/comparação).
 */

/**
 * Duração máxima do Short.
 *
 * O YouTube aceita até 3min, mas acima de 1min um Short com claim de
 * copyright ativo é bloqueado globalmente (a transmissão de torneio é
 * justamente o tipo de conteúdo que é claimed). 90s é o corte.
 */
export const SHORT_DEFAULT_MAX_SEC = 90;
/** Duração mínima (abaixo disso o Short é rápido demais e perde retenção). */
export const SHORT_DEFAULT_MIN_SEC = 60;
/** Folga ANTES da 1ª kill (o gancho do Short: a ação começa logo). */
export const SHORT_DEFAULT_HEAD_SEC = 4;
/** Folga DEPOIS da última kill (a reação/rolagem final). */
export const SHORT_DEFAULT_TAIL_SEC = 4;

export interface ShortWindowOptions {
  maxSec?: number;
  minSec?: number;
  headSec?: number;
  tailSec?: number;
}

export interface ShortWindow {
  /** Início da janela dentro do clipe 16:9 (s). */
  startSec: number;
  /** Duração da janela (s). */
  durSec: number;
  /** Fim da janela (s) — `startSec + durSec`. */
  endSec: number;
  /** Posições (s, dentro do clipe) das kills que caem na janela. */
  includedKills: number[];
  /** Posições das kills que ficaram DE FORA (a jogada é longa demais). */
  droppedKills: number[];
  /** Verdadeiro quando alguma kill ficou de fora. */
  truncated: boolean;
  /** Verdadeiro quando a janela foi esticada para a duração mínima. */
  padded: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Escolhe a janela quando a jogada NÃO cabe em `maxSec`.
 *
 * Candidatas: abrir em cada kill (`kill − headSec`). Para cada uma há
 * duas formas:
 * - COM o clímax: a janela vai até a última kill + cauda (sem rabo morto
 *   depois do ace);
 * - SEM o clímax: a janela enche até `maxSec` (corta o clímax, mas pode
 *   pegar mais kills do começo).
 *
 * Prioridade:
 * 1. janela que inclui a ÚLTIMA kill (o Short tem que terminar no ace —
 *   um Short que corta antes da última kill acaba sem payoff);
 * 2. mais kills dentro da janela;
 * 3. em empate, a janela mais cedo (mantém o gancho).
 */
function chooseTruncatedWindow(
  kills: number[],
  duration: number,
  maxSec: number,
  headSec: number,
  tailSec: number,
): { start: number; end: number } {
  const last = kills[kills.length - 1];
  const candidates: Array<{ start: number; end: number; count: number; hasClimax: boolean }> = [];
  for (const kill of kills) {
    const start = Math.max(0, kill - headSec);
    // (A) com o clímax: termina na última kill + cauda.
    const endWithClimax = Math.min(duration, last + tailSec);
    if (endWithClimax - start <= maxSec + 0.001) {
      candidates.push({ start, end: endWithClimax, count: 0, hasClimax: true });
    }
    // (B) sem o clímax: enche até o teto.
    candidates.push({ start, end: Math.min(duration, start + maxSec), count: 0, hasClimax: false });
  }
  let best: { start: number; end: number; count: number; hasClimax: boolean } | null = null;
  for (const candidate of candidates) {
    const included = kills.filter(
      (p) => p >= candidate.start - 0.01 && p <= candidate.end + 0.01,
    );
    const hasClimax = included.some((p) => Math.abs(p - last) < 0.01);
    const count = included.length;
    const improved =
      !best ||
      (hasClimax && !best.hasClimax) ||
      (hasClimax === best.hasClimax &&
        (count > best.count || (count === best.count && candidate.start < best.start)));
    if (improved) best = { ...candidate, count, hasClimax };
  }
  return best ? { start: best.start, end: best.end } : { start: 0, end: Math.min(duration, maxSec) };
}

/**
 * Janela do Short: da 1ª kill até a última, dentro de 60-90s.
 *
 * Regras:
 * - A 1ª kill é o GANCHO: a janela abre `headSec` antes dela.
 * - A última kill define o fim (+ `tailSec`).
 * - Se a jogada for mais longa que `maxSec`, a janela é escolhida por
 *   `chooseTruncatedWindow` (mais kills dentro; em empate, o clímax).
 * - Se sobrar tempo, a janela é esticada para `minSec` (primeiro para
 *   frente, depois para trás) — um Short de 8s não dá retenção.
 */
export function planShortWindow(
  killPositionsSec: number[],
  clipDurationSec: number,
  opts: ShortWindowOptions = {},
): ShortWindow {
  const maxSec = Math.max(1, opts.maxSec ?? SHORT_DEFAULT_MAX_SEC);
  const minSec = Math.max(0, opts.minSec ?? SHORT_DEFAULT_MIN_SEC);
  const headSec = Math.max(0, opts.headSec ?? SHORT_DEFAULT_HEAD_SEC);
  const tailSec = Math.max(0, opts.tailSec ?? SHORT_DEFAULT_TAIL_SEC);
  const duration = Math.max(0, Number.isFinite(clipDurationSec) ? clipDurationSec : 0);

  const kills = killPositionsSec.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);

  if (kills.length === 0 || duration <= 0) {
    const dur = round2(Math.min(duration, maxSec));
    return {
      startSec: 0,
      durSec: dur,
      endSec: dur,
      includedKills: [],
      droppedKills: kills,
      truncated: kills.length > 0,
      padded: false,
    };
  }

  const first = kills[0];
  const last = kills[kills.length - 1];

  let start = Math.max(0, first - headSec);
  let end = Math.min(duration, last + tailSec);
  let truncated = false;

  if (end - start > maxSec) {
    const chosen = chooseTruncatedWindow(kills, duration, maxSec, headSec, tailSec);
    start = chosen.start;
    end = chosen.end;
    truncated = true;
  }

  let padded = false;
  const span = end - start;
  if (span < minSec) {
    padded = true;
    const missing = minSec - span;
    // Estica PARA FRENTE primeiro (depois da última kill): o Short
    // mostra a ação já no segundo 0 (o gancho) e a cauda é o payoff
    // (win panel, reação). Esticar para trás empurraria a 1ª kill para
    // o meio do Short e queimaria a retenção.
    const forward = Math.min(missing, Math.max(0, duration - end));
    end += forward;
    const back = Math.min(missing - forward, start);
    start -= back;
    end = Math.min(duration, end + (missing - forward - back));
  }

  start = clamp(round2(start), 0, Math.max(0, duration - 0.01));
  end = clamp(round2(end), start, duration);
  const durSec = round2(end - start);

  const includedKills: number[] = [];
  const droppedKills: number[] = [];
  for (const p of kills) {
    if (p >= start - 0.01 && p <= end + 0.01) includedKills.push(round2(p));
    else droppedKills.push(round2(p));
  }

  return {
    startSec: start,
    durSec,
    endSec: end,
    includedKills,
    droppedKills,
    truncated: truncated || droppedKills.length > 0,
    padded,
  };
}

export interface ShortKillRef {
  /**
   * Instante da kill no rel�gio do PLACAR (epoch ms). Os sidecars do bot
   * gravam n�mero; os gerados pelo script de VOD gravam ISO - os dois
   * sao aceitos.
   */
  at?: number | string | null;
  /**
   * A posição da kill foi ESTIMADA (não medida no vídeo) — o mesmo
   * sentido de `KillEvent.estimated`: a descrição não pode afirmar um
   * horário que ninguém mediu, e o Short não pode montar a janela em
   * cima de uma posição estimada.
   */
  estimated?: boolean;
}


export interface ShortClipInfo {
  /** Epoch ms do início do clipe na timeline do vídeo (sidecar). */
  clipStartMs?: number | null;
  /** Duração do clipe 16:9 (s). */
  clipDurationSec?: number | null;
  /** Latência − atraso do placar (ms): converte o relógio do placar no do vídeo. */
  killVideoOffsetMs?: number | null;
}

/** Converte o `at` do sidecar (número ou ISO) em epoch ms. */
export function killAtMs(at: number | string | null | undefined): number | null {
  if (at == null) return null;
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  const raw = at.trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Posições das kills DENTRO do clipe (s, a partir do início do clipe).
 *
 * Mesma conta dos timestamps da descrição (`buildMetadataContext`): o `at`
 * da kill é o instante no PLACAR; no vídeo ela aparece `killVideoOffsetMs`
 * depois. Kill fora do clipe (antes do início ou depois do fim) é
 * descartada — o Short não pode prometer um timestamp mentiroso.
 *
 * O offset é OBRIGATÓRIO: sem ele a posição fica ~20s deslocada (a
 * latência da stream menos o atraso do placar) e a janela escolhida
 * aponta para o pedaço errado do vídeo. Melhor devolver nada (e o
 * chamador pular o clipe) do que cortar a jogada errada.
 */
export function killPositionsByKill(
  kills: ShortKillRef[],
  info: ShortClipInfo,
): Array<{ index: number; sec: number }> {
  const { clipStartMs, clipDurationSec, killVideoOffsetMs } = info;
  if (clipStartMs == null || !Number.isFinite(clipStartMs)) return [];
  if (killVideoOffsetMs == null || !Number.isFinite(killVideoOffsetMs)) return [];
  const offset = Number(killVideoOffsetMs);
  const duration = Number.isFinite(clipDurationSec) ? Number(clipDurationSec) : null;
  const out: Array<{ index: number; sec: number }> = [];
  kills.forEach((kill, index) => {
    // Posição ESTIMADA (não medida): a janela do Short sairia deslocada
    // e o título prometeria kills que o vídeo não mostra no horário
    // dito. A kill continua na lista, mas sem posição.
    if (kill.estimated === true) return;
    const at = killAtMs(kill.at);
    if (at == null) return;
    const sec = (at + offset - clipStartMs) / 1000;
    if (!Number.isFinite(sec) || sec < 0) return;
    if (duration != null && sec > duration + 1) return;
    out.push({ index, sec });
  });
  return out.sort((a, b) => a.sec - b.sec);
}

/** Só as posições (s), ordenadas — atalho do `killPositionsByKill`. */
export function killPositionsSec(
  kills: ShortKillRef[],
  info: ShortClipInfo,
): number[] {
  return killPositionsByKill(kills, info).map((k) => k.sec);
}

/**
 * O vertical já gravado cobre a janela calculada?
 *
 * Sem o marker não há como saber qual trecho o mp4 cobre: re-renderiza.
 * Com o marker, a janela antiga precisa bater com a nova (tolerância de
 * 50ms) — senão o vídeo é de outro pedaço do clipe e ia ao ar com o
 * título da janela nova.
 */
export function isStaleWindow(
  previous: { startSec?: number; durSec?: number } | null | undefined,
  plan: ShortWindow,
  verticalExists: boolean,
): boolean {
  if (!verticalExists) return false;
  if (!previous) return true;
  const start = Number(previous.startSec);
  const dur = Number(previous.durSec);
  if (!Number.isFinite(start) || !Number.isFinite(dur)) return true;
  return Math.abs(start - plan.startSec) > 0.05 || Math.abs(dur - plan.durSec) > 0.05;
}

/** Layout do topo do Short. */
export type ShortTopMode = 'cam' | 'text' | 'center';

/**
 * Como a cam preenche a largura (sem barras pretas):
 * - `cover`: a cam é ZOOMADA até preencher a faixa (corta o topo/base da
 *   caixa, nunca distorce);
 * - `blur`: a cam inteira sobre um fundo desfocado da cena (as sobras
 *   laterais ficam com o desfoque).
 */
export type ShortCamFit = 'cover' | 'blur';

/**
 * Como o JOGO preenche a faixa de baixo:
 * - `cover`: o 16:9 é CORTADO num 9:16 esticado (a ação em tamanho
 *   grande, mas o killfeed/placar/rodapé e as laterais saem do quadro);
 * - `blur`: o 16:9 INTEIRO entra na faixa (1080x607) sobre um fundo
 *   desfocado — nada é cortado (placar, killfeed e rodapé no quadro),
 *   mas a ação ocupa menos altura.
 */
export type ShortGameFit = 'cover' | 'blur';


/** Caixa da cam do streamer, em fração do frame (0-1). */
export interface ShortCamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Lê a caixa da cam no formato `x:y:w:h` (mesmo formato dos crops por
 * canal do placar/killfeed). Inválida ou ausente = null.
 */
export function parseShortCamBox(value: string | null | undefined): ShortCamBox | null {
  const raw = (value ?? '').trim();
  if (!raw || !isValidCrop(raw)) return null;
  const [x, y, w, h] = raw.split(':').map(Number);
  return { x, y, w, h };
}

/** Texto `x:y:w:h` da caixa (assinatura do render, comparação estável). */
export function camBoxToString(box: ShortCamBox | null | undefined): string | null {
  if (!box) return null;
  return `${box.x}:${box.y}:${box.w}:${box.h}`;
}

export interface ShortRenderOptions {
  /** Início da janela no clipe (s). */
  startSec: number;
  /** Duração da janela (s). */
  durSec: number;
  /** Largura de saída (default 1080). */
  width?: number;
  /** Altura de saída (default 1920). */
  height?: number;
  /**
   * Posição horizontal do crop do JOGO (0 = esquerda, 0.5 = centro,
   * 1 = direita).
   */
  cropX?: number;
  /** CRF do x264 (default 18). */
  crf?: number;
  /** Preset do x264 (default veryfast — o render não pode saturar a CPU). */
  preset?: string;
  /** Layout do topo (default: 'cam' quando há caixa, senão 'center'). */
  top?: ShortTopMode;
  /** Caixa da cam do streamer (fração do frame). */
  camBox?: ShortCamBox | null;
  /** Altura da faixa do topo (px, default 540 = 28% de 1920). */
  camHeight?: number;
  /** Como a cam preenche a faixa (default 'cover'). */
  camFit?: ShortCamFit;
  /**
   * Âncora vertical do corte da cam no modo `cover` (0 = topo, 0.5 =
   * centro, 1 = base). A caixa da cam tem forma de retrato e a faixa é
   * 2:1 — o corte tem que ficar no rosto, não no meio da cena.
   */
  camAnchor?: number;
  /**
   * Fração da altura da FONTE usada pelo crop do jogo. Default 0.95 (o
   * resto é a margem de segurança do quadro da transmissão). Só vale no
   * modo `cover` (no `blur` o quadro inteiro entra).
   */
  gameCrop?: number;
  /**
   * Posição vertical do crop do jogo (0 = topo, 0.5 = centro, 1 = base).
   * Default 0.5 (centralizado: corta um pouco em cima e um pouco embaixo
   * em vez de comer o topo inteiro e deixar o rodapé de fora).
   */
  gameY?: number;
  /**
   * Como o jogo preenche a faixa de baixo: `cover` (crop 9:16 apertado,
   * ação grande) ou `blur` (crop com a proporção pedida, centralizado
   * sobre fundo desfocado).
   */
  gameFit?: ShortGameFit;
  /**
   * Proporção (largura/altura) do crop do jogo no modo `blur`.
   * Default 4:3 (1.3333): mostra ~71% da largura da transmissão.
   */
  gameAspect?: number;
  /** Texto da faixa quando `top='text'`. */
  banner?: ShortBannerText | null;
  /** PNG da faixa já rasterizado (evita regerar). */
  bannerPng?: string | null;
  /**
   * Arquivo `.ass` da legenda queimada (opcional). Com ele, o libass
   * grava a legenda no próprio mp4 (sem depender do caption do YouTube).
   */
  captionsAssPath?: string | null;
}

export interface ShortLayoutOptions {
  width: number;
  height: number;
  top: ShortTopMode;
  camBox?: ShortCamBox | null;
  camHeight?: number;
  camFit?: ShortCamFit;
  camAnchor?: number;
  gameCrop?: number;
  gameY?: number;
  gameFit?: ShortGameFit;
  gameAspect?: number;
  cropX?: number;
  /**
   * Dimensoes reais da fonte (default 1920x1080). O render sempre passa
   * a medida do ffprobe — o default é só para chamadas sem probe.
   */
  srcWidth?: number;
  srcHeight?: number;
  /**
   * Arquivo `.ass` da legenda queimada (opcional). O libass do ffmpeg
   * queima a faixa no vertical depois do `vstack` — assim a legenda é
   * posicionada no espaço 9:16, e não no do clipe 16:9.
   */
  captionsAssPath?: string | null;
}

export interface ShortLayout {
  /** Cadeia de filtros, terminando no rótulo `[v]`. */
  filter: string;
  width: number;
  height: number;
  /** Altura da faixa do topo (px). Igual à saída no layout `center`. */
  topHeight: number;
  /** Altura da faixa do jogo (px). */
  gameHeight: number;
  /** Layout efetivo (o pedido pode cair no `center` sem caixa). */
  top: ShortTopMode;
  camBox: ShortCamBox | null;
  /** Como a cam preenche a faixa (só no layout `cam`). */
  camFit: ShortCamFit;
  /** Como o jogo preenche a faixa de baixo. */
  gameFit: ShortGameFit;
  /** Proporção do crop do jogo no modo `blur` (largura/altura). */
  gameAspect: number;
}

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded - (rounded % 2);
}

/**
 * Filtro de vídeo do Short: crop 9:16 pela ALTURA (a largura é o que
 * sobra) + scale para a saída + SAR quadrado.
 *
 * `crop=ih*9/16` recorta pela altura (o 16:9 tem largura de sobra) — o
 * centro do frame é onde a mira e a ação ficam no CS2.
 */
export interface ShortFilterOptions {
  width?: number;
  height?: number;
  cropX?: number;
}

export function shortVideoFilter(opts: ShortFilterOptions = {}): string {
  const width = Math.max(2, Math.round(opts.width ?? 1080));
  const height = Math.max(2, Math.round(opts.height ?? 1920));
  const cropX = clamp(opts.cropX ?? 0.5, 0, 1);
  return [
    `crop=ih*9/16:ih:(iw-ih*9/16)*${cropX}:0`,
    `scale=${width}:${height}:flags=lanczos`,
    'setsar=1',
  ].join(',');
}

/**
 * Monta o filtro do vertical (puro).
 *
 * `cam`: cam no topo + jogo embaixo (`vstack`). A cam preenche a faixa
 * SEM barras pretas: no modo `cover` ela é zoomada até estourar a faixa
 * (e cortada na vertical, ancorada no rosto); no modo `blur` ela entra
 * inteira sobre um fundo desfocado da cena.
 * `text`: faixa de texto (input 1) + jogo embaixo.
 * `center`: crop central 9:16 antigo (uma passada, sem vstack).
 *
 * As dimensões da fonte entram como números (probe do ffprobe) em vez de
 * expressões `iw/ih`: a cadeia fica legível e testável.
 */
export function buildShortLayout(opts: ShortLayoutOptions): ShortLayout {
  const width = Math.max(2, even(opts.width));
  const height = Math.max(2, even(opts.height));
  const cropX = clamp(opts.cropX ?? 0.5, 0, 1);
  const wanted = opts.top;
  const camBox = wanted === 'cam' ? (opts.camBox ?? null) : null;
  /**
   * Legenda queimada: o `ass` entra DEPOIS do empilhamento, para as
   * coordenadas da legenda serem as do vertical (1080x1920).
   *
   * O filtro usa só o NOME do arquivo: o ffmpeg roda com o cwd na pasta
   * do `.ass` (ver `renderShortClip`), então o caminho absoluto — que no
   * Windows traz `C:` e pode ter apóstrofo — nunca entra no filtergraph
   * (o `C:` quebra o filtro e o apóstrofo fecha a aspa).
   */
  const captionsFilter = opts.captionsAssPath
    ? `ass=filename=${escapeAssFilterPath(safeAssName(opts.captionsAssPath))}` +
      `:fontsdir=${escapeAssFilterPath(repoPath('assets', 'fonts'))}`
    : '';
  if (wanted === 'center' || (wanted === 'cam' && !camBox)) {
    const chain = `[0:v]${shortVideoFilter({ width, height, cropX })}`;
    return {
      filter: captionsFilter
        ? `${chain}[base];[base]${captionsFilter},format=yuv420p[v]`
        : `${chain}[v]`,
      width,
      height,
      topHeight: height,
      gameHeight: height,
      top: 'center',
      camBox: null,
      camFit: 'cover',
      gameFit: 'cover',
      gameAspect: clamp(opts.gameAspect ?? 4 / 3, 0.3, 2),
    };
  }

  const topHeight = Math.max(2, even(clamp(opts.camHeight ?? Math.round(height * 0.28), 2, height - 2)));
  const gameHeight = height - topHeight;
  const srcWidth = Number.isFinite(opts.srcWidth) && (opts.srcWidth ?? 0) >= 2 ? Math.round(opts.srcWidth as number) : 1920;
  const srcHeight = Number.isFinite(opts.srcHeight) && (opts.srcHeight ?? 0) >= 2 ? Math.round(opts.srcHeight as number) : 1080;
  // O jogo é centralizado: o crop come um pouco em cima e um pouco embaixo
  // (o placar no topo e o HUD de vida/munição embaixo entram no quadro).
  const gameCrop = clamp(opts.gameCrop ?? 0.95, 0.2, 1);
  const gameYPos = clamp(opts.gameY ?? 0.5, 0, 1);
  const gameCropHeight = Math.max(2, even(Math.min(srcHeight, Math.round(srcHeight * gameCrop))));
  const gameCropWidth = clamp(
    Math.round(gameCropHeight * (width / gameHeight)),
    2,
    srcWidth,
  );
  const gameX = Math.max(0, Math.round((srcWidth - gameCropWidth) * cropX));
  const gameY = clamp(
    Math.round((srcHeight - gameCropHeight) * gameYPos),
    0,
    Math.max(0, srcHeight - gameCropHeight),
  );
  const gameFit: ShortGameFit = opts.gameFit === 'blur' ? 'blur' : 'cover';
  // Proporção (largura/altura) do CROP do jogo no modo `blur`. O crop
  // pega essa fatia da fonte (altura = `gameCrop`), encaixa na faixa
  // mantendo a proporção e fica CENTRALIZADO sobre o fundo desfocado.
  // Mais largo = mais conteúdo da transmissão no quadro (e o jogo
  // encolhe): 1 = quadrado, 4:3 = 1.3333, 3:2 = 1.5, 16:9 = 1.7778.
  const gameAspect = clamp(opts.gameAspect ?? 4 / 3, 0.3, 2);
  // No modo `cover` o crop tem o aspecto da FAIXA (o jogo preenche tudo);
  // no modo `blur` o crop tem a proporção pedida.
  const blurCropWidth = clamp(Math.round(gameCropHeight * gameAspect), 2, srcWidth);
  const blurCropX = Math.max(0, Math.round((srcWidth - blurCropWidth) * cropX));
  // `cover`: o 16:9 é cortado no aspecto da faixa (ação grande, mas o
  // killfeed/placar/rodapé e as laterais ficam de fora).
  // `blur`: o crop com a proporção pedida é encaixado e centralizado sobre
  // um fundo desfocado da própria cena — nada é distorcido.
  const gameChain = (source: string): string =>
    gameFit === 'blur'
      ? `[${source}]split=2[gamesplit0][gamesplit1];` +
        `[gamesplit0]scale=${width}:${gameHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
        `crop=${width}:${gameHeight},boxblur=20:2,setsar=1[gamebg];` +
        `[gamesplit1]crop=${blurCropWidth}:${gameCropHeight}:${blurCropX}:${gameY},` +
        `scale=${width}:${gameHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[gamefg];` +
        `[gamebg][gamefg]overlay=(W-w)/2:(H-h)/2[game]`
      : `[${source}]crop=${gameCropWidth}:${gameCropHeight}:${gameX}:${gameY},` +
        `scale=${width}:${gameHeight}:flags=lanczos,setsar=1[game]`;

  if (opts.top === 'text') {
    return {
      filter:
        `[1:v]scale=${width}:${topHeight}:flags=lanczos,setsar=1[top];${gameChain('0:v')};` +
        `[top][game]vstack=inputs=2${captionsFilter ? `,${captionsFilter}` : ''},format=yuv420p[v]`,
      width,
      height,
      topHeight,
      gameHeight,
      top: 'text',
      camBox: null,
      camFit: 'cover',
      gameFit,
      gameAspect,
    };
  }

  const box = camBox as ShortCamBox;
  const camCropW = clamp(Math.round(srcWidth * box.w), 2, srcWidth);
  const camCropH = clamp(Math.round(srcHeight * box.h), 2, srcHeight);
  const camCropX = clamp(Math.round(srcWidth * box.x), 0, srcWidth - camCropW);
  const camCropY = clamp(Math.round(srcHeight * box.y), 0, srcHeight - camCropH);
  const fit: ShortCamFit = opts.camFit === 'blur' ? 'blur' : 'cover';
  const anchor = clamp(opts.camAnchor ?? 0.35, 0, 1);
  const camCrop = `crop=${camCropW}:${camCropH}:${camCropX}:${camCropY}`;
  const head =
    fit === 'cover'
      ? [
          `[0:v]split=2[camsrc][gamesrc]`,
          // Zoom até estourar a faixa e corte vertical ancorado no rosto:
          // sem barra preta nas laterais e sem distorcer o aspecto.
          `[camsrc]${camCrop},scale=${width}:${topHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
            `crop=${width}:${topHeight}:(iw-ow)/2:(ih-oh)*${anchor},setsar=1[top]`,
        ]
      : [
          `[0:v]split=3[bgsrc][camsrc][gamesrc]`,
          // Fundo: a cena inteira desfocada preenchendo a faixa (a caixa da
          // cam é 4:3~16:9 e a faixa é 2:1: sem isso sobrariam barras pretas).
          `[bgsrc]scale=${width}:${topHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
            `crop=${width}:${topHeight},boxblur=20:2,setsar=1[topbg]`,
          // Cam: encaixa inteira (contain) — nada de cortar a cabeça.
          `[camsrc]${camCrop},scale=${width}:${topHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[topfg]`,
          // Overlay CENTRALIZADO: com `pad` preto o desenho da cam
          // cobria o fundo desfocado e voltavam as barras pretas.
          `[topbg][topfg]overlay=(W-w)/2:(H-h)/2[top]`,
        ];
  return {
    filter: [
      ...head,
      gameChain('gamesrc'),
      `[top][game]vstack=inputs=2${captionsFilter ? `,${captionsFilter}` : ''},format=yuv420p[v]`,
    ].join(';'),
    width,
    height,
    topHeight,
    gameHeight,
    top: 'cam',
    camBox: box,
    camFit: fit,
    gameFit,
    gameAspect,
  };
}

/** Assinatura do render gravada no marker (layout + geometria). */
export interface ShortRenderSignature {
  top: ShortTopMode;
  camBox: string | null;
  camHeight: number;
  camFit: ShortCamFit;
  camAnchor: number;
  gameCrop: number;
  gameY: number;
  gameFit: ShortGameFit;
  gameAspect: number;
  width: number;
  height: number;
  bannerText: string | null;
  cropX?: number;
  /** Legenda queimada pedida (`on`) ou não (`off`). */
  captions: ShortCaptionMode;
  /** Tamanho da fonte da legenda (px). */
  captionFontSize: number;
  /** Posição da legenda no vertical. */
  captionPosition: ShortCaptionPosition;
  /** Família da fonte da legenda. */
  captionFontFamily: string;
}

export type ShortCaptionMode = 'off' | 'on';
export type ShortCaptionPosition = 'below-crosshair' | 'game-top' | 'bottom';

export function shortRenderSignature(opts: {
  top: ShortTopMode;
  camBox?: ShortCamBox | null;
  camHeight?: number;
  camFit?: ShortCamFit;
  camAnchor?: number;
  gameCrop?: number;
  gameY?: number;
  gameFit?: ShortGameFit;
  gameAspect?: number;
  width?: number;
  height?: number;
  bannerText?: string | null;
  cropX?: number;
  captions?: ShortCaptionMode;
  captionFontSize?: number;
  captionPosition?: ShortCaptionPosition;
  captionFontFamily?: string;
}): ShortRenderSignature {
  return {
    top: opts.top,
    camBox: camBoxToString(opts.camBox),
    camHeight: Math.round(opts.camHeight ?? 540),
    camFit: opts.camFit === 'blur' ? 'blur' : 'cover',
    camAnchor: Number((opts.camAnchor ?? 0.35).toFixed(4)),
    gameCrop: Number((opts.gameCrop ?? 0.95).toFixed(4)),
    gameY: Number((opts.gameY ?? 0.5).toFixed(4)),
    gameFit: opts.gameFit === 'blur' ? 'blur' : 'cover',
    gameAspect: Number((opts.gameAspect ?? 4 / 3).toFixed(4)),
    width: Math.round(opts.width ?? 1080),
    height: Math.round(opts.height ?? 1920),
    bannerText: opts.bannerText ?? null,
    cropX: Number((opts.cropX ?? 0.5).toFixed(4)),
    captions: opts.captions === 'on' ? 'on' : 'off',
    captionFontSize: Math.round(opts.captionFontSize ?? 54),
    captionPosition:
      opts.captionPosition === 'bottom'
        ? 'bottom'
        : opts.captionPosition === 'below-crosshair'
          ? 'below-crosshair'
          : 'game-top',
    captionFontFamily: String(opts.captionFontFamily ?? 'Segoe UI Black').trim() || 'Segoe UI Black',
  };
}

/**
 * O vertical em disco foi gerado com OUTRO layout/geometria?
 *
 * Sem a assinatura (marker antigo) não há como saber: re-renderiza. Um
 * Short publicado tem `youtubeId` e nem chega aqui (o script pula).
 */
export function isStaleRender(
  previous: ShortRenderSignature | null | undefined,
  current: ShortRenderSignature,
): boolean {
  if (!previous) return true;
  return (
    previous.top !== current.top ||
    (previous.camBox ?? null) !== (current.camBox ?? null) ||
    previous.camHeight !== current.camHeight ||
    // Estrito de propósito: um marker de uma versão anterior do layout
    // não tem estes campos (undefined) e precisa cair no re-render.
    previous.camFit !== current.camFit ||
    previous.camAnchor !== current.camAnchor ||
    previous.gameCrop !== current.gameCrop ||
    previous.gameY !== current.gameY ||
    previous.gameFit !== current.gameFit ||
    previous.gameAspect !== current.gameAspect ||
    previous.width !== current.width ||
    previous.height !== current.height ||
    (previous.bannerText ?? null) !== (current.bannerText ?? null) ||
    (previous.cropX ?? 0.5) !== (current.cropX ?? 0.5) ||
    // Legenda queimada: um marker antigo não tem estes campos e precisa
    // cair no re-render (o mp4 foi gravado sem legenda).
    previous.captions !== current.captions ||
    previous.captionFontSize !== current.captionFontSize ||
    previous.captionPosition !== current.captionPosition ||
    previous.captionFontFamily !== current.captionFontFamily
  );
}

async function probeDurationSec(file: string): Promise<number | null> {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return null;
  try {
    const out = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 15_000, windowsHide: true },
    ).then((r) => String(r.stdout ?? '').trim());
    const d = Number.parseFloat(out);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Dimensões e taxa da fonte (o filtro precisa de números, não `iw/ih`). */
async function probeVideoInfo(
  file: string,
): Promise<{ width: number; height: number; fps: number } | null> {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return null;
  try {
    const out = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate',
        '-of',
        'csv=p=0',
        file,
      ],
      { timeout: 15_000, windowsHide: true },
    ).then((r) => String(r.stdout ?? '').trim());
    const [rawW, rawH, rawRate] = out.split(',');
    const width = Number.parseInt(rawW ?? '', 10);
    const height = Number.parseInt(rawH ?? '', 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
      return null;
    }
    const [num, den] = String(rawRate ?? '').split('/').map(Number);
    const fps =
      Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0
        ? Math.round(num / den)
        : 60;
    return { width, height, fps: Math.max(1, fps) };
  } catch {
    return null;
  }
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return true;
  try {
    const out = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { timeout: 15_000, windowsHide: true },
    ).then((r) => String(r.stdout ?? '').trim());
    return out.includes('audio');
  } catch {
    return true;
  }
}

/** Teto do render: um vertical de 90s não passa de minutos. */
const FFMPEG_TIMEOUT_MS = 900_000;

/** execFile com log do erro (o render do Short é um passo do script). */
async function runFfmpeg(args: string[], cwd?: string): Promise<void> {
  const bin = resolveFfmpegBin();
  await new Promise<void>((resolve, reject) => {
    const p: ChildProcess = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      cwd,
    });
    let stderr = '';
    let settled = false;
    // Sem teto, um ffmpeg travado (input de rede, disco cheio) deixa o
    // script pendurado para sempre.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill();
      } catch {
        // best-effort
      }
      reject(new Error(`ffmpeg não terminou em ${FFMPEG_TIMEOUT_MS}ms — encerrado`));
    }, FFMPEG_TIMEOUT_MS);
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    // 'close' (e não 'exit'): o stderr chega antes de o processo fechar.
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Renderiza o Short (9:16) a partir do clipe 16:9 já pronto.
 *
 * Uma passada só: `-ss` antes do input (seek rápido; o ffmpeg busca com
 * precisão ao re-encodar) + o filtro do layout. O áudio vai junto
 * (o Short sem a narração do caster perde metade do appeal).
 */
export async function renderShortClip(
  inPath: string,
  outPath: string,
  opts: ShortRenderOptions,
): Promise<{ durSec: number; top: ShortTopMode }> {
  const log = getLogger();
  const startSec = Math.max(0, opts.startSec);
  const durSec = Math.max(1, opts.durSec);
  // Caminhos ABSOLUTOS: com a legenda o ffmpeg roda com o cwd na pasta do
  // `.ass` (o filtro usa só o nome do arquivo) e um caminho relativo
  // deixaria de apontar para o arquivo certo.
  const srcPath = path.resolve(inPath);
  const dstPath = path.resolve(outPath);
  /**
   * A geometria do crop (caixa da cam e fatia do jogo) sai da resolução
   * REAL do clipe. Sem o ffprobe o ffmpeg receberia um crop calculado
   * para 1920x1080: numa fonte 720p ele estoura o quadro (o ffmpeg aborta)
   * e numa 1440p ele aponta para outro lugar da cena (a faixa da cam sai
   * errada). Melhor recusar com mensagem clara do que renderizar errado.
   */
  if (!resolveFfprobeBin()) {
    throw new Error(
      'ffprobe indisponível: o Short precisa da resolução real do clipe (o crop da cam e do jogo saem dela) — instale o ffprobe em .tools/',
    );
  }
  const info = await probeVideoInfo(srcPath);
  if (!info) {
    throw new Error(
      `não consegui medir a resolução de ${path.basename(srcPath)} (ffprobe falhou) — o crop do Short seria um palpite`,
    );
  }
  const layout = buildShortLayout({
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
    top: opts.top ?? (opts.camBox ? 'cam' : 'center'),
    camBox: opts.camBox ?? null,
    camHeight: opts.camHeight,
    camFit: opts.camFit,
    camAnchor: opts.camAnchor,
    gameCrop: opts.gameCrop,
    gameY: opts.gameY,
    gameFit: opts.gameFit,
    gameAspect: opts.gameAspect,
    cropX: opts.cropX,
    srcWidth: info.width,
    srcHeight: info.height,
    captionsAssPath: opts.captionsAssPath ?? null,
  });
  const filter = layout.filter;
  const withAudio = await hasAudioStream(srcPath);
  if (opts.top === 'cam' && layout.top === 'center') {
    log.warn(
      { in: path.basename(srcPath) },
      'Short sem caixa de cam para o canal — usando o crop central 9:16',
    );
  }
  let bannerPath: string | null = null;
  let ownBanner = false;
  if (layout.top === 'text') {
    bannerPath = opts.bannerPng ? path.resolve(opts.bannerPng) : null;
    if (!bannerPath) {
      bannerPath = path.join(
        os.tmpdir(),
        `5k-short-banner-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`,
      );
      ownBanner = true;
      await renderShortBannerPng(
        layout.width,
        layout.topHeight,
        opts.banner ?? { title: 'CS2' },
        bannerPath,
      );
    }
  }
  // A pasta de destino tem que existir ANTES do ffmpeg: o mkdir do caller
  // vinha depois do render e o ffmpeg abortava com "Error opening output
  // file" (o Short nunca era gerado para um clipe novo).
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });

  // Render ATÓMICO: o ffmpeg escreve num `.tmp` e o arquivo final só
  // aparece pronto. Um render interrompido (timeout, disco cheio) deixava
  // um mp4 pela metade no destino — e o script o tratava como "vertical já
  // existe" e pulava o clipe para sempre.
  const tmpPath = `${dstPath}.tmp.mp4`;
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // best-effort
  }

  /**
   * O nome do `.ass` no filtro é sempre SEGURO (o filtergraph não
   * aceita apóstrofo): quando o arquivo tem um nome que o filtro não
   * aceita, o render usa uma cópia com o nome seguro, na mesma pasta
   * (o ffmpeg roda com o cwd nela).
   */
  let assCopyPath: string | null = null;
  if (opts.captionsAssPath) {
    const assPath = path.resolve(opts.captionsAssPath);
    const safe = safeAssName(assPath);
    if (path.basename(assPath) !== safe) {
      assCopyPath = path.join(path.dirname(assPath), safe);
      fs.copyFileSync(assPath, assCopyPath);
    }
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-y',
    '-ss',
    startSec.toFixed(2),
    '-i',
    srcPath,
  ];
  if (bannerPath) {
    // A faixa de texto é uma imagem parada: `-loop 1` + a taxa da fonte
    // para o vstack receber frames no mesmo passo do jogo.
    args.push('-loop', '1', '-framerate', String(info?.fps ?? 60), '-i', bannerPath);
  }
  // `-t` é opção de SAÍDA: depois de todos os inputs.
  args.push('-t', durSec.toFixed(2));
  args.push(
    '-filter_complex',
    withAudio ? `${filter};[0:a]aresample=async=1:first_pts=0[a]` : filter,
    '-map',
    '[v]',
  );
  if (withAudio) args.push('-map', '[a]');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    opts.preset ?? 'veryfast',
    // Mesma política do clipBuilder: o x264 com todos os cores satura a
    // CPU e o recorder perde segmentos durante uma live. O script de
    // Shorts roda em OUTRO processo — sem este limite ele usa a máquina
    // inteira.
    '-threads',
    String(Math.max(2, os.cpus().length - 2)),
    '-crf',
    String(opts.crf ?? 18),
    '-pix_fmt',
    'yuv420p',
  );
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-movflags', '+faststart', tmpPath);

  try {
    // Com legenda, o ffmpeg roda na pasta do `.ass`: o filtro usa só o
    // NOME do arquivo (o caminho absoluto com `C:` e apóstrofo quebra o
    // filtergraph).
    await runFfmpeg(args, opts.captionsAssPath ? path.dirname(path.resolve(opts.captionsAssPath)) : undefined);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort
    }
    throw e;
  } finally {
    if (ownBanner && bannerPath) {
      try {
        fs.rmSync(bannerPath, { force: true });
      } catch {
        // best-effort
      }
    }
    if (assCopyPath) {
      try {
        fs.rmSync(assCopyPath, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  const outDur = await probeDurationSec(tmpPath);
  if (outDur != null && outDur < 1) {
    // Nunca entrega arquivo quebrado: o upload de um mp4 sem moov falha
    // com erro obscuro no YouTube.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort
    }
    throw new Error(`Short renderizado ilegível (duração ${outDur})`);
  }
  try {
    fs.rmSync(dstPath, { force: true });
    fs.renameSync(tmpPath, dstPath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort
    }
    throw new Error(`não consegui gravar o vertical em ${dstPath}: ${String(e).slice(0, 160)}`);
  }
  if (outDur == null) {
    // Sem ffprobe não dá para medir: o arquivo existe e o ffmpeg saiu com 0
    // (nenhum erro), então o render é aceito — mas fica registrado que a
    // duração NÃO foi validada.
    log.warn(
      { in: path.basename(srcPath), out: path.basename(dstPath) },
      'vertical renderizado (duração não validada: ffprobe indisponível)',
    );
  }
  log.info(
    {
      in: path.basename(srcPath),
      out: path.basename(dstPath),
      durSec: round2(outDur ?? durSec),
      top: layout.top,
      camBox: camBoxToString(layout.camBox),
      camFit: layout.camFit,
    },
    'short vertical renderizado',
  );
  return { durSec: round2(outDur ?? durSec), top: layout.top };
}
