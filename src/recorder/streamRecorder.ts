import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../logger.js';
import {
  classifySegmentAv,
  median,
  probeSegmentPackets,
  resolveFfprobeBin,
  slopePerStep,
  startDeltaSec,
} from '../clipper/segmentProbe.js';
import {
  fetchPlaylist,
  findTimelineShifts,
  mergePlaylistSegments,
  originOffsetMs,
  parseHlsPlaylist,
  type PlaylistSegment,
} from './hlsTimeline.js';
import { DEFAULT_DISK_MIN_FREE_BYTES, gb, getFreeBytes, isFreeSpaceOk } from '../diskSpace.js';

export interface RecorderOptions {
  streamUrl: string;
  bufferDir: string;
  segmentTimeSec: number;
  segmentWrap: number;
  /**
   * Seletor de formato do yt-dlp para a fonte COMBINADA. Default 'best'
   * (a melhor variante combinada da fonte). Ver CAPTURE_FORMAT.
   */
  captureFormat?: string;
  /** Nome da stream (contexto nos logs do recorder e do clipe). */
  streamName?: string;
  /** Livre mínimo (bytes) — abaixo disto, error a cada ciclo (não para). */
  diskMinFreeBytes?: number;
}

/** Linhas do stderr do ffmpeg que indicam falha de input/dessincronia. */
const FFMPEG_SYNC_WARN_RE =
  /non-monotonous dts|cur_dts is stale|timestamps are unset|discontinuity|failed to open segment|error when loading|invalid timestamp/i;

/** Subconjunto: restart do transcode na fonte (diagnóstico de descontinuidade). */
const DISCONTINUITY_RE = /timestamp discontinuity|discontinuity/i;

/** Linha de restart do transcode? Puro/testável. */
export function isDiscontinuityLine(line: string): boolean {
  return DISCONTINUITY_RE.test(line);
}

/**
 * Evento que quebra a continuidade da timeline do vídeo.
 *
 * 'discontinuity': o ffmpeg avisou que a fonte reiniciou a base de PTS
 * (o conteúdo pode ter pulado). 'pts-jump'/'stall': detectados no
 * probe do segmento (salto de PTS / imagem congelada).
 *
 * Não é prova de buraco no conteúdo (muitas descontinuidades são
 * normality da fonte), mas é o sinal de que o material na janela do
 * clipe pode não ser contíguo — o clipe precisa ser marcado como tal.
 */
export interface TimelineEvent {
  /** Quando o evento foi observado (wall ms). */
  atMs: number;
  kind: 'discontinuity' | 'pts-jump' | 'stall' | 'pdt-gap';
  detail?: string;
}

/** Eventos guardados por recorder (buffer circular em memória). */
const MAX_TIMELINE_EVENTS = 200;

/** Intervalo da leitura da playlist HLS (ms) — relógio de origem. */
const PLAYLIST_WATCH_INTERVAL_MS = 15_000;

/** Quantidade de saltos de atraso guardados (buffer circular). */
const MAX_DELAY_SHIFTS = 50;

interface PlaylistHead {
  mediaSeq: number | null;
  targetDuration: number | null;
  segments: number;
  discontinuities: number;
  ended: boolean;
}

/**
 * A fonte não expõe formato COMBINADO (áudio + vídeo no mesmo formato).
 *
 * Não é falha operacional (rede/ffmpeg/disco): é limitação da fonte. A
 * partida é ignorada e a stream é marcada como falhada (o próximo poll
 * tenta outra candidata). O erro é próprio para o log não dizer "falhou
 * a gravação" quando o problema é a fonte não ter o formato.
 */
export class MuxedFormatUnavailableError extends Error {
  constructor(message = 'a fonte não expõe formato combinado (muxed)') {
    super(message);
    this.name = 'MuxedFormatUnavailableError';
  }
}

/** Erro do yt-dlp que indica "não tem formato combinado". */
const NO_MUXED_FORMAT_RE =
  /no video formats|requested format is not available|no formats found|requested format not available/i;

/**
 * Plano de captura: a ÚNICA fonte aceita é a variante combinada (muxed)
 * da stream — áudio e vídeo no mesmo formato. Sem fonte combinada não há
 * gravação (a alternativa seria o par separado de feeds, que exige
 * correções de skew A/V).
 *
 * O seletor de formato vem da config (CAPTURE_FORMAT, default 'best'):
 * é o kill-switch da camada de captura — trocar a variante combinada
 * sem mexer no código. Ele NUNCA pode apontar para vídeo separado
 * ('bv*'): a captura é UM input com áudio e vídeo.
 */
export function capturePlan(format = 'best'): { formats: string[]; maps: string[] } {
  const selector = format.trim() || 'best';
  return { formats: [selector], maps: ['0:v', '0:a'] };
}

/**
 * Borda atual da playlist HLS (best-effort): número de segmentos,
 * duração-alvo e descontinuidades da fonte no momento da abertura.
 */
async function fetchPlaylistHead(url: string): Promise<PlaylistHead | null> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, 16_384);
      const seq = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      const target = text.match(/#EXT-X-TARGETDURATION:([\d.]+)/);
      return {
        mediaSeq: seq ? Number(seq[1]) : null,
        targetDuration: target ? Number(target[1]) : null,
        segments: (text.match(/#EXTINF/g) ?? []).length,
        discontinuities: (text.match(/#EXT-X-DISCONTINUITY/g) ?? []).length,
        ended: text.includes('#EXT-X-ENDLIST'),
      };
    } finally {
      clearTimeout(to);
    }
  } catch {
    return null;
  }
}

export class StreamRecorder {
  private ffmpeg: ChildProcess | null = null;
  private running = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchBusy = false;
  private probedSegs = new Set<string>();
  private sinceSummary = 0;
  private avIssues = 0;
  /**
   * Série do offset de abertura (vídeo − áudio) por segmento. A captura
   * é única (muxed), então o skew vem da FONTE — a série (mediana +
   * drift) é a evidência de que áudio e vídeo chegam alinhados.
   */
  private avDeltas: number[] = [];
  /** Último estado do disco (null = desconhecido): avisa só em transição. */
  private diskOk: boolean | null = null;
  /**
   * Eventos de quebra de continuidade da timeline (descontinuidade da
   * fonte, salto de PTS, stall, salto do relógio de origem). Vão para
   * o clipe: material não contíguo na janela precisa ser sinalizado, não
   * entregue em silêncio.
   */
  private timelineEvents: TimelineEvent[] = [];
  /**
   * URL do HLS resolvido (playlist viva): permite ler o relógio de
   * ORIGEM do conteúdo (#EXT-X-PROGRAM-DATE-TIME).
   */
  private hlsUrl: string | null = null;
  /**
   * Saltos do relógio de origem: quando o PDT avança mais que o
   * conteúdo, a stream passou a entregar material mais antigo (o
   * atraso cresceu). É a mudança de atraso detectada SEM OCR.
   */
  private delayShifts: Array<{ atPdtMs: number; atMs: number; shiftSec: number }> = [];
  private playlistTimer: NodeJS.Timeout | null = null;
  private playlistBusy = false;
  /** Último offset entre o relógio de origem (PDT) e o relógio local. */
  private originOffsetMs: number | null = null;
  /**
   * Segmentos da playlist já vistos (com o PDT). A playlist VIVA tem
   * janela deslizante: um salto que caia na borda da janela sumiria
   * (o segmento seguinte viria "primeiro" na leitura). Guardando os
   * últimos segmentos, o salto é detectado mesmo assim.
   */
  private originSegments: PlaylistSegment[] = [];

  constructor(private opts: RecorderOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Nome da stream (contexto nos logs). */
  get streamName(): string | undefined {
    return this.opts.streamName;
  }

  get segmentDir(): string {
    return this.opts.bufferDir;
  }

  /** ffmpeg/yt-dlp: primeiro no PATH, senão os vendored em .tools/. */
  static resolveBin(name: string): string | null {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const paths = (process.env.PATH ?? '').split(path.delimiter);
    for (const p of paths) {
      try {
        const full = path.join(p, exe);
        if (fs.existsSync(full)) return full;
      } catch {
        // ignora entradas inválidas do PATH
      }
    }
    const vendored = path.resolve('.tools', exe);
    try {
      if (fs.existsSync(vendored)) return vendored;
    } catch {
      // ignora
    }
    return null;
  }

  /** Checa binários (PATH ou .tools/ vendored). */
  static checkBinaries(): { ffmpeg: boolean; ytdlp: boolean } {
    return { ffmpeg: !!StreamRecorder.resolveBin('ffmpeg'), ytdlp: !!StreamRecorder.resolveBin('yt-dlp') };
  }

  async start(): Promise<void> {
    if (this.running) return;
    const log = getLogger();
    fs.mkdirSync(this.opts.bufferDir, { recursive: true });

    const ffmpegBin = StreamRecorder.resolveBin('ffmpeg');
    const ytdlpBin = StreamRecorder.resolveBin('yt-dlp');
    if (!ffmpegBin) {
      throw new Error('ffmpeg não encontrado (nem no PATH nem em .tools/).');
    }
    if (!ytdlpBin) {
      throw new Error('yt-dlp não encontrado (nem no PATH nem em .tools/).');
    }

    // Limpa segmentos de sessão anterior (ex: recorder morto sem stop
    // gracioso): misturar gerações no mesmo buffer gera concat quebrado.
    for (const f of fs.readdirSync(this.opts.bufferDir)) {
      if (/^seg_\d+\.(ts|mp4)$/.test(f)) {
        fs.rmSync(path.join(this.opts.bufferDir, f), { force: true });
      }
    }
    // Mata ffmpeg fantasma de sessão anterior neste bufferDir (Windows
    // não mata filhos quando o pai morre — sem isso eles acumulam).
    const { killStale, track, untrack } = await import('../procRegistry.js');
    const stale = killStale(path.resolve(this.opts.bufferDir));
    if (stale > 0) {
      log.warn({ stale }, 'ffmpegs fantasmas do buffer mortos');
    }

    const plan = capturePlan(this.opts.captureFormat);
    // `best` selects the highest-quality combined format exposed by the source.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const grabUrl = async (format: string): Promise<string> => {
      try {
        const { stdout } = await execFileAsync(
          ytdlpBin,
          ['--no-playlist', '--no-warnings', '-g', '-f', format, this.opts.streamUrl],
          // windowsHide: yt-dlp abre console próprio no Windows (rouba foco do jogo)
          { timeout: 60_000, windowsHide: true },
        );
        const url = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
        if (!url) throw new Error(`yt-dlp não resolveu o formato ${format}`);
        return url;
      } catch (e) {
        const raw = String((e as { stderr?: unknown })?.stderr ?? e);
        if (NO_MUXED_FORMAT_RE.test(raw)) {
          throw new MuxedFormatUnavailableError(
            `a fonte não expõe formato combinado (muxed): ${raw.replace(/\s+/g, ' ').slice(0, 160)}`,
          );
        }
        throw e;
      }
    };
    const urls = await Promise.all(plan.formats.map(grabUrl));
    this.hlsUrl = urls[0] ?? null;
    // Borda da playlist na abertura (diagnóstico da fonte).
    try {
      const heads = await Promise.all(urls.map(fetchPlaylistHead));
      log.info({ source: heads[0] }, 'playlist HLS na abertura');
    } catch {
      // best-effort: a gravação não depende disto
    }

    // Segmentos em MPEG-TS (NÃO mp4): MP4 só escreve o moov ao FINALIZAR —
    // qualquer morte abrupta (stop, queda de stream) deixa o arquivo
    // ilegível ("moov atom not found"). TS é formato de streaming: um
    // segmento parcial é utilizável até o último GOP; corrupção vira
    // "alguns frames a menos", não arquivo morto. O clipBuilder concatena
    // os .ts e entrega MP4 na saída.
    const segPattern = path.join(this.opts.bufferDir, 'seg_%03d.ts');

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'warning',
    ];
    for (const url of urls) ffmpegArgs.push('-i', url);
    ffmpegArgs.push(
      ...plan.maps.flatMap((mapping) => ['-map', mapping]),
      '-c',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      String(this.opts.segmentTimeSec),
      '-segment_wrap',
      String(this.opts.segmentWrap),
      '-segment_format',
      'mpegts',
      // SEM -reset_timestamps e SEM -use_wallclock_as_timestamps:
      // 1) reset por segmento zerava cada trilha na sua própria abertura
      //    e CONGELAVA o offset de abertura do input HLS;
      // 2) wallclock marca frames pelo horário de CHEGADA da rede — rajadas
      //    viram VFR caótico (clipe "powerpoint").
      // Mantendo os PTS ORIGINAIS do broadcast: CFR 60 limpo E áudio/vídeo
      // na MESMA linha do tempo (o sync vem de graça; o custo é ≤2s de
      // silêncio no início, cortável pelo trim do render).
      segPattern,
    );
    // windowsHide: o recorder vive horas — sem isso o Windows abre um
    // console próprio p/ o ffmpeg (rouba foco do jogo em fullscreen).
    this.ffmpeg = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
    this.running = true;
    const recProc = this.ffmpeg;
    track(recProc);
    // stderr com buffer de linha: avisos de sync (DTS fora de ordem, input
    // estagnado, descontinuidade) viram warn estruturado em vez de se
    // perderem no debug fatiado — é daqui que sai a evidência do stall.
    let errTail = '';
    this.ffmpeg.stderr?.on('data', (d) => {
      errTail += String(d);
      const lines = errTail.split(/\r?\n/);
      errTail = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim().slice(0, 300);
        if (!t) continue;
        if (FFMPEG_SYNC_WARN_RE.test(t)) {
          // Restart do transcode na fonte: a partir daqui a linha do tempo
          // pode mudar — sinaliza no log para o clipe ser conferido.
          const restart = isDiscontinuityLine(t);
          if (restart) this.recordTimelineEvent({ atMs: Date.now(), kind: 'discontinuity', detail: t });
          log.warn({ src: 'ffmpeg', line: t, restart }, 'ffmpeg sinalizou falha de input/dessincronia');
        } else {
          log.debug({ src: 'ffmpeg' }, t);
        }
      }
    });
    const onExit = (src: string) => (code: number | null) => {
      untrack(recProc);
      log.warn({ src, code }, 'processo de gravação encerrou');
      this.running = false;
    };
    this.ffmpeg.on('exit', onExit('ffmpeg'));

    log.info({ dir: this.opts.bufferDir, formato: plan.formats[0] }, 'recorder iniciado');
    // Dá 10s para os primeiros segmentos aparecerem
    await new Promise((r) => setTimeout(r, 10_000));
    if (!this.running) {
      throw new Error('ffmpeg encerrou durante a inicialização');
    }
    this.startBufferWatch();
    this.startPlaylistWatch();
  }

  /**
   * Vigia do RELÓGIO DE ORIGEM: lê a playlist HLS e compara o
   * #EXT-X-PROGRAM-DATE-TIME dos segmentos.
   *
   * Quando o PDT avança mais que o conteúdo (a fonte "pulou"), a
   * stream passou a entregar material mais antigo: o atraso da stream
   * CRESCU de exatamente o salto. É a detecção da mudança de atraso
   * entre dois rounds (ou no meio deles) sem depender de OCR — e o
   * instante do salto (no relógio local) diz se ele caiu ANTES ou
   * DEPOIS da 1ª kill, o que desambigua a âncora do início.
   */
  private startPlaylistWatch(): void {
    const log = getLogger();
    this.playlistTimer = setInterval(() => {
      if (!this.running || this.playlistBusy) return;
      this.playlistBusy = true;
      (async () => {
        try {
          const url = this.hlsUrl;
          if (!url) return;
          const text = await fetchPlaylist(url);
          if (!text) return;
          const parsed = parseHlsPlaylist(text);
          this.originSegments = mergePlaylistSegments(this.originSegments, parsed);
          const segments = this.originSegments;
          const shifts = findTimelineShifts(segments, this.opts.segmentTimeSec);
          if (segments.length === 0) return;
          // Offset origem→local: o mtime do segmento local mais novo
          // menos o PDT mais novo (o mesmo "agora" dos dois relógios).
          const offset = this.estimateOriginOffsetMs(segments);
          this.originOffsetMs = offset;
          for (const shift of shifts) {
            const atMs = shift.atPdtMs + offset;
            // Dedup pelo PDT de ORIGEM: o offset origem→local é
            // reestimado a cada leitura e pode variar 1-2s, então
            // comparar `atMs` duplicava o mesmo salto. O PDT é estável.
            const known = this.delayShifts.some(
              (entry) => entry.atPdtMs === shift.atPdtMs,
            );
            if (known) continue;
            this.delayShifts.push({
              atPdtMs: shift.atPdtMs,
              atMs,
              shiftSec: shift.shiftSec,
            });
            while (this.delayShifts.length > MAX_DELAY_SHIFTS) this.delayShifts.shift();
            this.recordTimelineEvent({
              atMs,
              kind: 'pdt-gap',
              detail: `salto de ${shift.shiftSec}s no relógio de origem`,
            });
            log.warn(
              {
                stream: this.opts.streamName,
                at: new Date(atMs).toISOString(),
                shiftSec: shift.shiftSec,
                esperadoSec: shift.expectedSec,
              },
              'atraso da stream aumentou (salto no relógio de origem da playlist)',
            );
          }
        } catch {
          // best-effort: nunca derruba o recorder
        } finally {
          this.playlistBusy = false;
        }
      })().catch(() => undefined);
    }, PLAYLIST_WATCH_INTERVAL_MS);
    this.playlistTimer.unref?.();
  }

  /**
   * Offset entre o relógio de origem (PDT) e o relógio local (mtime).
   * Aproxima pelo segmento local mais novo e o PDT mais novo — erro de
   * um segmento (10s), o suficiente para dizer se um salto caiu antes
   * ou depois da 1ª kill.
   */
  private estimateOriginOffsetMs(segments: Array<{ pdtMs: number | null }>): number {
    const withPdt = segments
      .map((segment) => segment.pdtMs)
      .filter((value): value is number => value != null);
    const local = this.listSegments();
    if (local.length === 0) return 0;
    let newestLocal = 0;
    try {
      newestLocal = fs.statSync(local[local.length - 1]).mtimeMs;
    } catch {
      return 0;
    }
    return originOffsetMs(withPdt, newestLocal);
  }

  /**
   * Aumento do atraso (ms) acumulado na janela [fromMs, toMs] do
   * relógio local. É o que corrige a âncora do início quando a stream
   * "pulou" entre a medição anterior e a 1ª kill.
   */
  delayShiftSince(fromMs: number, toMs: number): number {
    const from = Math.min(fromMs, toMs);
    const to = Math.max(fromMs, toMs);
    let total = 0;
    for (const shift of this.delayShifts) {
      if (shift.atMs < from || shift.atMs > to) continue;
      total += shift.shiftSec;
    }
    return Math.round(total * 1000);
  }

  /** Saltos de atraso detectados (diagnóstico). */
  delayShiftEvents(): Array<{ atMs: number; shiftSec: number }> {
    return [...this.delayShifts];
  }

  /** Último offset origem→local (null = ainda não medido). */
  originOffset(): number | null {
    return this.originOffsetMs;
  }

  /**
   * Vigia do buffer: a cada ciclo probeia os segmentos novos (menos o
   * mais recente, em gravação) e reporta divergências/stalls/saltos de PTS.
   * Best-effort puro.
   */
  private startBufferWatch(): void {
    const log = getLogger();
    const slot = this.opts.segmentTimeSec;
    const ffprobe = resolveFfprobeBin();
    if (!ffprobe) {
      log.debug('sem ffprobe, vigia A/V do buffer desligada');
      return;
    }
    const intervalMs = Math.max(10_000, slot * 1000);
    this.watchTimer = setInterval(() => {
      if (!this.running || this.watchBusy) return;
      this.watchBusy = true;
      (async () => {
        try {
          // Disco: sem espaço os segmentos novos param de acumular — avisa
          // (com transição, sem spam) em vez de falhar silencioso.
          const diskMin = this.opts.diskMinFreeBytes ?? DEFAULT_DISK_MIN_FREE_BYTES;
          const diskFree = getFreeBytes(this.opts.bufferDir);
          const ok = isFreeSpaceOk(diskFree, diskMin);
          if (!ok && this.diskOk !== false) {
            log.error(
              { dir: this.opts.bufferDir, livre: diskFree != null ? gb(diskFree) : 'desconhecido', minimo: gb(diskMin) },
              'disco quase cheio — segmentos vão parar de acumular, libere espaço',
            );
          } else if (ok && this.diskOk === false) {
            log.info('espaço em disco recuperado, gravação segue normal');
          }
          this.diskOk = ok;
          const segs = this.listSegments();
          const done = segs.length > 1 ? segs.slice(0, -1) : [];
          for (const f of done) {
            const base = path.basename(f);
            // O buffer é CIRCULAR (segment_wrap): os mesmos nomes são
            // reescritos a cada volta. Chavear só pelo nome deixava a
            // vigia cega depois da primeira volta (4min de partida).
            // A chave inclui o mtime: o mesmo nome com mtime novo = novo
            // conteúdo = reanalisar.
            let key = base;
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(f).mtimeMs;
              key = `${base}:${Math.round(mtimeMs)}`;
            } catch {
              continue; // arquivo sumiu no meio (buffer rotacionando)
            }
            if (this.probedSegs.has(key)) continue;
            this.probedSegs.add(key);
            // Set limitado (a ordem de inserção é a ordem de análise):
            // sem limite ele cresce a cada volta do buffer.
            const maxKeys = Math.max(32, this.opts.segmentWrap * 4);
            while (this.probedSegs.size > maxKeys) {
              const oldest = this.probedSegs.values().next();
              if (oldest.done) break;
              this.probedSegs.delete(oldest.value);
            }
            const pkts = await probeSegmentPackets(f, ffprobe);
            if (!pkts) continue;
            const delta = startDeltaSec(pkts.video, pkts.audio);
            if (Number.isFinite(delta)) {
              this.avDeltas.push(delta);
              while (this.avDeltas.length > 12) this.avDeltas.shift();
            }
            const verdict = classifySegmentAv(pkts.video, pkts.audio, slot);
            if (verdict) {
              this.avIssues++;
              this.sinceSummary++;
              if (verdict.kind === 'pts-jump' || verdict.kind === 'stall') {
                this.recordTimelineEvent({
                  atMs: mtimeMs,
                  kind: verdict.kind,
                  detail: `${base}: ${verdict.kind}`,
                });
              }
              log.warn({ seg: base, ...verdict }, 'segmento do buffer com divergência A/V');
            } else {
              this.sinceSummary++;
              log.debug({ seg: base }, 'segmento do buffer A/V ok');
            }
          }
          if (this.sinceSummary >= 6) {
            this.sinceSummary = 0;
            log.info(
              {
                probed: this.probedSegs.size,
                issues: this.avIssues,
                startDeltaMediano: median(this.avDeltas),
                driftPorSegmento: slopePerStep(this.avDeltas),
              },
              'resumo da vigia do buffer',
            );
          }
        } catch {
          // best-effort: nunca derruba o recorder
        } finally {
          this.watchBusy = false;
        }
      })().catch(() => undefined);
    }, intervalMs);
    this.watchTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.playlistTimer) {
      clearInterval(this.playlistTimer);
      this.playlistTimer = null;
    }
    const ff = this.ffmpeg;
    if (ff) {
      // Stop GRACIOSO: 'q' no stdin manda o ffmpeg finalizar o segmento
      // atual (escreve o fim do arquivo). No Windows kill('SIGINT') mata
      // abrupto e corrompe o segmento em escrita (a causa original dos
      // "moov atom not found"). Espera até 8s; força só se travar.
      const exited = new Promise<void>((resolve) => ff.once('exit', resolve));
      try {
        ff.stdin?.write('q');
      } catch {
        // stdin já fechado — segue para o kill
      }
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
      ]);
      if (!graceful) ff.kill('SIGKILL');
    }
    this.ffmpeg = null;
  }

  /** Lista segmentos ordenados por mtime (mais antigo -> mais novo). */
  listSegments(): string[] {
    if (!fs.existsSync(this.opts.bufferDir)) return [];
    const out: Array<{ file: string; mtimeMs: number; size: number }> = [];
    for (const f of fs.readdirSync(this.opts.bufferDir)) {
      if (!/^seg_\d+\.ts$/.test(f)) continue;
      const file = path.join(this.opts.bufferDir, f);
      try {
        // O buffer rotaciona DEPOIS da listagem: o arquivo pode sumir
        // entre o readdir e o stat (erro ENOENT derrubaria a vigia).
        const st = fs.statSync(file);
        if (st.size <= 50_000) continue;
        out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs).map((s) => s.file);
  }

  /** Registra um evento de quebra de continuidade (buffer circular). */
  private recordTimelineEvent(event: TimelineEvent): void {
    this.timelineEvents.push(event);
    while (this.timelineEvents.length > MAX_TIMELINE_EVENTS) this.timelineEvents.shift();
  }

  /**
   * Eventos de quebra de continuidade dentro da janela [fromMs, toMs]
   * (timeline do vídeo = mtime dos segmentos).
   *
   * Um evento aqui significa que o material do clipe pode ter um buraco
   * (a fonte reiniciou a base de PTS ou o probe viu salto/stall). Não é
   * prova de conteúdo perdido, mas o clipe precisa ser marcado.
   */
  timelineEventsInWindow(fromMs: number, toMs: number): TimelineEvent[] {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
    const from = Math.min(fromMs, toMs);
    const to = Math.max(fromMs, toMs);
    return this.timelineEvents.filter((event) => event.atMs >= from && event.atMs <= to);
  }

  /** Todos os eventos de quebra registrados (diagnóstico). */
  allTimelineEvents(): TimelineEvent[] {
    return [...this.timelineEvents];
  }
}
