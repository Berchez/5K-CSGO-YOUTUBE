/**
 * whisper.cpp local (binário CPU em .tools/whisper.cpp).
 *
 * O `whisper-cli -oj` grava um JSON com offsets em ms; o VAD do Silero é
 * opcional e, quando ligado, pula silêncio — foi o que mais reduziu o
 * tempo no áudio de jogo (37,5s vs 53,6s no clip de teste).
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asNumber, asRecord, asText } from '../http.js';
import { sanitizeSegments } from '../segments.js';
import {
  resolveSileroVadModel,
  resolveWhisperCppBin,
  resolveWhisperCppModel,
} from '../audio.js';
import {
  clockToSec,
  readJsonFile,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

const execFileAsync = promisify(execFile);

/** Threads do whisper.cpp: metade dos núcleos, mínimo 4. */
export function whisperThreads(cpus: number): number {
  const n = Number(cpus);
  return Number.isFinite(n) && n > 0 ? Math.max(4, Math.floor(n / 2)) : 4;
}

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const bin = resolveWhisperCppBin();
  if (!fs.existsSync(bin)) {
    throw new Error(`whisper-cli não encontrado em ${bin}`);
  }
  const modelPath = resolveWhisperCppModel(req.model);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`modelo ggml não encontrado: ${modelPath}`);
  }
  const outBase = `${req.wavPath}.whisper-cpp`;
  const outPath = `${outBase}.json`;
  const args = [
    '-m',
    modelPath,
    '-f',
    req.wavPath,
    '-l',
    req.language ?? 'auto',
    '-t',
    String(whisperThreads(os.cpus().length)),
    '-oj',
    '-of',
    outBase,
  ];
  const vadModel = resolveSileroVadModel();
  if (req.vad && fs.existsSync(vadModel)) {
    args.push('--vad', '-vm', vadModel);
  }
  let raw: unknown;
  try {
    await execFileAsync(bin, args, {
      windowsHide: true,
      timeout: req.timeoutMs,
      maxBuffer: 1024 * 1024 * 32,
    });
    raw = readJsonFile(outPath);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `whisper.cpp falhou: ${String(err.stderr || err.message || e).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(outPath, { force: true });
  }
  const record = asRecord(raw);
  const items = Array.isArray(record.transcription) ? record.transcription : [];
  const segments = sanitizeSegments(
    items.map((item) => {
      const entry = asRecord(item);
      const offsets = asRecord(entry.offsets);
      let start = asNumber(offsets.from) / 1000;
      let end = asNumber(offsets.to) / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        const stamps = asRecord(entry.timestamps);
        start = clockToSec(asText(stamps.from));
        end = clockToSec(asText(stamps.to));
      }
      return { startSec: start, endSec: end, text: entry.text };
    }),
  );
  const result = asRecord(record.result);
  const language = asText(result.language).trim() || req.language;
  return { language, segments };
}
