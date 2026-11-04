import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';
import { resolveFfmpegBin } from './segmentProbe.js';
import { normalizeCaptionText, type CaptionLine } from './shortCaptions.js';

const execFileAsync = promisify(execFile);

export type CaptionProvider = 'gemini' | 'huggingface';

export interface CaptionAiOptions {
  /** Ordem dos providers (`gemini,huggingface`). */
  order?: string;
  timeoutMs?: number;
  geminiApiKey?: string;
  geminiModel?: string;
  hfToken?: string;
  hfModel?: string;
}

export interface ParsedTranscript {
  lines: CaptionLine[];
  language: string | null;
  /** A legenda saiu traduzida para português? */
  translated: boolean;
}

export interface CaptionTranscript extends ParsedTranscript {
  provider: CaptionProvider;
}

export type CaptionTranscriber = (
  audioPath: string,
  durSec: number,
) => Promise<CaptionTranscript | null>;

const DEFAULT_ORDER = 'gemini,huggingface';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_HF_MODEL = 'openai/whisper-large-v3-turbo';

/** Providers conhecidos, na ordem pedida (sem repetição). */
export function captionProviders(order: string | undefined): CaptionProvider[] {
  const raw = (order ?? DEFAULT_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: CaptionProvider[] = [];
  for (const p of raw) {
    if ((p === 'gemini' || p === 'huggingface') && !out.includes(p)) out.push(p);
  }
  return out.length > 0 ? out : ['gemini', 'huggingface'];
}

/**
 * Extrai o áudio da JANELA do Short (mono 16kHz) num WAV.
 *
 * O seek é do lado da SAÍDA (`-ss` depois do `-i`): o áudio sai
 * exatamente do início da janela, e a legenda depende disso (o tempo da
 * transcrição é relativo ao começo do Short).
 */
export async function extractAudioWindow(
  inPath: string,
  startSec: number,
  durSec: number,
  outPath: string,
): Promise<string> {
  const start = Math.max(0, Number(startSec) || 0);
  const dur = Math.max(1, Number(durSec) || 1);
  await execFileAsync(
    resolveFfmpegBin(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      '-y',
      '-i',
      inPath,
      '-ss',
      start.toFixed(2),
      '-t',
      dur.toFixed(2),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outPath,
    ],
    { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 * 16 },
  );
  return outPath;
}

/** Pedido da transcrição (o modelo devolve JSON com o tempo de cada fala). */
export function buildCaptionPrompt(durSec: number): string {
  return [
    'Você transcreve o áudio de um trecho de transmissão de CS2 (commentário de caster) para virar legenda queimada no vídeo.',
    '',
    'REGRAS:',
    `- O áudio tem ${Math.max(1, Math.round(durSec))} segundos. "start" e "end" são segundos DEPOIS do início do áudio (0 = o primeiro segundo).`,
    '- Uma entrada = UMA fala curta (uma frase). start < end, sem sobrepor com a fala anterior.',
    '- Escreva EXATAMENTE o que é falado: não resuma, não comente, não corrija o nome do jogador.',
    '- Máximo de 32 caracteres por fala (a legenda quebra em até 2 linhas).',
    '- "language" é o idioma falado ("en", "pt-BR"...).',
    '- Se o idioma NÃO for português, preencha também "text_pt" com a tradução para português do Brasil. Se for português, "text_pt" fica igual a "text".',
    '',
    'Responda APENAS com JSON válido:',
    '{"language":"en","lines":[{"start":1.20,"end":3.40,"text":"...","text_pt":"..."}]}',
  ].join('\n');
}

/**
 * Lê o JSON da transcrição. `text_pt` tem prioridade quando existe (a
 * legenda vai em português; o áudio pode ser inglês).
 */
export function parseGeminiTranscript(raw: string): ParsedTranscript | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { language?: unknown; lines?: unknown };
  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines: CaptionLine[] = [];
  let translated = false;
  for (const item of rawLines) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as {
      start?: unknown;
      end?: unknown;
      text?: unknown;
      text_pt?: unknown;
    };
    const original = typeof rec.text === 'string' ? rec.text.trim() : '';
    const pt = typeof rec.text_pt === 'string' ? rec.text_pt.trim() : '';
    const chosen = pt || original;
    if (!chosen) continue;
    if (pt && pt !== original) translated = true;
    const startSec = Number(rec.start);
    const endSec = Number(rec.end);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    const clean = normalizeCaptionText(chosen);
    if (!clean) continue;
    lines.push({ startSec, endSec, text: clean });
  }
  if (lines.length === 0) return null;
  const language = typeof obj.language === 'string' ? obj.language.trim() : '';
  return { lines, language: language || null, translated };
}

export interface CaptionChunk {
  text?: string;
  timestamp?: number[];
}

/**
 * Junta os pedaços do Whisper (palavra ou frase) em blocos de legenda:
 * junta enquanto o texto cabe, o bloco não passa do tempo e a pausa
 * entre as falas é pequena.
 */
export function groupCaptionChunks(
  chunks: CaptionChunk[],
  opts: { maxChars?: number; maxLineSec?: number; gapSec?: number } = {},
): CaptionLine[] {
  const maxChars = Math.max(8, opts.maxChars ?? 32);
  const maxLineSec = Math.max(1, opts.maxLineSec ?? 6);
  const gapSec = Math.max(0, opts.gapSec ?? 0.6);
  const out: CaptionLine[] = [];
  let text = '';
  let startSec: number | null = null;
  let endSec = 0;

  const flush = () => {
    const clean = normalizeCaptionText(text);
    if (clean && startSec != null) {
      out.push({ startSec, endSec, text: clean });
    }
    text = '';
    startSec = null;
    endSec = 0;
  };

  for (const chunk of chunks ?? []) {
    const piece = normalizeCaptionText(String(chunk?.text ?? ''));
    if (!piece) continue;
    const ts = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [];
    const chunkStart = Number(ts[0]);
    const chunkEnd = Number(ts[1]);
    if (!Number.isFinite(chunkStart)) continue;
    const end = Number.isFinite(chunkEnd) ? chunkEnd : chunkStart + 0.4;
    const candidate = text ? `${text} ${piece}` : piece;
    const tooLong = candidate.length > maxChars;
    const tooLate = startSec != null && end - startSec > maxLineSec;
    const tooFar = startSec != null && chunkStart - endSec > gapSec;
    if (startSec != null && (tooLong || tooLate || tooFar)) flush();
    if (startSec == null) startSec = chunkStart;
    text = text ? `${text} ${piece}` : piece;
    endSec = Math.max(endSec, end);
  }
  flush();
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${label} após ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Transcreve com o Gemini (áudio inline + JSON com os tempos). */
export async function transcribeWithGemini(
  audioPath: string,
  opts: { apiKey: string; model: string; timeoutMs: number; durSec: number },
): Promise<ParsedTranscript | null> {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const audio = fs.readFileSync(audioPath);
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const run = (async () => {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: [
        { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
        { text: buildCaptionPrompt(opts.durSec) },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            language: { type: Type.STRING },
            lines: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                  text_pt: { type: Type.STRING },
                },
                required: ['start', 'end', 'text'],
              },
            },
          },
          required: ['language', 'lines'],
        },
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    });
    return res.text ?? '';
  })();
  const raw = await withTimeout(run, opts.timeoutMs, 'gemini-transcricao');
  const parsed = parseGeminiTranscript(raw);
  if (!parsed) {
    // A resposta crua no log: sem ela, "transcrição vazia" não diz o que
    // o modelo devolveu (JSON inválido, texto puro, lista vazia...).
    const log = getLogger().child({ feature: 'short-captions' });
    log.warn({ raw: String(raw).slice(0, 500) }, 'resposta da transcrição sem JSON utilizável');
  }
  return parsed;
}

/** Transcreve com o Whisper do HuggingFace (timestamps por palavra). */
export async function transcribeWithHuggingface(
  audioPath: string,
  opts: { token: string; model: string; timeoutMs: number },
): Promise<ParsedTranscript | null> {
  const { InferenceClient } = await import('@huggingface/inference');
  const client = new InferenceClient(opts.token);
  const audio = fs.readFileSync(audioPath);
  const run = (async () => {
    const res = await client.automaticSpeechRecognition({
      data: new Blob([audio]),
      model: opts.model,
      parameters: { return_timestamps: true },
    });
    const chunks = (res as { chunks?: CaptionChunk[] }).chunks ?? [];
    return groupCaptionChunks(chunks);
  })();
  const lines = await withTimeout(run, opts.timeoutMs, 'huggingface-transcricao');
  if (lines.length === 0) return null;
  return { lines, language: null, translated: false };
}

/**
 * Transcriber com fallback: tenta os providers na ordem e devolve o
 * primeiro que responder. Sem legenda é melhor do que Short perdido.
 */
export function createCaptionTranscriber(opts: CaptionAiOptions = {}): CaptionTranscriber {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const geminiModel = opts.geminiModel || DEFAULT_GEMINI_MODEL;
  const hfModel = opts.hfModel || DEFAULT_HF_MODEL;
  const providers = captionProviders(opts.order);
  const log = getLogger().child({ feature: 'short-captions' });
  return async (audioPath: string, durSec: number): Promise<CaptionTranscript | null> => {
    for (const provider of providers) {
      const startedAt = Date.now();
      try {
        if (provider === 'gemini') {
          if (!opts.geminiApiKey) {
            log.info('gemini sem GEMINI_API_KEY — pulando');
            continue;
          }
          const parsed = await transcribeWithGemini(audioPath, {
            apiKey: opts.geminiApiKey,
            model: geminiModel,
            timeoutMs,
            durSec,
          });
          if (!parsed) {
            log.warn('gemini devolveu transcrição vazia');
            continue;
          }
          log.info(
            {
              provider,
              linhas: parsed.lines.length,
              idioma: parsed.language,
              traduzida: parsed.translated,
              duracaoMs: Date.now() - startedAt,
            },
            'legenda transcrita',
          );
          return { ...parsed, provider };
        }
        if (!opts.hfToken) {
          log.info('huggingface sem HF_TOKEN — pulando');
          continue;
        }
        const parsed = await transcribeWithHuggingface(audioPath, {
          token: opts.hfToken,
          model: hfModel,
          timeoutMs,
        });
        if (!parsed) {
          log.warn('huggingface devolveu transcrição vazia');
          continue;
        }
        log.info(
          {
            provider,
            linhas: parsed.lines.length,
            duracaoMs: Date.now() - startedAt,
          },
          'legenda transcrita',
        );
        return { ...parsed, provider };
      } catch (e) {
        log.warn(
          { provider, err: String(e).slice(0, 200) },
          'provider de transcrição falhou',
        );
      }
    }
    log.warn('nenhum provider de transcrição respondeu — o Short sai sem legenda');
    return null;
  };
}
