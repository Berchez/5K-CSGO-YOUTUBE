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
} from '../clipper/segmentProbe.js';

export interface RecorderOptions {
  streamUrl: string;
  bufferDir: string;
  segmentTimeSec: number;
  segmentWrap: number;
}

/** Linhas do stderr do ffmpeg que indicam falha de input/dessincronia. */
const FFMPEG_SYNC_WARN_RE =
  /non-monotonous dts|cur_dts is stale|timestamps are unset|discontinuity|failed to open segment|error when loading|invalid timestamp/i;

interface PlaylistHead {
  mediaSeq: number | null;
  targetDuration: number | null;
  segments: number;
  discontinuities: number;
  ended: boolean;
}

/**
 * Borda atual da playlist HLS (best-effort): a diferença de mediaSeq entre
 * vídeo e áudio na abertura revela o desalinhamento inicial dos dois
 * inputs (ex: áudio ~2s adiantado). Sem isso o offset vira "mistério".
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
  private deltaSeries: number[] = [];
  private sinceSummary = 0;
  private avIssues = 0;

  constructor(private opts: RecorderOptions) {}

  get isRunning(): boolean {
    return this.running;
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

    // Resolve as URLs HLS diretas (vídeo + áudio separados) e deixa o
    // ffmpeg ler as duas — sem streamlink, só com o que já vem no repo.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const grabUrl = async (format: string): Promise<string> => {
      const { stdout } = await execFileAsync(
        ytdlpBin,
        ['--no-playlist', '--no-warnings', '-g', '-f', format, this.opts.streamUrl],
        { timeout: 60_000 },
      );
      const url = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
      if (!url) throw new Error(`yt-dlp não resolveu o formato ${format}`);
      return url;
    };
    const [videoUrl, audioUrl] = await Promise.all([
      grabUrl('bv*[height<=1080]/bv*'),
      grabUrl('ba/b'),
    ]);
    // Borda das playlists na abertura (diagnóstico do offset inicial):
    // se o áudio abre N sequências à frente do vídeo, o skew já nasce aí.
    try {
      const [vHead, aHead] = await Promise.all([
        fetchPlaylistHead(videoUrl),
        fetchPlaylistHead(audioUrl),
      ]);
      log.info({ video: vHead, audio: aHead }, 'playlists HLS na abertura');
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

    this.ffmpeg = spawn(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      videoUrl,
      '-i',
      audioUrl,
      '-map',
      '0:v',
      '-map',
      '1:a',
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
      //    e CONGELAVA o offset de abertura dos inputs HLS (áudio ~2s
      //    adiantado no arquivo inteiro);
      // 2) wallclock marca frames pelo horário de CHEGADA da rede — rajadas
      //    viram VFR caótico (clipe "powerpoint").
      // Mantendo os PTS ORIGINAIS do broadcast: CFR 60 limpo E as duas
      // trilhas na MESMA linha do tempo (o sync vem de graça; o custo é
      // ≤2s de silêncio no início, cortável pelo trim do render).
      segPattern,
    ]);
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
          log.warn({ src: 'ffmpeg', line: t }, 'ffmpeg sinalizou falha de input/dessincronia');
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

    log.info({ dir: this.opts.bufferDir }, 'recorder iniciado');
    // Dá 10s para os primeiros segmentos aparecerem
    await new Promise((r) => setTimeout(r, 10_000));
    this.startAvWatch();
  }

  /**
   * Vigia A/V do buffer: a cada ciclo probeia os segmentos novos (menos o
   * mais recente, em gravação) e mantém a série temporal do startDelta.
   * Segmento com problema → warn imediato; a cada 6 segmentos, resumo com
   * mediano + drift (constante = offset de abertura; crescente = relógios
   * divergindo; saltos = descontinuidade da fonte). Best-effort puro.
   */
  private startAvWatch(): void {
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
          const segs = this.listSegments();
          const done = segs.length > 1 ? segs.slice(0, -1) : [];
          for (const f of done) {
            const base = path.basename(f);
            if (this.probedSegs.has(base)) continue;
            this.probedSegs.add(base);
            const pkts = await probeSegmentPackets(f, ffprobe);
            if (!pkts) continue;
            const verdict = classifySegmentAv(pkts.video, pkts.audio, slot);
            if (verdict) {
              this.avIssues++;
              this.sinceSummary++;
              if (Number.isFinite(verdict.startDeltaSec)) {
                this.deltaSeries.push(verdict.startDeltaSec);
              }
              log.warn({ seg: base, ...verdict }, 'segmento do buffer com divergência A/V');
            } else {
              const v0 = Math.min(...pkts.video);
              const a0 = Math.min(...pkts.audio);
              if (Number.isFinite(v0) && Number.isFinite(a0)) {
                this.deltaSeries.push(v0 - a0);
              }
              this.sinceSummary++;
              log.debug({ seg: base }, 'segmento do buffer A/V ok');
            }
          }
          if (this.deltaSeries.length > 600) {
            this.deltaSeries.splice(0, this.deltaSeries.length - 600);
          }
          if (this.sinceSummary >= 6) {
            this.sinceSummary = 0;
            log.info(
              {
                probed: this.probedSegs.size,
                issues: this.avIssues,
                medianDeltaSec: Math.round(median(this.deltaSeries) * 100) / 100,
                driftPerSegSec: Math.round(slopePerStep(this.deltaSeries) * 1000) / 1000,
              },
              'série A/V do buffer (mediano + drift)',
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
    return fs
      .readdirSync(this.opts.bufferDir)
      .filter((f) => /^seg_\d+\.ts$/.test(f))
      .map((f) => path.join(this.opts.bufferDir, f))
      .filter((f) => fs.statSync(f).size > 50_000)
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  }
}
