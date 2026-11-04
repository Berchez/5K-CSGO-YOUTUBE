/**
 * Faster-Whisper local (ctranslate2, CPU int8) via venv .tools/py312.
 *
 * O worker Python devolve os segmentos prontos; aqui só rodamos o
 * processo, lemos o JSON e limpamos os temporários.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asRecord, asText } from '../http.js';
import { sanitizeSegments } from '../segments.js';
import { resolvePythonBin, resolveWorkerScript } from '../audio.js';
import { readJsonFile, type ProviderRequest, type ProviderTranscript } from './common.js';

const execFileAsync = promisify(execFile);

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const python = resolvePythonBin();
  if (!python) {
    throw new Error(
      'Python do faster-whisper não encontrado — crie o venv em .tools/py312 ou defina TRANSCRIPTION_PYTHON',
    );
  }
  const script = resolveWorkerScript('transcribe-faster-whisper.py');
  const outPath = `${req.wavPath}.faster-whisper.json`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HOME: path.resolve('.tools', 'hf-cache'),
  };
  let raw: unknown;
  try {
    await execFileAsync(
      python,
      [
        script,
        req.wavPath,
        req.model,
        req.language ?? 'auto',
        req.vad ? '1' : '0',
        outPath,
      ],
      {
        windowsHide: true,
        timeout: req.timeoutMs,
        maxBuffer: 1024 * 1024 * 32,
        env,
      },
    );
    raw = readJsonFile(outPath);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `faster-whisper falhou: ${String(err.stderr || err.message || e).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(outPath, { force: true });
  }
  const record = asRecord(raw);
  const segments = sanitizeSegments(
    (Array.isArray(record.segments) ? record.segments : []).map((item) => {
      const seg = asRecord(item);
      return { startSec: seg.start, endSec: seg.end, text: seg.text };
    }),
  );
  const language = asText(record.language).trim() || req.language;
  return { language, segments };
}
