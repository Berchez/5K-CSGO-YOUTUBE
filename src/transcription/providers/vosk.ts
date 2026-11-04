/**
 * Vosk local (modelo pequeno de português): o mais rápido dos locais,
 * mas sem pontuação e com precisão baixa. Entra como opção barata para
 * rascunho — a legenda final deve sair de um Whisper.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asRecord, asText } from '../http.js';
import { groupWordsIntoSegments } from '../segments.js';
import { resolvePythonBin, resolveVoskModelDir, resolveWorkerScript } from '../audio.js';
import {
  readJsonFile,
  timedWordsFromRecords,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

const execFileAsync = promisify(execFile);

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const python = resolvePythonBin();
  if (!python) {
    throw new Error(
      'Python do Vosk não encontrado — crie o venv em .tools/py312 ou defina TRANSCRIPTION_PYTHON',
    );
  }
  const modelDir = resolveVoskModelDir(req.model);
  if (!fs.existsSync(modelDir)) {
    throw new Error(`modelo Vosk não encontrado: ${modelDir}`);
  }
  const script = resolveWorkerScript('transcribe-vosk.py');
  const outPath = `${req.wavPath}.vosk.json`;
  let raw: unknown;
  try {
    await execFileAsync(python, [script, req.wavPath, modelDir, outPath], {
      windowsHide: true,
      timeout: req.timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
    });
    raw = readJsonFile(outPath);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `vosk falhou: ${String(err.stderr || err.message || e).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(outPath, { force: true });
  }
  const record = asRecord(raw);
  const words = timedWordsFromRecords(
    Array.isArray(record.words) ? record.words.map((w) => asRecord(w)) : [],
  );
  return {
    language: asText(record.language).trim() || 'pt',
    segments: groupWordsIntoSegments(words),
  };
}
