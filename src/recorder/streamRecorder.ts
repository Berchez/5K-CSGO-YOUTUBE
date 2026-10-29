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
            try {
              key = `${base}:${Math.round(fs.statSync(f).mtimeMs)}`;
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
}
