import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../logger.js';
import { resolveFfmpegBin, resolveFfprobeBin } from './segmentProbe.js';

const execFileAsync = promisify(execFile);

/**
 * Shorts verticais (9:16) de ACE.
 *
 * O material do bot é 16:9 (transmissão da HLTV). O Shorts do YouTube
 * só aparece no feed vertical — então o vertical precisa ser PRODUZIDO no
 * render, não na captura (o capture é `-c copy` e continua 16:9).
 *
 * Duas peças:
 * 1. `planShortWindow` — a janela de 30-60s que cobre a jogada (a 1ª
 *    kill até a última). O clipe do bot tem 60-190s (pre-roll + ação +
 *    cauda) e o Shorts aceita 60s.
 * 2. `renderShortClip` — o corte 9:16 (crop central + scale) numa
 *    passada de ffmpeg.
 */

/** Duração máxima do Short (o YouTube aceita até 3min, mas 60s é o corte). */
export const SHORT_DEFAULT_MAX_SEC = 60;
/** Duração mínima (abaixo disso o Short é rápido demais e perde retenção). */
export const SHORT_DEFAULT_MIN_SEC = 30;
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
 * Janela do Short: da 1ª kill até a última, dentro de 30-60s.
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
   * Posição horizontal do crop (0 = esquerda, 0.5 = centro, 1 = direita).
   * O crop 9:16 de um 16:9 corta ~2/3 da largura: o HUD (placar no topo,
   * killfeed na direita) pode ficar de fora — este é o ajuste para
   * puxar a janela sem mexer no código.
   */
  cropX?: number;
  /** CRF do x264 (default 18). */
  crf?: number;
  /** Preset do x264 (default veryfast — o render não pode saturar a CPU). */
  preset?: string;
}

/**
 * Filtro de vídeo do Short: crop 9:16 pela ALTURA (a largura é o que
 * sobra) + scale para a saída + SAR quadrado.
 *
 * `crop=ih*9/16` recorta pela altura (o 16:9 tem largura de sobra) — o
 * centro do frame é onde a mira e a ação ficam no CS2.
 */
export function shortVideoFilter(opts: ShortRenderOptions): string {
  const width = Math.max(2, Math.round(opts.width ?? 1080));
  const height = Math.max(2, Math.round(opts.height ?? 1920));
  const cropX = clamp(opts.cropX ?? 0.5, 0, 1);
  return [
    `crop=ih*9/16:ih:(iw-ih*9/16)*${cropX}:0`,
    `scale=${width}:${height}:flags=lanczos`,
    'setsar=1',
  ].join(',');
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

async function hasAudioStream(file: string): Promise<boolean> {
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

/** Teto do render: um vertical de 60s não passa de minutos. */
const FFMPEG_TIMEOUT_MS = 900_000;

/** execFile com log do erro (o render do Short é um passo do script). */
async function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpegBin();
  await new Promise<void>((resolve, reject) => {
    const p: ChildProcess = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
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
 * precisão ao re-encodar) + crop/scale no filtro. O áudio vai junto
 * (o Short sem a narração do caster perde metade do appeal).
 */
export async function renderShortClip(
  inPath: string,
  outPath: string,
  opts: ShortRenderOptions,
): Promise<{ durSec: number }> {
  const log = getLogger();
  const startSec = Math.max(0, opts.startSec);
  const durSec = Math.max(1, opts.durSec);
  const filter = shortVideoFilter(opts);
  const withAudio = await hasAudioStream(inPath);
  // A pasta de destino tem que existir ANTES do ffmpeg: o mkdir do caller
  // vinha depois do render e o ffmpeg abortava com "Error opening output
  // file" (o Short nunca era gerado para um clipe novo).
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Render ATÓMICO: o ffmpeg escreve num `.tmp` e o arquivo final só
  // aparece pronto. Um render interrompido (timeout, disco cheio) deixava
  // um mp4 pela metade no destino — e o script o tratava como "vertical já
  // existe" e pulava o clipe para sempre.
  const tmpPath = `${outPath}.tmp.mp4`;
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // best-effort
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
    inPath,
    '-t',
    durSec.toFixed(2),
  ];
  if (withAudio) {
    args.push(
      '-filter_complex',
      `[0:v]${filter}[v];[0:a]aresample=async=1:first_pts=0[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
    );
  } else {
    args.push('-vf', filter, '-map', '0:v:0');
  }
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
    await runFfmpeg(args);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort
    }
    throw e;
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
    fs.rmSync(outPath, { force: true });
    fs.renameSync(tmpPath, outPath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort
    }
    throw new Error(`não consegui gravar o vertical em ${outPath}: ${String(e).slice(0, 160)}`);
  }
  if (outDur == null) {
    // Sem ffprobe não dá para medir: o arquivo existe e o ffmpeg saiu com 0
    // (nenhum erro), então o render é aceito — mas fica registrado que a
    // duração NÃO foi validada.
    log.warn(
      { in: path.basename(inPath), out: path.basename(outPath) },
      'vertical renderizado (duração não validada: ffprobe indisponível)',
    );
  }
  log.info(
    { in: path.basename(inPath), out: path.basename(outPath), durSec: round2(outDur ?? durSec) },
    'short vertical renderizado',
  );
  return { durSec: round2(outDur ?? durSec) };
}
