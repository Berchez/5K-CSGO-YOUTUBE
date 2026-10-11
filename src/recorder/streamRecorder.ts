import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../logger.js';

export interface RecorderOptions {
  streamUrl: string;
  bufferDir: string;
  segmentTimeSec: number;
  segmentWrap: number;
}

export class StreamRecorder {
  private ffmpeg: ChildProcess | null = null;
  private streamlink: ChildProcess | null = null;
  private running = false;

  constructor(private opts: RecorderOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  get segmentDir(): string {
    return this.opts.bufferDir;
  }

  /** Checa binários (winget: ffmpeg + streamlink). */
  static checkBinaries(): { ffmpeg: boolean; streamlink: boolean } {
    const has = (bin: string): boolean => {
      const paths = (process.env.PATH ?? '').split(path.delimiter);
      const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
      return paths.some((p) => {
        try {
          return fs.existsSync(path.join(p, exe)) || fs.existsSync(path.join(p, bin));
        } catch {
          return false;
        }
      });
    };
    return { ffmpeg: has('ffmpeg'), streamlink: has('streamlink') };
  }

  async start(): Promise<void> {
    if (this.running) return;
    const log = getLogger();
    fs.mkdirSync(this.opts.bufferDir, { recursive: true });

    const { ffmpeg, streamlink } = StreamRecorder.checkBinaries();
    if (!ffmpeg) {
      throw new Error(
        'ffmpeg não encontrado no PATH. Instale com: winget install Gyan.FFmpeg  (ou choco install ffmpeg)',
      );
    }
    if (!streamlink) {
      throw new Error(
        'streamlink não encontrado no PATH. Instale com: winget install Streamlink.Streamlink  (ou pip install streamlink)',
      );
    }

    const segPattern = path.join(this.opts.bufferDir, 'seg_%03d.mp4');

    // streamlink joga o stream no stdout -> ffmpeg segmenta em buffer circular
    this.streamlink = spawn(
      'streamlink',
      [this.opts.streamUrl, 'best', '-O'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      'pipe:0',
      '-c',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      String(this.opts.segmentTimeSec),
      '-segment_wrap',
      String(this.opts.segmentWrap),
      '-segment_format',
      'mp4',
      '-reset_timestamps',
      '1',
      segPattern,
    ]);

    this.streamlink.stdout?.pipe(this.ffmpeg.stdin!);
    this.running = true;

    this.streamlink.stderr?.on('data', (d) =>
      log.debug({ src: 'streamlink' }, String(d).slice(0, 300)),
    );
    this.ffmpeg.stderr?.on('data', (d) =>
      log.debug({ src: 'ffmpeg' }, String(d).slice(0, 300)),
    );
    const onExit = (src: string) => (code: number | null) => {
      log.warn({ src, code }, 'processo de gravação encerrou');
      this.running = false;
    };
    this.streamlink.on('exit', onExit('streamlink'));
    this.ffmpeg.on('exit', onExit('ffmpeg'));

    log.info({ dir: this.opts.bufferDir }, 'recorder iniciado');
    // Dá 10s para os primeiros segmentos aparecerem
    await new Promise((r) => setTimeout(r, 10_000));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.streamlink?.kill('SIGTERM');
    // ffmpeg precisa de SIGINT para finalizar o segmento atual
    this.ffmpeg?.kill('SIGINT');
    this.streamlink = null;
    this.ffmpeg = null;
  }

  /** Lista segmentos ordenados por mtime (mais antigo -> mais novo). */
  listSegments(): string[] {
    if (!fs.existsSync(this.opts.bufferDir)) return [];
    return fs
      .readdirSync(this.opts.bufferDir)
      .filter((f) => /^seg_\d+\.mp4$/.test(f))
      .map((f) => path.join(this.opts.bufferDir, f))
      .filter((f) => fs.statSync(f).size > 50_000)
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  }
}
