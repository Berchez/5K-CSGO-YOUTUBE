/**
 * whisper.cpp local (binário CPU em .tools/whisper.cpp).
 *
 * O `whisper-cli -oj` grava um JSON com offsets em ms; o VAD do Silero é
 * opcional e, quando ligado, pula silêncio — foi o que mais reduziu o
 * tempo no áudio de jogo (37,5s vs 53,6s no clip de teste).
 *
 * ATENÇÃO (legenda queimada): com `--vad` o whisper-cli emite os offsets
 * na linha do tempo COMPRIMIDA (sem os silêncios pulados). Num clipe de
 * 90s isso adianta as falas em segundos. Por isso o modo legenda pede
 * `words: true` SEM VAD e monta os blocos a partir dos tokens (`-ojf`).
 *
 * Endurecimento do modo legenda: `-sns` + `-nth 0.6` derrubam a fala
 * inventada no silêncio, o token com UTF-8 quebrado (o token cortou um
 * acento) é trocado pelo texto do segmento e a frase de despedida
 * clássica do Whisper ("obrigado por assistir") nunca vira legenda.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asNumber, asRecord, asText } from '../http.js';
import { groupWordsIntoSegments, sanitizeSegments } from '../segments.js';
import {
  resolveSileroVadModel,
  resolveWhisperCppBin,
  resolveWhisperCppModel,
} from '../audio.js';
import type { TimedWord } from '../types.js';
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

/**
 * Frases que o Whisper INVENTA no silêncio (sem VAD) ou no fim do áudio.
 *
 * Sem VAD o modelo "ouve" coisa onde não tem fala — e as frases clássicas
 * de hallucination são as mesmas em todo mundo. Elas não entram na
 * legenda: sairiam como fala do caster.
 */
const HALLUCINATION_PHRASES = [
  'obrigado por assistir',
  'thats all folks',
  "that's all folks",
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subscribe to my channel',
  'subtitles by',
  'amara.org',
  'www.youtube.com',
  'youtube.com',
] as const;

/**
 * Normaliza para comparar texto: minúsculas, sem pontuação, espaço
 * único. A MESMA normalização vale para a frase e para o texto falado —
 * sem isso, "amara.org" (frase) nunca casaria com "amara org" (texto).
 */
function normalizeSpeech(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_HALLUCINATIONS = HALLUCINATION_PHRASES.map(normalizeSpeech);

/**
 * A fala é uma alucinação conhecida do Whisper?
 *
 * O casamento é por FALA INTEIRA (ou pelo começo dela): uma frase real
 * que por acaso contenha "obrigado por assistir" no meio não pode
 * sumir da legenda. A exceção é a frase de despedida com umas palavras
 * a mais ("obrigado por assistir ao vídeo") — ela também é invenção.
 */
export function isLikelyHallucination(text: string): boolean {
  const raw = String(text ?? '').trim();
  // Marcador do Whisper (`[BLANK_AUDIO]`, `[SILENCE]`...) não é fala.
  if (/^\[[^\]]*\]$/.test(raw)) return true;
  const key = normalizeSpeech(raw);
  if (!key) return true;
  return NORMALIZED_HALLUCINATIONS.some((phrase) => {
    if (key === phrase) return true;
    // A frase INVENTADA começa com a frase conhecida ("obrigado por
    // assistir ao vídeo", "subtitles by the amara org community").
    if (key.startsWith(phrase)) return true;
    // No meio do texto, só quando o texto é basicamente a frase: uma
    // fala real que só CITA a expressão não pode sumir da legenda.
    return key.includes(phrase) && key.length <= phrase.length * 1.6;
  });
}

/**
 * Palavras de um texto com o tempo ESPALHADO dentro do intervalo.
 *
 * É o plano B quando o token do Whisper veio com UTF-8 quebrado (o
 * token pode cortar um acento no meio): o texto do segmento é válido e
 * vale mais que os tokens.
 */
export function wordsFromTextSpan(
  text: string,
  startSec: number,
  endSec: number,
): TimedWord[] {
  const parts = String(text ?? '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const start = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const end = Number.isFinite(endSec) && endSec > start ? endSec : start + 0.4;
  const span = end - start;
  const step = span / parts.length;
  return parts.map((part, i) => ({
    startSec: start + step * i,
    endSec: start + step * (i + 1),
    text: part,
  }));
}

/**
 * Junta os tokens do `-ojf` em PALAVRAS com tempo.
 *
 * Cada token carrega um pedaço da palavra (subword) e o espaço inicial
 * marca palavra nova; token de pontuação entra na palavra anterior.
 * Tokens especiais (`[_BEG_]`, `[_TT_123]`...) não são fala.
 *
 * `U+FFFD` no texto do token = UTF-8 quebrado (o token cortou um
 * acento): esse token é descartado aqui — quem chama (o modo legenda)
 * refaz o SEGMENTO inteiro pelo texto do segmento, que é válido.
 */
export function wordsFromWhisperTokens(tokens: unknown[]): TimedWord[] {
  const out: TimedWord[] = [];
  let current: TimedWord | null = null;
  for (const raw of tokens ?? []) {
    const token = asRecord(raw);
    const text = asText(token.text);
    const offsets = asRecord(token.offsets);
    let start = asNumber(offsets.from) / 1000;
    let end = asNumber(offsets.to) / 1000;
    if (!text || /^\s*\[[^\]]*\]\s*$/.test(text)) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      const stamps = asRecord(token.timestamps);
      start = clockToSec(asText(stamps.from));
      end = clockToSec(asText(stamps.to));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const piece = text.trim();
    if (!piece) continue;
    if (piece.includes('\uFFFD')) continue;
    if (!current || /^\s/.test(text)) {
      if (current) out.push(current);
      current = { startSec: Math.max(0, start), endSec: Math.max(0, end), text: piece };
    } else {
      current.text += piece;
      current.endSec = Math.max(current.endSec, end);
    }
  }
  if (current) out.push(current);
  return out;
}

export interface WhisperJsonOptions {
  /** Modo legenda: as palavras vêm dos tokens (`-ojf`). */
  words?: boolean;
  /** Idioma pedido (quando o binário não devolve nenhum). */
  language?: string | null;
  /** Máximo de caracteres por bloco de legenda. */
  maxSegmentChars?: number;
}

/**
 * Lê o JSON do `whisper-cli` e devolve as falas.
 *
 * É a parte PURA do provider (o binário é chamado fora daqui): dá para
 * testar o modo legenda com o JSON do `-ojf` sem rodar o whisper.
 *
 * No modo legenda o filtro de alucinação vale para TODOS os caminhos:
 * quando TODOS os segmentos são invenção, o resultado é SILÊNCIO
 * (nenhuma fala) — nunca a frase inventada, que entraria na legenda.
 */
export function parseWhisperJson(
  raw: unknown,
  opts: WhisperJsonOptions = {},
): ProviderTranscript {
  const record = asRecord(raw);
  const items = Array.isArray(record.transcription) ? record.transcription : [];
  const result = asRecord(record.result);
  const language = asText(result.language).trim() || opts.language || null;
  if (opts.words) {
    // Cada segmento vira palavras: o texto vem dos TOKENS (tempo real
    // de cada palavra) e, se ALGUM token do segmento veio com UTF-8
    // quebrado (o token cortou um acento no meio), do TEXTO do segmento
    // (que é válido) espalhado no tempo do segmento. O fallback é por
    // SEGMENTO: usar só os tokens bons deixaria a palavra truncada.
    const words: TimedWord[] = [];
    for (const item of items) {
      const entry = asRecord(item);
      const offsets = asRecord(entry.offsets);
      const stamps = asRecord(entry.timestamps);
      const segStart = Number.isFinite(asNumber(offsets.from))
        ? asNumber(offsets.from) / 1000
        : clockToSec(asText(stamps.from));
      const segEnd = Number.isFinite(asNumber(offsets.to))
        ? asNumber(offsets.to) / 1000
        : clockToSec(asText(stamps.to));
      const segText = asText(entry.text).trim();
      // Fala inventada no silêncio: fora da legenda (ela não é do
      // caster). Só no modo legenda — no CLI de transcrição a frase
      // pode ser real ("thanks for watching" no fim de um vídeo).
      if (isLikelyHallucination(segText)) continue;
      const tokens = Array.isArray(entry.tokens) ? entry.tokens : [];
      const broken = tokens.some((token) =>
        asText(asRecord(token).text).includes('\uFFFD'),
      );
      const fromTokens = broken ? [] : wordsFromWhisperTokens(tokens);
      if (fromTokens.length > 0) {
        words.push(...fromTokens);
        continue;
      }
      if (!segText) continue;
      words.push(...wordsFromTextSpan(segText, segStart, segEnd));
    }
    const segments = groupWordsIntoSegments(words, {
      maxChars: opts.maxSegmentChars ?? 32,
    }).filter((seg) => !isLikelyHallucination(seg.text));
    // Tudo era alucinação: o resultado é SILÊNCIO. Antes caía no
    // caminho genérico (que não filtra) e a frase inventada entrava
    // na legenda — exatamente o que o filtro existe para impedir.
    return { language, segments };
  }
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
  return { language, segments };
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
  const wantWords = req.words === true;
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
    wantWords ? '-ojf' : '-oj',
    '-of',
    outBase,
  ];
  if (wantWords) {
    // Blocos curtos, cortados na fronteira da palavra: o texto não
    // estoura a legenda e o `-ojf` continua dando o tempo de cada token.
    args.push('-ml', String(Math.max(16, req.maxSegmentChars ?? 32)), '-sow');
    // Sem VAD o Whisper alucina no silêncio: `-sns` descarta os tokens
    // que não são fala. O `-nth` fica explícito (0.60 é o default do
    // binário) para o limiar não mudar sozinho numa atualização.
    args.push('-sns', '-nth', '0.6');
  }
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
  return parseWhisperJson(raw, {
    words: wantWords,
    language: req.language,
    maxSegmentChars: req.maxSegmentChars,
  });
}
