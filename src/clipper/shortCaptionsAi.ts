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
  /**
   * Transcritores injetados (testes). Sem isto, cada provider é chamado
   * direto e a matriz silêncio/falha/sem-chave não é testável.
   */
  transcribers?: Partial<Record<CaptionProvider, CaptionProviderFn>>;
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

/** Transcritor de um provider (sem o campo `provider` — quem chama põe). */
export type CaptionProviderFn = (
  audioPath: string,
  durSec: number,
) => Promise<ParsedTranscript | null>;

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
 * Lê o JSON cru da transcrição (aceita cercas ```json e texto em volta).
 * Devolve `null` quando não é JSON.
 */
function parseTranscriptJson(raw: string): Record<string, unknown> | null {
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
  return parsed as Record<string, unknown>;
}

/**
 * Linhas USÁVEIS de um JSON de transcrição: só entram as que têm tempo
 * finito e texto com conteúdo. `text_pt` tem prioridade (a legenda vai em
 * português; o áudio pode ser inglês).
 *
 * Esta é a ÚNICA definição de "linha aproveitável" — a classificação e o
 * parse usam a mesma, senão uma transcrição com tempo inválido era
 * "silêncio" (estado final) num lugar e "ok" no outro.
 */
export function usableTranscriptLines(obj: Record<string, unknown>): {
  lines: CaptionLine[];
  language: string | null;
  translated: boolean;
} {
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
  const language = typeof obj.language === 'string' ? obj.language.trim() : '';
  return { lines, language: language || null, translated };
}

/**
 * Lê o JSON da transcrição. `text_pt` tem prioridade quando existe (a
 * legenda vai em português; o áudio pode ser inglês).
 */
export function parseGeminiTranscript(raw: string): ParsedTranscript | null {
  const obj = parseTranscriptJson(raw);
  if (!obj) return null;
  const { lines, language, translated } = usableTranscriptLines(obj);
  if (lines.length === 0) return null;
  return { lines, language, translated };
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
        // O thinking do modelo "flash-preview" consome o teto de tokens e
        // corta o JSON no meio (resposta invalida = legenda perdida).
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 16384,
      },
    });
    const finish = res.candidates?.[0]?.finishReason;
    if (finish && /MAX_TOKENS/i.test(String(finish))) {
      throw new Error(`resposta truncada (finishReason=${String(finish)})`);
    }
    return res.text ?? '';
  })();
  const raw = await withTimeout(run, opts.timeoutMs, 'gemini-transcricao');
  const parsed = parseGeminiTranscript(raw);
  if (!parsed) {
    // A resposta crua no log: sem ela, "transcrição vazia" não diz o que
    // o modelo devolveu (JSON inválido, texto puro, lista vazia...).
    const log = getLogger().child({ feature: 'short-captions' });
    log.warn({ raw: String(raw).slice(0, 500) }, 'resposta da transcrição sem JSON utilizável');
    // JSON cortado no meio = FALHA (não silêncio): a resposta chegou
    // truncada e a legenda se perdeu. Silêncio de verdade é `lines: []`.
    if (looksTruncatedJson(raw)) {
      throw new Error('resposta da transcrição truncada (JSON incompleto)');
    }
    // JSON inválido (texto puro, chave faltando, sintaxe quebrada) também
    // é FALHA: era o que a transcrição devolveu, não silêncio. Sem esta
    // distinção o Short saía sem legenda e nunca mais era refeito.
    if (classifyTranscriptResponse(raw) === 'invalid') {
      throw new Error('resposta da transcrição com JSON inválido');
    }
  }
  return parsed;
}

/** A resposta parece JSON cortado no meio (falha), não um JSON válido. */
export function looksTruncatedJson(raw: string): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  if (!text.includes('{')) return false;
  return !text.endsWith('}') && !text.endsWith('}]');
}

/**
 * Como a resposta crua da transcrição se classifica.
 *
 * - `ok`: JSON válido com linhas;
 * - `silence`: JSON válido SEM fala (`lines: []`) — estado final, não é
 *   falha (repetir a transcrição não muda nada);
 * - `invalid`: não é JSON (texto puro, JSON cortado, JSON quebrado) — é
 *   FALHA: a legenda se perdeu e a próxima rodada tem que tentar de novo.
 *
 * Sem essa distinção, um JSON inválido que acabasse em `}` era tratado
 * como "ninguém falou" e o Short saía sem legenda para sempre.
 */
export function classifyTranscriptResponse(raw: string): 'ok' | 'silence' | 'invalid' {
  const text = String(raw ?? '').trim();
  if (!text) return 'silence';
  const obj = parseTranscriptJson(raw);
  if (!obj) return 'invalid';
  const rawLines = obj.lines;
  if (!Array.isArray(rawLines)) return 'silence';
  if (rawLines.length === 0) return 'silence';
  // Havia linhas, mas NENHUMA é aproveitável (tempo inválido, texto
  // vazio): a transcrição existiu e se perdeu — é FALHA (retry), não
  // silêncio (estado final).
  const { lines } = usableTranscriptLines(obj);
  return lines.length > 0 ? 'ok' : 'invalid';
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
 *
 * Regras de estado (o que decide se o Short é segurado ou publicado):
 *
 * - provider RESPONDEU "silêncio" → estado FINAL: o Short sai sem
 *   legenda (repetir não muda nada);
 * - provider FALHOU (timeout, chave inválida, JSON truncado) → dá para
 *   tentar de novo: o Short fica marcado para a próxima rodada;
 * - provider sem credencial configurada → nem é resposta nem falha: ele
 *   simplesmente não existe nesta máquina. Antes isso contava como
 *   falha e segurava o Short para sempre (com o Gemini respondendo
 *   "silêncio" e o HuggingFace sem token, o Short NUNCA publicava).
 */
export function createCaptionTranscriber(opts: CaptionAiOptions = {}): CaptionTranscriber {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const geminiModel = opts.geminiModel || DEFAULT_GEMINI_MODEL;
  const hfModel = opts.hfModel || DEFAULT_HF_MODEL;
  const providers = captionProviders(opts.order);
  const log = getLogger().child({ feature: 'short-captions' });
  return async (audioPath: string, durSec: number): Promise<CaptionTranscript | null> => {
    let sawFailure = false;
    let lastError = '';
    let sawSilence = false;
    let lastUnavailable = '';
    for (const provider of providers) {
      const startedAt = Date.now();
      try {
        if (provider === 'gemini') {
          if (!opts.geminiApiKey && !opts.transcribers?.gemini) {
            log.info('gemini sem GEMINI_API_KEY — pulando');
            lastUnavailable = 'gemini sem GEMINI_API_KEY';
            continue;
          }
          const parsed = opts.transcribers?.gemini
            ? await opts.transcribers.gemini(audioPath, durSec)
            : await transcribeWithGemini(audioPath, {
                apiKey: opts.geminiApiKey as string,
                model: geminiModel,
                timeoutMs,
                durSec,
              });
          if (!parsed) {
            log.warn('gemini devolveu transcrição vazia');
            sawSilence = true;
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
        if (!opts.hfToken && !opts.transcribers?.huggingface) {
          log.info('huggingface sem HF_TOKEN — pulando');
          lastUnavailable = 'huggingface sem HF_TOKEN';
          continue;
        }
        const parsed = opts.transcribers?.huggingface
          ? await opts.transcribers.huggingface(audioPath, durSec)
          : await transcribeWithHuggingface(audioPath, {
              token: opts.hfToken as string,
              model: hfModel,
              timeoutMs,
            });
        if (!parsed) {
          log.warn('huggingface devolveu transcrição vazia');
          sawSilence = true;
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
        sawFailure = true;
        lastError = String(e).slice(0, 200);
        log.warn(
          { provider, err: lastError },
          'provider de transcrição falhou',
        );
      }
    }
    if (sawFailure) {
      // Falha de verdade (cota/chave/timeout/truncagem): o Short fica
      // marcado para nova tentativa na próxima rodada.
      throw new Error(`nenhum provider de transcrição respondeu: ${lastError || 'erro'}`);
    }
    if (sawSilence) {
      // Alguém respondeu e disse que ninguém falou: estado final.
      log.warn('nenhum provider achou fala — o Short sai sem legenda');
      return null;
    }
    // Nenhum provider respondeu e nenhum falhou: nenhum está configurado.
    throw new Error(
      `nenhum provider de transcrição configurado (${lastUnavailable || 'sem chave'})`,
    );
  };
}
