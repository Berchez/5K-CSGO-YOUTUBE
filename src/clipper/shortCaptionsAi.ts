import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';
import { repoPath } from '../paths.js';
import { transcribeWav } from '../transcription/transcribe.js';
import { wavDurationSecFromBytes } from '../transcription/audio.js';
import { resolveFfmpegBin } from './segmentProbe.js';
import {
  normalizeCaptionText,
  type CaptionLine,
  type CaptionTranscriptCache,
} from './shortCaptions.js';

const execFileAsync = promisify(execFile);

export type CaptionProvider = 'gemini' | 'huggingface' | 'whisper-cpp';

/**
 * Contexto do clipe para a transcrição.
 *
 * Sem ele o modelo "corrige" o que ouviu: o caster falando "molodoy"
 * virava "molodoij"/"molodói", "equinho" (eco) virava "é quinho" e
 * "kills" virava "quilos". Com os nomes e o gíria na mão, o modelo
 * escreve a grafia certa.
 */
export interface CaptionContext {
  /** Jogador do ace (o nome que mais aparece no áudio). */
  player?: string | null;
  /** Time 1 do confronto. */
  team1?: string | null;
  /** Time 2 do confronto. */
  team2?: string | null;
  /** Outros jogadores citados (vítimas, por exemplo). */
  players?: string[];
  /** Evento (o caster costuma falar o nome do evento). */
  event?: string | null;
  /** Mapa. */
  map?: string | null;
  /** Round. */
  round?: number | null;
}

/**
 * Gíria de CS2 que o caster usa: o modelo traduz ("kills" → "quilos",
 * "eco" → "econômico") quando não sabe que são termos do jogo.
 */
export const CS_CAPTION_GLOSSARY = [
  'kills',
  'ace',
  'clutch',
  'HS',
  'eco',
  'equinho',
  'molotov',
  'incendiária',
  'flash',
  'smoke',
  'save',
  'lurk',
  'rotate',
  'defusa',
  'plant',
  'push',
  'rush',
  'trade',
  'wallbang',
  'one-tap',
  'spray',
  'site',
  'DMzinho',
  'only pistol',
] as const;

/** Nomes + gíria que o modelo deve respeitar (sem repetição). */
export function captionVocabulary(context?: CaptionContext | null): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = String(value ?? '').trim();
    if (!text || out.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  push(context?.player);
  push(context?.team1);
  push(context?.team2);
  for (const player of context?.players ?? []) push(player);
  for (const word of CS_CAPTION_GLOSSARY) push(word);
  return out;
}

/**
 * Só os NOMES do clipe (sem a gíria): é o que decide se uma regra de
 * correção contextual (`@ctx`) vale neste clipe.
 */
export function captionContextNames(context?: CaptionContext | null): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = String(value ?? '').trim();
    if (!text || out.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  push(context?.player);
  push(context?.team1);
  push(context?.team2);
  for (const player of context?.players ?? []) push(player);
  return out;
}

/**
 * Vocabulário global do repo (`assets/caption-vocabulary.txt`).
 *
 * O contexto do clipe só conhece os nomes DAQUELE clipe: o caster cita
 * jogador de outro time, de outra partida. O arquivo global junta a
 * grafia oficial de todos — é o que o dono corrige uma vez e vale para
 * todo Short seguinte.
 */
export function loadCaptionVocabulary(file?: string): string[] {
  const path = file ?? repoPath('assets', 'caption-vocabulary.txt');
  try {
    return fs
      .readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Uma correção de texto (o que o modelo erra → a forma certa). */
export interface CaptionCorrection {
  wrong: string;
  right: string;
  /**
   * A regra só vale quando o lado DIREITO está no contexto do clipe
   * (jogador/times citados): `lex>Legacy @ctx`.
   *
   * Sem isso, uma palavra comum que também é apelido de jogador
   * ("twist", "yuri", "robô") viraria nome em toda legenda do canal.
   */
  contextual?: boolean;
}

/**
 * Correções globais (`assets/caption-corrections.txt`): `ERRADO>CERTO`.
 *
 * O prompt segura a maior parte, mas alguns erros são acústicos (o
 * caster fala "molodói" e o modelo escreve "molodói" com toda a
 * confiança). A correção de texto pega esses casos.
 */
export function parseCaptionCorrections(text: string): CaptionCorrection[] {
  const out: CaptionCorrection[] = [];
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const contextual = /@\s*ctx\s*$/i.test(trimmed);
    const body = contextual
      ? trimmed.replace(/@\s*ctx\s*$/i, '').trim()
      : trimmed;
    const at = body.indexOf('>');
    if (at <= 0) continue;
    const wrong = body.slice(0, at).trim();
    const right = body.slice(at + 1).trim();
    if (!wrong || !right) continue;
    out.push({ wrong, right, ...(contextual ? { contextual: true } : {}) });
  }
  return out;
}

/** Correções globais do repo (arquivo + padrão). */
export function loadCaptionCorrections(file?: string): CaptionCorrection[] {
  const path = file ?? repoPath('assets', 'caption-corrections.txt');
  try {
    return parseCaptionCorrections(fs.readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Uma palavra com o tempo (o modelo dedicado dá o tempo por palavra). */
export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
}

/** Compara duas palavras ignorando caixa e pontuação. */
function sameWord(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return norm(a) === norm(b);
}

/**
 * Troca o texto das palavras pelo texto de REFERÊNCIA (que tem a
 * grafia certa) e mantém os tempos.
 *
 * A transcrição com timestamps e a transcrição com `custom_vocabulary`
 * são a MESMA fala: o que muda é a grafia das palavras que o ASR errou
 * ("Molodói" → "Molodoy"). O alinhamento é por token: quando a
 * quantidade bate, é 1:1; quando não bate, o LCS casa o que é igual
 * (as âncoras) e os trechos sem âncora são distribuídos por
 * proportionally entre as palavras do mesmo trecho.
 */
export function alignReferenceWords(
  words: CaptionWord[],
  referenceText: string,
): CaptionWord[] {
  const reference = String(referenceText ?? '').split(/\s+/).filter(Boolean);
  if (!reference.length || !words.length) return words ?? [];

  if (reference.length === words.length) {
    return words.map((word, i) => ({ ...word, text: reference[i] }));
  }

  // LCS: casa os tokens iguais (ignorando caixa/pontuação).
  const n = reference.length;
  const m = words.length;
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sameWord(reference[i], words[j].text)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Âncoras: token da referência → índice da palavra com tempo.
  const anchors: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameWord(reference[i], words[j].text)) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const out: CaptionWord[] = new Array(n);
  // Trechos entre âncoras: as palavras sem par são divididas entre os
  // tokens sem âncora, proporcionalmente.
  let refStart = 0;
  let wordStart = 0;
  for (const [refAnchor, wordAnchor] of [...anchors, [n, m] as [number, number]]) {
    const refCount = refAnchor - refStart;
    const wordCount = wordAnchor - wordStart;
    for (let k = 0; k < refCount; k++) {
      const from = wordStart + Math.floor((k * wordCount) / refCount);
      const to = wordStart + Math.floor(((k + 1) * wordCount) / refCount);
      const first = words[Math.min(from, m - 1)];
      const last = words[Math.min(Math.max(to - 1, from), m - 1)];
      out[refStart + k] = {
        text: reference[refStart + k],
        startSec: first.startSec,
        endSec: Math.max(first.startSec + 0.05, last.endSec),
      };
    }
    if (refAnchor < n) {
      const anchor = words[wordAnchor];
      out[refAnchor] = { ...anchor, text: reference[refAnchor] };
    }
    refStart = refAnchor + 1;
    wordStart = wordAnchor + 1;
  }
  return out;
}

/**
 * Os nomes do próprio clipe (jogador, times) entram no vocabulário do
 * modelo: é o que faz o ASR escrever "Molodoy" e não "Molodói".
 *
 * (O `captionContextNames` é a MESMA lista sem a gíria — é o que decide
 * se uma regra de correção contextual (`@ctx`) vale neste clipe.)
 */

/**
 * O erro é de COTA do Gemini (429 / "quota")?
 *
 * Quando é, o modelo dedicado de transcrição ainda funciona (é outra
 * métrica de quota) — então a legenda não se perde.
 */
export function isQuotaError(err: unknown): boolean {
  const obj = (err ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  // O status vem no erro do SDK (429 = cota); a mensagem é o plano B.
  const status = Number(obj.status ?? obj.code);
  if (Number.isFinite(status) && status === 429) return true;
  const msg = String(obj.message ?? err ?? '').toLowerCase();
  if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted')) {
    return true;
  }
  return /\b429\b/.test(msg);
}

/**
 * O erro do Gemini é TRANSITÓRIO (vale repetir a chamada)?
 *
 * Repetem só: 5xx, `UNAVAILABLE` e "high demand" — o modelo estava
 * sobrecarregado e a próxima chamada costuma passar.
 *
 * NÃO repetem:
 * - 429/cota (`quota`, `rate limit`, `resource_exhausted`): a cota do
 *   dia acabou — repetir só gasta tempo; o modelo DEDICADO assume;
 * - erro de conteúdo (JSON inválido, resposta truncada): repetir dá o
 *   mesmo resultado (é um problema do prompt, não da rede);
 * - timeout: pode ser a chamada presa; a política é do chamador.
 */
export function isTransientGeminiError(err: unknown): boolean {
  // A cota vence SEMPRE: um 429 nunca vira retry.
  if (isQuotaError(err)) return false;
  const obj = (err ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = Number(obj.status ?? obj.code);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  const msg = String(obj.message ?? err ?? '').toLowerCase();
  if (msg.includes('unavailable') || msg.includes('high demand')) return true;
  if (msg.includes('overloaded') || msg.includes('try again later')) return true;
  if (/\b(500|502|503|504)\b/.test(msg)) return true;
  return false;
}

export interface GeminiRetryOptions {
  /**
   * Quantas TENTATIVAS no total (1 = sem retry). O default (3) são três
   * chamadas: a original + duas repetições.
   */
  attempts?: number;
  /** Espera base entre as tentativas (ms; dobra a cada repetição). */
  retryDelayMs?: number;
  /** Injetável (testes): a espera entre as tentativas. */
  sleep?: (ms: number) => Promise<void>;
  /** Rótulo para o log ("gemini-transcricao", ...). */
  label?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Repete uma chamada do Gemini quando ela falhou por erro TRANSITÓRIO.
 *
 * A espera dobra a cada repetição (2s → 4s): o modelo sobrecarregado
 * precisa de um respiro. Erro final (cota, conteúdo) sobe na hora.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  opts: GeminiRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseDelay = Math.max(0, Math.floor(opts.retryDelayMs ?? 2000));
  const sleep = opts.sleep ?? defaultSleep;
  const label = opts.label ?? 'gemini';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientGeminiError(err)) throw err;
      const delay = baseDelay * 2 ** (attempt - 1);
      getLogger()
        .child({ feature: 'short-captions' })
        .warn(
          { label, attempt, attempts, delayMs: delay, err: String(err).slice(0, 200) },
          'chamada do Gemini falhou com erro transitório — repetindo',
        );
      if (delay > 0) await sleep(delay);
    }
  }
  throw new Error(`${label}: o retry do Gemini terminou sem resultado`);
}

/**
 * Modelo dedicado de transcrição do Gemini (a Interactions API).
 *
 * Ele é melhor que o modelo de texto em duas coisas: **tempo por
 * palavra** e **`custom_vocabulary`** (a lista de nomes/gíria que o
 * dono corrigiu). Mas a API recusa vocabulário junto com timestamps
 * (`custom_vocabulary is incompatible with timestamps`) — por isso são
 * DUAS chamadas: uma com tempo (para saber quando cada palavra foi
 * falada) e outra com vocabulário (para saber como cada palavra foi
 * falada). O alinhamento junta as duas.
 *
 * Efeito colateral bom: este caminho não conta na cota diária de 20
 * `generate_content` do free tier (é outra métrica de quota).
 */
export const CAPTION_DEDICATED_MODEL = 'gemini-3.5-transcribe';

interface DedicatedResponse {
  steps?: Array<{ content?: Array<{ type?: string; text?: string; annotations?: unknown[] }> }>;
  output_text?: string;
}

/** Palavras com tempo de uma resposta da Interactions API. */
export function wordsFromDedicatedResponse(res: unknown): CaptionWord[] {
  const steps = (res as DedicatedResponse)?.steps ?? [];
  const words: CaptionWord[] = [];
  for (const step of steps) {
    for (const part of step.content ?? []) {
      if (part.type !== 'text') continue;
      for (const raw of part.annotations ?? []) {
        const ann = raw as {
          type?: string;
          text?: string;
          start_offset?: string;
          end_offset?: string;
        };
        if (ann.type !== 'word_info' || !ann.text) continue;
        const start = offsetSeconds(ann.start_offset);
        const end = offsetSeconds(ann.end_offset);
        if (!Number.isFinite(start)) continue;
        words.push({
          text: ann.text.trim(),
          startSec: start,
          endSec: Number.isFinite(end) ? end : start + 0.1,
        });
      }
    }
  }
  return words;
}

/** `"0.100s"` → 0.1 (o offset da Interactions API). */
export function offsetSeconds(offset: string | undefined): number {
  const m = String(offset ?? '').match(/([\d.]+)\s*s/);
  return m ? Number(m[1]) : NaN;
}

/**
 * O texto de uma resposta da Interactions API (sem os tempos).
 *
 * Serve para distinguir "ninguém falou" (sem texto) de "falou, mas sem
 * tempo por palavra" (com texto): o segundo caso é FALHA (o modelo
 * mudou de shape) e não silêncio.
 */
export function dedicatedResponseText(res: unknown): string {
  const r = (res as DedicatedResponse) ?? {};
  const direct = String(r.output_text ?? '').trim();
  if (direct) return direct;
  const parts: string[] = [];
  for (const step of r.steps ?? []) {
    for (const part of step.content ?? []) {
      if (part.type === 'text' && part.text) parts.push(String(part.text));
    }
  }
  return parts.join(' ').trim();
}

/** Idioma que a API Dedicated devolveu (se devolveu). */
export function dedicatedResponseLanguage(res: unknown): string | null {
  const lang = (res as { language?: unknown })?.language;
  const text = String(lang ?? '').trim();
  return text || null;
}

/**
 * Transcreve com o modelo dedicado (tempo por palavra + vocabulário).
 *
 * Devolve as falas já agrupadas (mesmo formato do resto da legenda).
 */
export async function transcribeWithGeminiDedicated(
  audioPath: string,
  opts: {
    apiKey: string;
    model?: string;
    timeoutMs: number;
    durSec: number;
    /** Vocabulário (nomes + gíria) que o modelo deve respeitar. */
    vocabulary?: string[];
    /** Contexto do clipe: os nomes que aparecem nele entram no vocabulário. */
    context?: CaptionContext | null;
    maxCharsPerLine?: number;
  },
): Promise<ParsedTranscript | null> {
  const { GoogleGenAI } = await import('@google/genai');
  const model = opts.model || CAPTION_DEDICATED_MODEL;
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const audio = fs.readFileSync(audioPath);
  const base64 = audio.toString('base64');

  // 1ª passada: o TEMPO de cada palavra.
  const timed = await withTimeout(
    ai.interactions.create({
      model,
      input: [{ type: 'audio', data: base64, mime_type: 'audio/wav' }],
      generation_config: {
        transcription_config: {
          mode: { type: 'verbatim', timestamp_granularities: ['word'] },
        },
      },
    }),
    opts.timeoutMs,
    'gemini-transcricao-dedicada',
  );
  const words = wordsFromDedicatedResponse(timed);
  if (words.length === 0) {
    // Texto sem tempo por palavra = o modelo mudou de shape: é FALHA
    // (a próxima rodada tenta de novo), não silêncio. Sem texto nenhum
    // é silêncio de verdade (estado final).
    const spoken = dedicatedResponseText(timed);
    if (spoken) {
      throw new Error(
        'modelo dedicado devolveu texto sem tempo por palavra (falha, não silêncio)',
      );
    }
    return null;
  }

  // 2ª passada: o TEXTO com o vocabulário (sem tempo — a API não aceita
  // os dois juntos).
  let reference = '';
  /**
   * O `custom_vocabulary` do modelo dedicado é do tamanho do QUE FALA
   * NESTE CLIPE (os nomes citados + a gíria). Mandar o arquivo global
   * inteiro (~170 termos) é pedir para o modelo recusar a lista — e
   * ainda força nome de jogador que não está no áudio.
   */
  const baseVocabulary = opts.context
    ? captionContextNames(opts.context)
    : (opts.vocabulary ?? []).slice(0, 60);
  const vocabulary = [
    ...new Set([...baseVocabulary, ...CS_CAPTION_GLOSSARY].filter(Boolean)),
  ].slice(0, 60);
  if (vocabulary.length) {
    try {
      const withVocab = await withTimeout(
        ai.interactions.create({
          model,
          input: [{ type: 'audio', data: base64, mime_type: 'audio/wav' }],
          generation_config: {
            transcription_config: {
              mode: { type: 'verbatim' },
              custom_vocabulary: vocabulary,
            },
          },
        }),
        opts.timeoutMs,
        'gemini-transcricao-vocabulario',
      );
      reference = dedicatedResponseText(withVocab);
    } catch (e) {
      // Sem o vocabulário ainda dá a legenda (só com a grafia errada).
      getLogger()
        .child({ feature: 'short-captions' })
        .warn(
          { err: String((e as { message?: string })?.message ?? e).slice(0, 160) },
          'vocabulário recusado pelo modelo dedicado — usando a transcrição sem ele',
        );
    }
  }

  const aligned = reference ? alignReferenceWords(words, reference) : words;
  const chunks = aligned.map((word) => ({
    text: word.text,
    timestamp: [word.startSec, word.endSec],
  }));
  const lines = groupCaptionChunks(chunks, {
    maxChars: opts.maxCharsPerLine ?? 32,
  });
  if (lines.length === 0) return null;
  return {
    lines,
    language: dedicatedResponseLanguage(timed),
    translated: false,
  };
}

/**
 * Aplica as correções nas falas (troca ignorando maiúsculas).
 *
 * A troca é literal E por palavra inteira: trocar "quilos" por "kills"
 * não pode virar "killso" dentro de "quiloso".
 *
 * `opts.contextNames` são os nomes do clipe (jogador/times): uma regra
 * marcada como `@ctx` só entra quando o nome CERTO está nessa lista —
 * sem isso, "twist" viraria "Twistzz" em qualquer legenda do canal.
 *
 * `opts.applied` recebe as regras que dispararam (o dono vê no marker
 * qual regra mexeu na legenda — é como se caça falso positivo).
 */
export function applyCaptionCorrections(
  lines: CaptionLine[],
  corrections: CaptionCorrection[],
  opts: { contextNames?: string[]; applied?: string[] } = {},
): CaptionLine[] {
  if (!corrections.length) return lines ?? [];
  const context = new Set(
    (opts.contextNames ?? []).map((name) =>
      String(name ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ''),
    ),
  );
  // As regex são compiladas UMA vez (a regra é a mesma para todas as
  // falas): compilar dentro do laço fazia o trabalho ×linhas×regras.
  const rules = corrections
    .filter((rule) => rule.wrong && rule.right)
    .filter(
      (rule) =>
        !rule.contextual ||
        context.has(
          rule.right
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ''),
        ),
    )
    .map((rule) => {
      const escaped = rule.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        right: rule.right,
        wrong: rule.wrong,
        re: new RegExp(
          `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
          'giu',
        ),
      };
    });
  if (!rules.length) return lines ?? [];
  const fired = new Set<string>();
  const out = (lines ?? []).map((line) => {
    let text = line.text;
    for (const rule of rules) {
      const next = text.replace(rule.re, rule.right);
      if (next === text) continue;
      text = next;
      fired.add(`${rule.wrong}>${rule.right}`);
    }
    return { ...line, text };
  });
  if (opts.applied) {
    for (const rule of fired) {
      if (!opts.applied.includes(rule)) opts.applied.push(rule);
    }
  }
  return out;
}

/**
 * Contexto a partir do sidecar/ace do clipe.
 *
 * O script tem o sidecar (o ace gravado): dele saem o jogador do ace, os
 * times e os jogadores citados na janela.
 */
export function captionContextFromAce(ace: {
  player?: string | null;
  team1?: string | null;
  team2?: string | null;
  event?: string | null;
  map?: string | null;
  round?: number | null;
  kills?: Array<{ killer?: string | null; victim?: string | null }>;
}): CaptionContext {
  const players: string[] = [];
  for (const kill of ace.kills ?? []) {
    for (const name of [kill.killer, kill.victim]) {
      const text = String(name ?? '').trim();
      if (text && !players.some((p) => p.toLowerCase() === text.toLowerCase())) {
        players.push(text);
      }
    }
  }
  return {
    player: ace.player ?? null,
    team1: ace.team1 ?? null,
    team2: ace.team2 ?? null,
    players,
    event: ace.event ?? null,
    map: ace.map ?? null,
    round: ace.round ?? null,
  };
}

/** Opções das chamadas de revisão/tradução (mesmo modelo de texto). */
export interface CaptionLineFixOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  context?: CaptionContext | null;
  vocabulary?: string[];
  /** Tentativas no total da chamada (erro transitório repete). */
  attempts?: number;
  /** Espera base entre as tentativas (ms). */
  retryDelayMs?: number;
}

/** Revisor injetável (testes): devolve as falas corrigidas ou null. */
export type CaptionRefinerFn = (
  lines: CaptionLine[],
  context?: CaptionContext | null,
) => Promise<CaptionLine[] | null>;

/**
 * Tradutor injetável (testes): devolve as falas em pt-BR ou null.
 *
 * `outcome`:
 * - `translated`: o texto mudou (traduzido de verdade);
 * - `unchanged`: o modelo devolveu as MESMAS falas — não há o que
 *   traduzir (fala só de nome/gíria). Não é falha: segurar o Short
 *   aqui seria segurar Short bom.
 */
export type CaptionTranslatorFn = (
  lines: CaptionLine[],
  language: string | null,
  context?: CaptionContext | null,
) => Promise<{ lines: CaptionLine[]; outcome: 'translated' | 'unchanged' } | null>;

export interface CaptionAiOptions {
  /** Ordem dos providers (`gemini,huggingface`). */
  order?: string;
  timeoutMs?: number;
  geminiApiKey?: string;
  geminiModel?: string;
  hfToken?: string;
  hfModel?: string;
  /** Modelo ggml do whisper.cpp no modo legenda (default: turbo). */
  whisperModel?: string;
  /** Modelo dedicado de transcrição (cota separada da de texto). */
  dedicatedModel?: string;
  /**
   * Tentativas no TOTAL das chamadas do Gemini (default: 3).
   *
   * Só erros TRANSITÓRIOS (5xx/"high demand") repetem — cota (429) não:
   * ela é final para o modelo de texto.
   */
  geminiAttempts?: number;
  /** Espera base entre as tentativas do Gemini (ms; dobra a cada repetição). */
  geminiRetryMs?: number;
  /**
   * O silêncio de um provider é FINAL? (default: sim)
   *
   * Com `false`, um provider que devolveu vazio deixa o próximo ser
   * consultado (um falso-negativo não mata a legenda) — mas o provider
   * local sem VAD pode alucinar fala no silêncio.
   */
  silenceFinal?: boolean;
  /** Passe revisor LLM (default: ligado). */
  refine?: boolean;
  /** Tradução para pt-BR quando o áudio não é português (default: ligado). */
  translate?: boolean;
  /** Revisor injetado (testes) — substitui a chamada ao Gemini. */
  geminiRefiner?: CaptionRefinerFn;
  /** Tradutor injetado (testes) — substitui a chamada ao Gemini. */
  geminiTranslator?: CaptionTranslatorFn;
  /**
   * Transcritores injetados (testes). Sem isto, cada provider é chamado
   * direto e a matriz silêncio/falha/sem-chave não é testável.
   */
  transcribers?: Partial<Record<CaptionProvider, CaptionProviderFn>>;
  /**
   * Fallback do modelo DEDICADO injetado (testes): é o caminho usado
   * quando a cota do Gemini de texto acaba.
   */
  dedicatedTranscriber?: CaptionProviderFn;
  /** Arquivo do vocabulário global (default: assets/caption-vocabulary.txt). */
  vocabularyFile?: string;
  /** Arquivo das correções de texto (default: assets/caption-corrections.txt). */
  correctionsFile?: string;
  /**
   * Provider do TEMPO da legenda (`whisper-cpp`).
   *
   * O modelo de linguagem acerta o texto e inventa o tempo (a legenda
   * aparece antes da voz). Com este campo, o texto do modelo é casado
   * com o tempo real do whisper local.
   */
  timingProvider?: 'whisper-cpp' | null;
  /** Modelo ggml do provider de tempo (o mesmo do `whisperModel`). */
  timingModel?: string;
}

export interface ParsedTranscript {
  lines: CaptionLine[];
  /** Palavras com tempo (quando o provider entrega essa granularidade). */
  words?: CaptionWord[];
  language: string | null;
  /** A legenda saiu traduzida para português? */
  translated: boolean;
  /** De onde veio o tempo das falas. */
  timingSource?: 'whisper' | 'model';
  /** Falas no idioma ORIGINAL (quando houve tradução). */
  originalLines?: CaptionLine[];
  /**
   * A tradução veio pela metade (algumas falas sem `text_pt`): a
   * legenda é tratada como NÃO traduzida e o tradutor roda por cima.
   */
  partialTranslation?: boolean;
}

/** Passes que podem rodar "pela metade". */
export type CaptionDegraded = 'translate' | 'refine';

export interface CaptionTranscript extends ParsedTranscript {
  provider: CaptionProvider;
  /**
   * Falas ANTES das correções do dono e da revisão da IA (com o tempo do
   * áudio, sem o `offsetSec` do silêncio inicial).
   *
   * É o que o marker guarda: assim uma regra nova (ou uma regra apagada)
   * vale no re-render — o texto guardado é o CRU, não o já corrigido.
   */
  rawLines?: CaptionLine[];
  /** Falas originais (antes da tradução) antes das correções. */
  rawOriginalLines?: CaptionLine[];
  /**
   * Passes que rodaram "pela metade": `translate` (o áudio estrangeiro
   * ficou no idioma original) e/ou `refine` (a revisão não rodou).
   */
  degraded?: CaptionDegraded[];
  /**
   * O áudio NÃO era português e a legenda ficou no idioma original.
   * O Short é segurado para a próxima rodada (a legenda em inglês não
   * vai ao ar).
   */
  untranslated?: boolean;
  /**
   * Regras de correção que mexeram na legenda (`molodoij>molodoy`).
   * O dono vê no marker qual regra disparou — é como se caça falso
   * positivo nas regras.
   */
  correctionsApplied?: string[];
}

export interface CaptionTranscriber {
  (
    audioPath: string,
    durSec: number,
    context?: CaptionContext | null,
    /**
     * Transcrição da rodada anterior (guardada no marker): quando ela
     * existe, o provider NÃO é chamado — só a tradução/revisão rodam de
     * novo (é o que retoma do passo que falhou).
     */
    cached?: CaptionTranscript | null,
  ): Promise<CaptionTranscript | null>;
  /**
   * Provider que respondeu "ninguém falou" na ÚLTIMA chamada (null
   * quando a legenda saiu). É o que o marker grava: sem isso, não dá
   * para saber se o clipe ficou sem legenda por silêncio real ou por
   * falso-negativo do provider local.
   */
  lastNoSpeechFrom?: CaptionProvider | null;
}

/** Transcritor de um provider (sem o campo `provider` — quem chama põe). */
export type CaptionProviderFn = (
  audioPath: string,
  durSec: number,
  context?: CaptionContext | null,
) => Promise<ParsedTranscript | null>;

const DEFAULT_ORDER = 'gemini,huggingface';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_HF_MODEL = 'openai/whisper-large-v3-turbo';

/** O provider guardado no marker (valor desconhecido vira o padrão). */
export function captionProviderFrom(value: unknown): CaptionProvider {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'gemini' || raw === 'huggingface' || raw === 'whisper-cpp') return raw;
  return 'gemini';
}

/** Providers conhecidos, na ordem pedida (sem repetição). */
export function captionProviders(order: string | undefined): CaptionProvider[] {
  const raw = (order ?? DEFAULT_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: CaptionProvider[] = [];
  for (const p of raw) {
    if (
      (p === 'gemini' || p === 'huggingface' || p === 'whisper-cpp') &&
      !out.includes(p)
    ) {
      out.push(p);
    }
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

/**
 * Pedido da transcrição (o modelo devolve JSON com o tempo de cada fala).
 *
 * O CONTEXTO (nomes do clipe + gíria de CS2) é o que segura a grafia:
 * sem ele o modelo "corrige" o áudio ("molodoy" → "molodoij", "equinho"
 * → "é quinho", "kills" → "quilos").
 */
export function buildCaptionPrompt(
  durSec: number,
  context?: CaptionContext | null,
  extraVocabulary?: string[],
  opts: { translate?: boolean } = {},
): string {
  const translate = opts.translate !== false;
  const vocabulary = captionVocabulary(context);
  for (const term of extraVocabulary ?? []) {
    const text = String(term ?? '').trim();
    if (text && !vocabulary.some((item) => item.toLowerCase() === text.toLowerCase())) {
      vocabulary.push(text);
    }
  }
  const jargon = vocabulary.filter((v) =>
    (CS_CAPTION_GLOSSARY as readonly string[]).includes(v),
  );
  const names = vocabulary.filter((v) => !jargon.includes(v));
  const contextBlock = vocabulary.length
    ? [
        '',
        'CONTEXTO (use EXATAMENTE estas grafias):',
        ...(context?.player ? [`- jogador do ace: ${context.player}`] : []),
        ...(context?.team1 || context?.team2
          ? [`- times: ${[context.team1, context.team2].filter(Boolean).join(', ')}`]
          : []),
        ...(context?.players?.length
          ? [`- jogadores citados: ${context.players.join(', ')}`]
          : []),
        ...(context?.map ? [`- mapa: ${context.map}`] : []),
        ...(context?.event ? [`- evento: ${context.event}`] : []),
        ...(names.length ? [`- outros nomes: ${names.join(', ')}`] : []),
        `- gíria de CS2 (NÃO traduza): ${jargon.join(', ')}`,
      ]
    : [];
  return [
    'Você transcreve o áudio de um trecho de transmissão de CS2 (commentário de caster) para virar legenda queimada no vídeo.',
    ...contextBlock,
    '',
    'REGRAS:',
    `- O áudio tem ${Math.max(1, Math.round(durSec))} segundos. "start" e "end" são segundos DEPOIS do início do áudio (0 = o primeiro segundo).`,
    '- Uma entrada = UMA fala curta (uma frase). start < end, sem sobrepor com a fala anterior.',
    '- Escreva EXATAMENTE o que é falado: não resuma, não comente, não corrija, não complete.',
    '- Mantenha a gíria e os diminutivos como foram falados: "equinho" (NÃO "é quinho"), "kills" (NÃO "quilos"), "molodoy" (NÃO "molodói"/"molodoij"/"molodore").',
    '- Use os nomes do CONTEXTO com a grafia exata. Se ouvir um nome parecido com um do CONTEXTO, escreva o nome do CONTEXTO (nunca o que parece no áudio).',
    '- Termos do jogo na forma canônica: Tec-9 (NÃO "tech nine"), Bomb A/Bomb B (NÃO "bombear"), bomba plantada (NÃO "boa plantada"), HE/HEzinha (NÃO "gae/gaezinha"), biskela (apelido do aleksib), Gau (apelido do Gaules; NÃO "gal"/"legal" quando for vocativo).',
    '- Não traduza nome de jogador/time/mapa/arma.',
    '- Máximo de 32 caracteres por fala (a legenda quebra em até 2 linhas).',
    '- "language" é o idioma falado ("en", "pt-BR"...).',
    ...(translate
      ? [
          '- Se o idioma NÃO for português, preencha também "text_pt" com a tradução para português do Brasil (mantendo os nomes do CONTEXTO). Se for português, "text_pt" fica igual a "text".',
        ]
      : ['- NÃO traduza: escreva tudo como foi falado, no idioma original.']),
    '',
    'Responda APENAS com JSON válido:',
    translate
      ? '{"language":"en","lines":[{"start":1.20,"end":3.40,"text":"...","text_pt":"..."}]}'
      : '{"language":"en","lines":[{"start":1.20,"end":3.40,"text":"..."}]}',
  ].join('\n');
}

/**
 * O idioma precisa de tradução? `pt`/`pt-BR`/`português` não; idioma
 * vazio (provider sem detecção) também não — sem saber o idioma a
 * chamada gastaria cota e podia "traduzir" português para português.
 */
export function captionNeedsTranslation(language: string | null | undefined): boolean {
  const raw = String(language ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return false;
  if (/^(pt|por)([-_]|$)/.test(raw)) return false;
  if (/portug/.test(raw)) return false;
  return true;
}

/**
 * Palavras que dizem o idioma sem serem gíria de CS2 (a gíria é
 * igual nos dois idiomas e não serve de pista).
 *
 * As listas são escritas SEM acento porque a comparação normaliza o
 * texto (NFD + tira o diacrítico): "não" casa com `nao`, "você" com
 * `voce`, "já" com `ja`. Palavra que também existe em inglês ("so",
 * "to", "right", "like", "for") fica de fora — ela contaria ponto
 * errado justamente nas legendas em português.
 */
const PT_MARKERS = [
  'que', 'pra', 'pro', 'com', 'nao', 'ele', 'ela', 'isso', 'aqui', 'voce',
  'ta', 'ne', 'esse', 'essa', 'depois', 'agora', 'porque', 'entao', 'sim',
  'mano', 'cara', 'gente', 'vamo', 'vamos', 'ja', 'bem', 'muito', 'ali',
  'la', 'aonde', 'quando', 'meu', 'minha', 'nos', 'nossa', 'eles', 'elas',
  'tem', 'foi', 'sera', 'ser', 'esta', 'fala', 'falando', 'jogo', 'partida',
  'mekar', 'olha', 'tipo', 'onde', 'coisa', 'mata', 'matar', 'morreu',
];
const EN_MARKERS = [
  'the', 'and', 'you', 'that', 'this', 'with', 'from', 'they',
  'what', 'when', 'where', 'would', 'could', 'should', 'there', 'their',
  'about', 'just', 'know', 'think', 'yeah', 'okay', 'guys',
  'gonna', 'lets', 'really', 'maybe', 'alright', 'going', 'talk', 'tell',
  'after', 'before', 'again', 'every', 'much', 'more', 'most', 'some',
  'hello', 'bye', 'dude', 'bro',
];

/**
 * O texto FALA português? ( heurística barata, sem rede)
 *
 * Serve para quando o provider não diz o idioma (o Whisper do
 * HuggingFace nunca diz) e para conferir o idioma que ele disse: se o
 * provider diz "en" mas o texto é claramente português, o provider
 * errou (gíria em inglês não conta).
 *
 * Devolve `unknown` quando o texto é curto demais para ter pista —
 * aí ninguém decide nada por causa disso.
 */
export function captionLooksPortuguese(text: string): boolean | 'unknown' {
  const words = captionTokens(String(text ?? ''));
  if (words.length < 12) return 'unknown';
  let pt = 0;
  let en = 0;
  for (const word of words) {
    if (PT_MARKERS.includes(word)) pt += 1;
    else if (EN_MARKERS.includes(word)) en += 1;
  }
  if (pt === 0 && en === 0) return 'unknown';
  // "Inglês" precisa de DUAS pistas: uma palavra em inglês num texto
  // português (um "like", um "ok") não pode virar tradução/segura.
  if (en >= 2 && en >= pt * 2) return false;
  if (pt >= 1 && pt >= en * 2) return true;
  return 'unknown';
}

/**
 * Idioma estrangeiro sem nome: o provider não disse (ou disse algo
 * inútil) e o texto não é português. A sentinela NÃO pode vazar para
 * o prompt do tradutor ("idioma de origem: unknown-foreign").
 */
export const CAPTION_UNKNOWN_FOREIGN = 'unknown-foreign';

/** O idioma que pode ser mostrado ao tradutor (a sentinela vira nada). */
export function captionPromptLanguage(language: string | null | undefined): string | null {
  const raw = String(language ?? '').trim();
  if (!raw || raw === CAPTION_UNKNOWN_FOREIGN) return null;
  return raw;
}

/**
 * O idioma EFETIVO da legenda (provider + texto).
 *
 * O provider manda, mas o texto tem a palavra final: gíria em inglês
 * ("clutch", "one-tap") não faz o áudio ser inglês. Sem isso, um
 * provider que erra o idioma segura Shorts bons (ou publica legenda
 * estrangeira sem traduzir).
 */
export function captionEffectiveLanguage(
  language: string | null | undefined,
  text: string,
): { language: string | null; needsTranslation: boolean } {
  const raw = String(language ?? '').trim();
  const looks = captionLooksPortuguese(text);
  if (!raw) {
    // Provider sem detecção (HuggingFace): decide o texto.
    if (looks === false) {
      return { language: CAPTION_UNKNOWN_FOREIGN, needsTranslation: true };
    }
    return { language: null, needsTranslation: false };
  }
  if (!captionNeedsTranslation(raw)) return { language: raw, needsTranslation: false };
  // O provider disse estrangeiro: se o texto é claramente português,
  // foi o provider que errou (gíria em inglês).
  if (looks === true) return { language: 'pt', needsTranslation: false };
  return { language: raw, needsTranslation: true };
}

/** Bloco de nomes/gíria que os prompts de revisão e tradução recebem. */
function captionNamesBlock(context?: CaptionContext | null, extra?: string[]): string[] {
  const names = captionVocabulary(context);
  for (const term of extra ?? []) {
    const text = String(term ?? '').trim();
    if (text && !names.some((item) => item.toLowerCase() === text.toLowerCase())) {
      names.push(text);
    }
  }
  return names.length
    ? [`NOMES (use EXATAMENTE esta grafia): ${names.join(', ')}`]
    : [];
}

/**
 * Prompt do REVISOR: o modelo só corrige o que está claramente errado,
 * sem reescrever. A quantidade e a ordem das falas não mudam (o tempo de
 * cada uma fica no `.ass`; o revisor devolve só o texto).
 */
export function buildRefinePrompt(
  lines: CaptionLine[],
  context?: CaptionContext | null,
  extraVocabulary?: string[],
): string {
  const numbered = (lines ?? [])
    .map((line, i) => `${i + 1}. ${line.text}`)
    .join('\n');
  return [
    'Você revisa a legenda automática de um trecho de transmissão de CS2 em português.',
    ...captionNamesBlock(context, extraVocabulary),
    '',
    'FALAS (uma por linha, na ordem):',
    numbered,
    '',
    'REGRAS:',
    '- Corrija APENAS o que está claramente errado: nome de jogador/time/mapa/arma, termo de CS2, palavra sem sentido e pontuação.',
    '- Se um nome do áudio for parecido com um nome da lista, use o nome da lista com a grafia exata.',
    '- Termos do jogo na forma canônica: Tec-9 (não "tech nine"), Bomb A/Bomb B (não "bombear"), HE/HEzinha (não "gae/gaezinha"), bomba plantada, biskela (apelido do aleksib), Gau (apelido do Gaules; não "gal"/"legal" quando for vocativo).',
    '- NÃO reescreva, NÃO resuma, NÃO complete, NÃO traduza e NÃO mude o sentido.',
    '- NÃO junte nem separe falas e NÃO altere a ordem.',
    `- Devolva EXATAMENTE ${(lines ?? []).length} falas, na mesma ordem.`,
    '',
    'Responda APENAS com JSON válido:',
    '{"lines":[{"text":"..."}]}',
  ].join('\n');
}

/** Prompt da TRADUÇÃO: mantém nomes e gíria de CS, mesmo número de falas. */
export function buildTranslationPrompt(
  lines: CaptionLine[],
  context?: CaptionContext | null,
  extraVocabulary?: string[],
  language?: string | null,
): string {
  const numbered = (lines ?? [])
    .map((line, i) => `${i + 1}. ${line.text}`)
    .join('\n');
  const source = String(language ?? '').trim();
  return [
    'Você traduz a legenda de um trecho de transmissão de CS2 para português do Brasil.',
    ...(source ? [`- idioma de origem: ${source}`] : []),
    ...captionNamesBlock(context, extraVocabulary),
    '',
    'FALAS (uma por linha, na ordem):',
    numbered,
    '',
    'REGRAS:',
    '- Traduza cada fala para português do Brasil, natural, como um narrador brasileiro falaria.',
    '- NÃO traduza nomes de jogadores, times, mapas, armas e nem gíria de CS2 (kills, ace, clutch, eco, rush, plant, defuse, save, trade, wallbang, one-tap...).',
    '- NÃO reescreva, NÃO resuma e NÃO complete.',
    '- NÃO junte nem separe falas e NÃO altere a ordem.',
    `- Devolva EXATAMENTE ${(lines ?? []).length} falas, na mesma ordem.`,
    '',
    'Responda APENAS com JSON válido:',
    '{"lines":[{"text":"..."}]}',
  ].join('\n');
}

/**
 * Falas devolvidas pelo revisor/tradutor, na ordem. `null` = resposta
 * inutilizável (quantidade errada, texto vazio, JSON quebrado): melhor
 * ficar com a legenda original do que publicar uma revisão truncada.
 *
 * `fallback` (as falas originais) faz o passe cair por FALA: uma linha
 * vazia não descarta o passe inteiro — ela fica com o texto original e
 * as outras linhas mantêm a revisão/tradução. Só a quantidade errada
 * descarta tudo (aí não dá para casar fala com fala).
 */
export function parseLineFixes(
  raw: string,
  count: number,
  fallback?: string[],
): string[] | null {
  const obj = parseTranscriptJson(raw);
  if (!obj || !Array.isArray(obj.lines)) return null;
  if (obj.lines.length !== count) return null;
  const out: string[] = [];
  for (let i = 0; i < obj.lines.length; i++) {
    const item = obj.lines[i];
    const text =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? String((item as { text?: unknown }).text ?? '')
          : '';
    const clean = normalizeCaptionText(text);
    if (!clean) {
      const original = normalizeCaptionText(fallback?.[i] ?? '');
      if (!original) return null;
      out.push(original);
      continue;
    }
    out.push(clean);
  }
  return out;
}

/**
 * A tradução é plausível? O texto vem de fala (que pode tentar
 * convencer o modelo a escrever outra coisa) e é queimado no vídeo.
 *
 * O tamanho é a guarda prática: tradução de uma fala é mais ou menos
 * do mesmo tamanho; texto muito maior (ou muito menor) é alucinação
 * ou resumo — melhor a fala original.
 */
export function isPlausibleTranslation(original: string, translated: string): boolean {
  const a = String(original ?? '').trim();
  const b = String(translated ?? '').trim();
  if (!a || !b) return false;
  if (b.length > Math.max(60, a.length * 3)) return false;
  if (a.length >= 12 && b.length < a.length * 0.3) return false;
  return true;
}

/**
 * Normaliza o texto para comparação: minúsculas, SEM acento, sem
 * pontuação, espaço único.
 *
 * O acento é removido de propósito: a lista de pistas de idioma é
 * escrita sem acento ("nao", "voce") e precisa casar com o texto real
 * ("não", "você") — sem isso a heurística nunca via português num
 * texto com acento.
 */
function captionKey(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function captionTokens(value: string): string[] {
  const key = captionKey(value);
  return key ? key.split(' ') : [];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Similaridade 0..1 entre duas falas (ignora maiúsculas/pontuação). */
export function captionSimilarity(a: string, b: string): number {
  const x = captionKey(a);
  const y = captionKey(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * A correção do revisor é segura? O passe é LLM: sem a guarda ele
 * reescrevia a fala inteira ("melhorou" o texto e mudou o sentido).
 *
 * Aceita quando a fala continua parecida OU quando é a troca de UMA
 * palavra por um NOME do vocabulário ("Legal" → "Gau", "beat" → "b1t") —
 * nomes curtos têm similaridade baixa e são exatamente o alvo da revisão.
 */
export function isSafeCaptionFix(
  original: string,
  fixed: string,
  vocabulary?: string[],
): boolean {
  const a = String(original ?? '').trim();
  const b = String(fixed ?? '').trim();
  if (!a || !b) return false;
  if (b.length > Math.max(60, a.length * 2)) return false;
  const aTokens = captionTokens(a);
  const bTokens = captionTokens(b);
  const names = new Set((vocabulary ?? []).map((item) => captionKey(item)));
  if (
    aTokens.length === 1 &&
    bTokens.length === 1 &&
    !names.has(captionKey(a)) &&
    names.has(captionKey(b))
  ) {
    return true;
  }
  return captionSimilarity(a, b) >= 0.55;
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
  /** Falas no idioma ORIGINAL (quando a legenda saiu traduzida). */
  originalLines?: CaptionLine[];
  /**
   * A tradução veio pela metade: algumas falas têm `text_pt` e outras
   * não. A legenda ficaria misturada (metade em português, metade no
   * idioma original) — aí ela é tratada como NÃO traduzida e o tradutor
   * roda por cima.
   */
  partialTranslation?: boolean;
} {
  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines: CaptionLine[] = [];
  const originals: CaptionLine[] = [];
  let translated = false;
  let withPt = 0;
  let withoutPt = 0;
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
    if (pt) withPt += 1;
    else withoutPt += 1;
    if (pt && pt !== original) translated = true;
    const startSec = Number(rec.start);
    const endSec = Number(rec.end);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    const clean = normalizeCaptionText(chosen);
    if (!clean) continue;
    lines.push({ startSec, endSec, text: clean });
    // O original (idioma de origem) é guardado INTEIRO para o
    // `.orig.txt`: a tradução do Gemini pode ter vindo só em parte, e o
    // backup do texto original não pode ter buraco.
    const cleanOriginal = normalizeCaptionText(original);
    if (cleanOriginal) originals.push({ startSec, endSec, text: cleanOriginal });
  }
  const language = typeof obj.language === 'string' ? obj.language.trim() : '';
  // Metade traduzida e metade não: a legenda sai misturada → não conta
  // como traduzida (o tradutor roda por cima para consertar).
  const partialTranslation = withPt > 0 && withoutPt > 0;
  if (partialTranslation) translated = false;
  const originalLines = translated || partialTranslation ? originals : undefined;
  return {
    lines,
    language: language || null,
    translated,
    ...(originalLines?.length ? { originalLines } : {}),
    ...(partialTranslation ? { partialTranslation } : {}),
  };
}

/**
 * Lê o JSON da transcrição. `text_pt` tem prioridade quando existe (a
 * legenda vai em português; o áudio pode ser inglês).
 */
export function parseGeminiTranscript(raw: string): ParsedTranscript | null {
  const obj = parseTranscriptJson(raw);
  if (!obj) return null;
  const { lines, language, translated, originalLines, partialTranslation } =
    usableTranscriptLines(obj);
  if (lines.length === 0) return null;
  return {
    lines,
    language,
    translated,
    ...(originalLines ? { originalLines } : {}),
    ...(partialTranslation ? { partialTranslation } : {}),
  };
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
  opts: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    durSec: number;
    context?: CaptionContext | null;
    /** Vocabulário global (repo) somado ao contexto do clipe. */
    vocabulary?: string[];
    /**
     * Pede a tradução junto (`text_pt`) quando o áudio não é português.
     * Desligado, o modelo devolve só o idioma original.
     */
    translate?: boolean;
    /** Tentativas no total da chamada (erro transitório repete). */
    attempts?: number;
    /** Espera base entre as tentativas (ms). */
    retryDelayMs?: number;
  },
): Promise<ParsedTranscript | null> {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const audio = fs.readFileSync(audioPath);
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const translate = opts.translate !== false;
  const run = async (): Promise<string> => {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: [
        { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
        {
          text: buildCaptionPrompt(opts.durSec, opts.context, opts.vocabulary, {
            translate,
          }),
        },
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
                  ...(translate ? { text_pt: { type: Type.STRING } } : {}),
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
  };
  const raw = await withGeminiRetry(
    () => withTimeout(run(), opts.timeoutMs, 'gemini-transcricao'),
    {
      attempts: opts.attempts,
      retryDelayMs: opts.retryDelayMs,
      label: 'gemini-transcricao',
    },
  );
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
  // As correções do repo são aplicadas no `finalize` (depois da
  // tradução): aplicá-las aqui e lá duplicava o trabalho — e corrigia
  // texto estrangeiro ("what a twist" → "Twistzz").
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
 * Pede ao Gemini uma lista de falas com a MESMA quantidade (revisão ou
 * tradução). O schema força `{"lines":[{"text":"..."}]}`.
 */
async function askGeminiLines(
  prompt: string,
  opts: CaptionLineFixOptions,
  label: string,
): Promise<string> {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const run = async (): Promise<string> => {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: [{ text: prompt }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            lines: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { text: { type: Type.STRING } },
                required: ['text'],
              },
            },
          },
          required: ['lines'],
        },
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 8192,
      },
    });
    const finish = res.candidates?.[0]?.finishReason;
    if (finish && /MAX_TOKENS/i.test(String(finish))) {
      throw new Error(`${label}: resposta truncada (finishReason=${String(finish)})`);
    }
    return res.text ?? '';
  };
  return withGeminiRetry(() => withTimeout(run(), opts.timeoutMs, label), {
    attempts: opts.attempts,
    retryDelayMs: opts.retryDelayMs,
    label,
  });
}

/**
 * Revisão da legenda (passe LLM): corrige nome/termo de CS que a
 * transcrição errou SEM reescrever. Best-effort: devolve `null` quando a
 * resposta não serve (quem chama fica com a legenda original).
 */
export async function refineCaptionLines(
  lines: CaptionLine[],
  opts: CaptionLineFixOptions,
): Promise<CaptionLine[] | null> {
  const source = lines ?? [];
  if (source.length === 0) return null;
  const raw = await askGeminiLines(
    buildRefinePrompt(source, opts.context, opts.vocabulary),
    opts,
    'gemini-revisao-legenda',
  );
  const fixes = parseLineFixes(raw, source.length, source.map((line) => line.text));
  if (!fixes) return null;
  return source.map((line, i) => ({
    ...line,
    text: isSafeCaptionFix(line.text, fixes[i], opts.vocabulary)
      ? fixes[i]
      : line.text,
  }));
}

/**
 * Tradução da legenda para pt-BR (streamer estrangeiro). Mantém nomes,
 * mapas, armas e gíria; a quantidade de falas não muda.
 *
 * `outcome` distingue "traduziu" de "não tinha o que traduzir": uma
 * fala só de nome/gíria volta igual — isso não é falha (segurar o
 * Short aí seria segurar Short bom).
 */
export async function translateCaptionLines(
  lines: CaptionLine[],
  opts: CaptionLineFixOptions & { language?: string | null },
): Promise<{ lines: CaptionLine[]; outcome: 'translated' | 'unchanged' } | null> {
  const source = lines ?? [];
  if (source.length === 0) return null;
  const raw = await askGeminiLines(
    buildTranslationPrompt(source, opts.context, opts.vocabulary, opts.language),
    opts,
    'gemini-traducao-legenda',
  );
  const fixes = parseLineFixes(raw, source.length, source.map((line) => line.text));
  if (!fixes) return null;
  let changed = false;
  const out = source.map((line, i) => {
    // Guarda de tamanho: texto gigante (ou resumo) é alucinação do
    // modelo — fica a fala original.
    const text = isPlausibleTranslation(line.text, fixes[i]) ? fixes[i] : line.text;
    if (captionKey(text) !== captionKey(line.text)) changed = true;
    return { ...line, text };
  });
  return { lines: out, outcome: changed ? 'translated' : 'unchanged' };
}

/** Modelo ggml usado na legenda local (o turbo é o melhor custo/qualidade). */
export const DEFAULT_CAPTION_WHISPER_MODEL = 'large-v3-turbo-q5_0';

/**
 * Palavras de uma fala, para comparar com outra (minúsculas, sem
 * acento e sem pontuação): "FalleN, né?" → ["fallen", "ne"].
 */
export function captionMatchTokens(text: string): string[] {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

/** Número por extenso que o caster também usa na fala. */
const CAPTION_NUMBER_WORDS: Record<string, string> = {
  um: '1',
  uma: '1',
  dois: '2',
  duas: '2',
  tres: '3',
  quatro: '4',
  cinco: '5',
  seis: '6',
  sete: '7',
  oito: '8',
  nove: '9',
  dez: '10',
};

/**
 * Forma comparável de uma palavra ouvida.
 *
 * Números por extenso casam com o algarismo (`dois` = `2`) e o `1` de um
 * gamertag pode ser a letra `i` (`r1nkle` = `rinkle`). O resto fica como
 * está: a tolerância de erro de escuta continua sendo medida pela
 * distância de edição.
 */
function comparableCaptionToken(value: string): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (CAPTION_NUMBER_WORDS[raw]) return CAPTION_NUMBER_WORDS[raw];
  if (/[\p{L}]/u.test(raw) && /\d/u.test(raw)) {
    return raw.replace(/1/g, 'i').replace(/0/g, 'o');
  }
  return raw;
}

/**
 * Duas palavras são a MESMA palavra?
 *
 * O modelo de linguagem escreve o nome do jeito certo ("KSCERATO") e o
 * whisper local escreve o que ouviu ("Cacerato"): sem essa tolerância,
 * a fala não casa com o tempo e a legenda cai no chute do modelo.
 */
export function captionTokensMatch(a: string, b: string): boolean {
  const left = comparableCaptionToken(a);
  const right = comparableCaptionToken(b);
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length < 4) return false;
  if (long.startsWith(short)) return true;
  // Um erro de digitação/escuta só: "defusa" x "defuse", "molodoy" x
  // "molodói" (a distância de edição é 1).
  if (Math.abs(left.length - right.length) > 1) return false;
  return levenshtein(left, right) <= 1;
}

/**
 * Duas palavras são próximas o bastante para o fallback posicional?
 *
 * O fallback só serve para preencher uma palavra que NÃO encontrou
 * âncora. Ele precisa exigir semelhança real: `Heavy` não pode herdar o
 * tempo de `bigode`, nem `God` o de `a`. Um erro de escuta ainda vale
 * (`Gau` x `Gal`), desde que a distância de edição seja no máximo 1.
 */
function captionTokenNear(a: string, b: string): boolean {
  const left = comparableCaptionToken(a);
  const right = comparableCaptionToken(b);
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  // Palavras muito curtas geram falso-positivo ("a" x "o", "e" x "é").
  if (Math.min(left.length, right.length) < 3) return false;
  return levenshtein(left, right) <= 1;
}

/**
 * Palavras que NÃO distinguem uma fala da outra: "a", "de", "que",
 * "não"... contadas como acerto, elas inflavam o score e faziam a fala
 * casar com o trecho errado (a legenda ia para a hora errada).
 */
const CAPTION_STOPWORDS = new Set([
  'a',
  'ai',
  'as',
  'ao',
  'aqui',
  'com',
  'como',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'eh',
  'ele',
  'ela',
  'elao',
  'em',
  'eu',
  'foi',
  'la',
  'mais',
  'mas',
  'me',
  'muito',
  'na',
  'nao',
  'nas',
  'no',
  'nos',
  'num',
  'numa',
  'o',
  'os',
  'ou',
  'para',
  'pela',
  'pelo',
  'por',
  'pra',
  'pro',
  'que',
  'quem',
  'se',
  'sem',
  'ser',
  'seu',
  'so',
  'ta',
  'te',
  'tem',
  'ter',
  'tu',
  'um',
  'uma',
  'vai',
  'voce',
  'vos',
]);

/**
 * Palavras que DISTINGUEM a fala (para comparar com o whisper): as
 * stopwords saem e o resto fica.
 *
 * Uma fala feita só de stopwords fica sem par: `a`, `em` e `tem` aparecem
 * em qualquer frase e casariam com o trecho errado.
 */
function captionContentTokens(text: string): string[] {
  return captionMatchTokens(text).filter(
    (token) =>
      !CAPTION_STOPWORDS.has(token) &&
      (token.length >= 2 || /^\d+$/.test(token)),
  );
}

/** Palavra com tempo usada no alinhamento do texto com o áudio. */
interface CaptionAlignmentWord extends CaptionWord {
  /** Índice da fala de origem (necessário no fallback por blocos). */
  sourceLine: number;
}

/**
 * Converte blocos do whisper em palavras com tempo.
 *
 * É o plano B quando o provider não devolve timestamps por palavra. As
 * palavras são distribuídas dentro do bloco; o importante é não herdar
 * o bloco INTEIRO quando só uma palavra da legenda casou com ele.
 */
function timingWordsFromLines(lines: CaptionLine[]): CaptionAlignmentWord[] {
  const out: CaptionAlignmentWord[] = [];
  for (const [sourceLine, line] of (lines ?? []).entries()) {
    const words = captionMatchTokens(line.text);
    if (words.length === 0) continue;
    const start = Number(line.startSec);
    const end = Number(line.endSec);
    const step = Math.max(0.05, (end - start) / words.length);
    words.forEach((text, index) => {
      const wordStart = start + step * index;
      const wordEnd = index === words.length - 1 ? end : wordStart + step;
      out.push({
        text,
        startSec: wordStart,
        endSec: Math.max(wordStart + 0.05, wordEnd),
        sourceLine,
      });
    });
  }
  return out;
}

/** Token do texto do modelo ou do áudio, pronto para o alinhamento global. */
interface CaptionAlignmentToken {
  text: string;
  lineIndex: number;
}

/** Par entre um token do modelo e uma palavra do áudio. */
interface CaptionAlignmentPair {
  modelIndex: number;
  timingIndex: number;
}

/**
 * Corta o silêncio do COMEÇO do áudio.
 *
 * O whisper ancora a primeira fala no começo do arquivo: com 9s de
 * silêncio antes da voz, a legenda aparece 9s antes de quem fala (e as
 * palavras seguintes herdam o atraso). Cortando o silêncio inicial, o
 * whisper ouve a fala logo no começo — e o tempo cortado volta no
 * final (o `offsetSec`).
 */
export async function trimLeadingSilence(
  wavPath: string,
): Promise<{ path: string; offsetSec: number } | null> {
  try {
    const originalSec = wavDurationSecFromBytes(fs.statSync(wavPath).size);
    if (!originalSec || originalSec < 1) return null;
    const outPath = `${wavPath}.trim.wav`;
    await execFileAsync(
      resolveFfmpegBin(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostats',
        '-y',
        '-i',
        wavPath,
        '-af',
        'silenceremove=start_periods=1:start_duration=0.3:start_threshold=-35dB',
        '-c:a',
        'pcm_s16le',
        outPath,
      ],
      { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 * 8 },
    );
    const trimmedSec = wavDurationSecFromBytes(fs.statSync(outPath).size);
    const offsetSec = Math.round((originalSec - trimmedSec) * 1000) / 1000;
    // Só vale a pena quando cortou silêncio de verdade (e sobrou áudio).
    if (offsetSec < 0.3 || trimmedSec < 1) {
      fs.rmSync(outPath, { force: true });
      return null;
    }
    return { path: outPath, offsetSec };
  } catch {
    return null;
  }
}

/**
 * Duração máxima (s) de uma legenda que NÃO casou com o whisper.
 *
 * Sem teto, a fala sem par ficava na tela pelo vão inteiro (30s de
 * silêncio viravam 30s de legenda parada).
 */
const MAX_UNPAIRED_CAPTION_SEC = 4;

/**
 * Resultado do alinhamento do texto do modelo com o áudio.
 */
export interface CaptionAlignment {
  /** Linhas alinhadas, em ordem CRONOLÓGICA (pelo tempo real). */
  lines: CaptionLine[];
  /**
   * Índice (na ENTRADA) de cada linha devolvida.
   *
   * As linhas saem ordenadas pelo tempo; quem casa por posição (a
   * tradução projeta o tempo do original no traduzido) precisa deste
   * mapa: sem ele, um empate de tempo ou um fallback não monotônico
   * troca o tempo de uma fala por outra.
   */
  order: number[];
  /** Falas que casaram com o áudio. */
  anchoredLines: number;
  /** Total de falas do texto. */
  totalLines: number;
}

/**
 * Pega o TEMPO REAL das falas (o whisper local sabe quando cada
 * palavra foi dita) e mantém o TEXTO do modelo de linguagem.
 *
 * O modelo de linguagem (Gemini) acerta o que foi falado — com o
 * contexto do clipe na mão, ele escreve "bomb A" e "KSCERATO" — mas
 * INVENTA o tempo: ele distribui as falas ao longo do áudio, e a
 * legenda aparece antes da voz (e cada vez mais adiantada). O whisper
 * local tem o tempo exato de cada palavra, mas erra a grafia.
 *
 * A solução é casar os dois: o texto vem do modelo, o tempo vem do
 * whisper. A fala que não casa com nenhuma do whisper fica no tempo do
 * modelo, ajeitado no vão entre as falas vizinhas (para não invadir a
 * fala seguinte).
 */
export function alignCaptionTimingsDetailed(
  textLines: CaptionLine[],
  timingLines: CaptionLine[],
  opts: { words?: CaptionWord[] } = {},
): CaptionAlignment {
  const lines = textLines ?? [];
  const timing = (timingLines ?? []).filter(
    (line) =>
      Number.isFinite(line?.startSec) &&
      Number.isFinite(line?.endSec) &&
      line.endSec >= line.startSec,
  );
  if (lines.length === 0 || timing.length === 0) {
    return {
      lines: lines.map((line) => ({ ...line })),
      order: lines.map((_, index) => index),
      anchoredLines: 0,
      totalLines: lines.length,
    };
  }

  const modelTokens: CaptionAlignmentToken[] = [];
  const modelTokenIndexes = new Map<number, number[]>();
  lines.forEach((line, lineIndex) => {
    const indexes: number[] = [];
    for (const text of captionMatchTokens(line.text)) {
      indexes.push(modelTokens.length);
      modelTokens.push({ text, lineIndex });
    }
    modelTokenIndexes.set(lineIndex, indexes);
  });

  const timingWords = opts.words?.length
    ? opts.words
        .filter(
          (word) =>
            word &&
            Number.isFinite(word.startSec) &&
            Number.isFinite(word.endSec) &&
            word.endSec >= word.startSec,
        )
        .flatMap((word, index) =>
          captionMatchTokens(word.text).map((text) => ({
            text,
            startSec: word.startSec,
            endSec: word.endSec,
            sourceLine: index,
          })),
        )
    : timingWordsFromLines(timing);
  if (modelTokens.length === 0 || timingWords.length === 0) {
    return {
      lines: lines.map((line) => ({ ...line })),
      order: lines.map((_, index) => index),
      anchoredLines: 0,
      totalLines: lines.length,
    };
  }

  /**
   * Âncoras de conteúdo: o LCS global casa as palavras que distinguem
   * uma fala da outra. Stopwords (`tem`, `a`, `é`) NÃO são âncoras: elas
   * aparecem em qualquer frase e já foram a causa de `tem nada` casar
   * com o bloco `bigode`.
   */
  const modelContent = modelTokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => captionContentTokens(token.text).length > 0);
  const timingContent = timingWords
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => captionContentTokens(word.text).length > 0);
  const anchors = alignCaptionContentAnchors(modelContent, timingContent);

  /**
   * Tokens de uma linha que ficam entre duas âncoras globais. Quando a
   * quantidade bate, eles são distribuídos na ordem; quando não bate,
   * só uma palavra igual (geralmente uma stopword) muito próxima da
   * âncora é aproveitada. Assim `tem` entra antes de `nada`, mas uma
   * palavra solta não herda meia janela do áudio.
   */
  const timingForModel = new Map<number, number>();
  const usedTimingIndexes = new Set<number>();
  for (const anchor of anchors) {
    timingForModel.set(anchor.modelIndex, anchor.timingIndex);
    usedTimingIndexes.add(anchor.timingIndex);
  }

  const anchoredLines = new Set<number>();
  for (const anchor of anchors) {
    anchoredLines.add(modelTokens[anchor.modelIndex].lineIndex);
  }

  for (const [lineIndex, indexes] of modelTokenIndexes) {
    if (!anchoredLines.has(lineIndex) || indexes.length === 0) continue;
    const lineAnchors = anchors
      .filter((anchor) => modelTokens[anchor.modelIndex].lineIndex === lineIndex)
      .sort((a, b) => a.modelIndex - b.modelIndex);
    const first = lineAnchors[0];
    const last = lineAnchors[lineAnchors.length - 1];
    const segments: Array<{
      modelStart: number;
      modelEnd: number;
      edge: 'start' | 'middle' | 'end';
      previous?: CaptionAlignmentPair;
      next?: CaptionAlignmentPair;
    }> = [];

    if (first.modelIndex > indexes[0]) {
      segments.push({
        modelStart: indexes[0],
        modelEnd: first.modelIndex - 1,
        edge: 'start',
        previous: previousCaptionAnchor(anchors, indexes[0]),
        next: first,
      });
    }
    for (let i = 1; i < lineAnchors.length; i++) {
      const previous = lineAnchors[i - 1];
      const next = lineAnchors[i];
      if (next.modelIndex > previous.modelIndex + 1) {
        segments.push({
          modelStart: previous.modelIndex + 1,
          modelEnd: next.modelIndex - 1,
          edge: 'middle',
          previous,
          next,
        });
      }
    }
    if (last.modelIndex < indexes[indexes.length - 1]) {
      segments.push({
        modelStart: last.modelIndex + 1,
        modelEnd: indexes[indexes.length - 1],
        edge: 'end',
        previous: last,
        next: nextCaptionAnchor(anchors, indexes[indexes.length - 1]),
      });
    }

    for (const segment of segments) {
      const modelSegment = modelTokens.slice(segment.modelStart, segment.modelEnd + 1);
      const timingStart = segment.previous
        ? segment.previous.timingIndex + 1
        : 0;
      const timingEnd = segment.next
        ? segment.next.timingIndex - 1
        : timingWords.length - 1;
      if (timingEnd < timingStart) continue;
      const candidates = Array.from(
        { length: timingEnd - timingStart + 1 },
        (_, index) => timingStart + index,
      ).filter((index) => !usedTimingIndexes.has(index));

      if (candidates.length === modelSegment.length) {
        modelSegment.forEach((_token, index) => {
          timingForModel.set(segment.modelStart + index, candidates[index]);
          usedTimingIndexes.add(candidates[index]);
        });
        continue;
      }

      // Quantidades diferentes: primeiro usa uma palavra igual e
      // próxima da âncora. `tem` (39,0s) entra antes de `nada`
      // (39,21s); o `a` de `a galera gosta` entra no `a` imediatamente
      // anterior. A palavra que sobrou sem par fica na palavra mais
      // próxima da borda do trecho, sem esticar a fala até o fim do
      // bloco.
      const used = new Set<number>();
      for (const [offset, token] of modelSegment.entries()) {
        const exact = candidates.filter(
          (index) =>
            !used.has(index) &&
            timingWords[index].text === token.text &&
            captionAnchorDistance(index, segment.previous, segment.next) <= 3,
        );
        const candidate = exact.length > 0 ? exact[exact.length - 1] : null;
        if (candidate == null) continue;
        used.add(candidate);
        usedTimingIndexes.add(candidate);
        timingForModel.set(segment.modelStart + offset, candidate);
      }
      for (const [offset, token] of modelSegment.entries()) {
        if (timingForModel.has(segment.modelStart + offset)) continue;
        const boundary =
          segment.edge === 'end'
            ? segment.previous?.timingIndex
            : segment.next?.timingIndex;
        if (boundary == null) continue;
        const nearest = candidates
          .filter(
            (index) =>
              !used.has(index) &&
              captionTokenNear(token.text, timingWords[index].text),
          )
          .sort(
            (a, b) =>
              Math.abs(a - boundary) - Math.abs(b - boundary) ||
              a - b,
          )[0];
        if (nearest == null || Math.abs(nearest - boundary) > 3) continue;
        used.add(nearest);
        usedTimingIndexes.add(nearest);
        timingForModel.set(segment.modelStart + offset, nearest);
      }
    }
  }

  const out: Array<CaptionLine | null> = lines.map(() => null);
  lines.forEach((line, lineIndex) => {
    const indexes = modelTokenIndexes.get(lineIndex) ?? [];
    const timingIndexes = indexes
      .map((index) => timingForModel.get(index))
      .filter((index): index is number => index != null);
    const lineAnchors = anchors.filter(
      (anchor) => modelTokens[anchor.modelIndex].lineIndex === lineIndex,
    );
    if (lineAnchors.length === 0 || timingIndexes.length === 0) return;
    const startSec = Math.min(...timingIndexes.map((index) => timingWords[index].startSec));
    const endSec = Math.max(...timingIndexes.map((index) => timingWords[index].endSec));
    out[lineIndex] = {
      startSec,
      endSec: Math.max(startSec, endSec),
      text: line.text,
    };
  });
  const anchoredCount = out.filter((line) => line != null).length;

  // Fala sem par no whisper: fica no vão entre as vizinhas (o tempo do
  // modelo é chute; o vão é real). Sem vão, a fala é guardada com o
  // tempo do modelo — a legenda pode sumir, mas ela NUNCA invade a
  // fala seguinte.
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    const line = lines[i];
    const duration = Math.max(0.4, (line.endSec ?? 0) - (line.startSec ?? 0));
    let prev: CaptionLine | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (out[j]) {
        prev = out[j];
        break;
      }
    }
    let next: CaptionLine | null = null;
    for (let j = i + 1; j < out.length; j++) {
      if (out[j]) {
        next = out[j];
        break;
      }
    }
    let start = line.startSec;
    let end = line.endSec;
    if (prev && next && next.startSec - prev.endSec >= 0.3) {
      // O vão é real, mas uma legenda de 30s na tela é lixo: a fala
      // sem par ocupa só o começo do vão (o resto é silêncio).
      start = prev.endSec;
      end = Math.min(next.startSec, start + Math.min(duration, MAX_UNPAIRED_CAPTION_SEC));
    } else if (prev && !next) {
      start = Math.max(prev.endSec, line.startSec ?? prev.endSec);
      end = start + Math.min(duration, MAX_UNPAIRED_CAPTION_SEC);
    } else if (next && !prev) {
      // A fala vem DEPOIS da linha do modelo (o modelo antecipa): a
      // legenda precisa CABER antes da próxima fala — o fim é o
      // começo da próxima (nunca depois dela, senão invade a fala).
      end = next.startSec;
      start = Math.max(0, end - Math.min(duration, MAX_UNPAIRED_CAPTION_SEC));
    } else if (prev && next) {
      // Vão curto: a fala fica logo depois da anterior (e antes da
      // seguinte).
      start = prev.endSec;
      end = Math.max(start + 0.2, next.startSec);
    }
    out[i] = { startSec: start, endSec: end, text: line.text };
  }
  // As falas não se sobrepõem e não voltam atrás (a legenda queimada
  // precisa disso: o bloco termina quando o próximo começa).
  //
  // A ordem CRONOLÓGICA é só para o ajuste de sobreposição: quem casa
  // por posição usa o `order` (o índice de cada fala na ENTRADA) — sem
  // ele, um empate ou um fallback não monotônico trocava o tempo entre
  // duas falas.
  const indexed = out
    .map((line, i) => ({ line: line ?? { ...lines[i] }, index: i }))
    .sort((a, b) => a.line.startSec - b.line.startSec);
  for (let i = 0; i < indexed.length - 1; i++) {
    if (indexed[i].line.endSec > indexed[i + 1].line.startSec) {
      indexed[i].line.endSec = indexed[i + 1].line.startSec;
    }
  }
  return {
    lines: indexed.map((item) => item.line),
    order: indexed.map((item) => item.index),
    anchoredLines: anchoredCount,
    totalLines: lines.length,
  };
}

/**
 * Atalho que devolve só as linhas alinhadas.
 *
 * A versão detalhada expõe quantas falas ganharam uma âncora real; o
 * guardrail do pipeline usa esse número para não queimar uma legenda em
 * que o modelo e o áudio não se pareceram.
 */
export function alignCaptionTimings(
  textLines: CaptionLine[],
  timingLines: CaptionLine[],
  opts: { words?: CaptionWord[] } = {},
): CaptionLine[] {
  return alignCaptionTimingsDetailed(textLines, timingLines, opts).lines;
}

/**
 * Casa as palavras de conteúdo do modelo com as do áudio, em ordem.
 *
 * É um LCS ponderado: palavra igual vale 2 e grafia próxima vale 1.
 * Stopwords ficam de fora porque, sozinhas, elas não distinguem uma
 * fala da outra.
 */
function alignCaptionContentAnchors(
  model: Array<{ token: CaptionAlignmentToken; index: number }>,
  timing: Array<{ word: CaptionAlignmentWord; index: number }>,
): CaptionAlignmentPair[] {
  const n = model.length;
  const m = timing.length;
  if (n === 0 || m === 0) return [];
  const dp = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = Math.max(dp[i - 1][j], dp[i][j - 1]);
      if (captionTokensMatch(model[i - 1].token.text, timing[j - 1].word.text)) {
        const weight = model[i - 1].token.text === timing[j - 1].word.text ? 2 : 1;
        best = Math.max(best, dp[i - 1][j - 1] + weight);
      }
      dp[i][j] = best;
    }
  }

  const out: CaptionAlignmentPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const exact = model[i - 1].token.text === timing[j - 1].word.text;
    const fuzzy = captionTokensMatch(model[i - 1].token.text, timing[j - 1].word.text);
    if (fuzzy && dp[i][j] === dp[i - 1][j - 1] + (exact ? 2 : 1)) {
      out.push({ modelIndex: model[i - 1].index, timingIndex: timing[j - 1].index });
      i--;
      j--;
      continue;
    }
    if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return out.reverse();
}

/** Âncora global imediatamente anterior a um token do modelo. */
function previousCaptionAnchor(
  anchors: CaptionAlignmentPair[],
  modelIndex: number,
): CaptionAlignmentPair | undefined {
  let found: CaptionAlignmentPair | undefined;
  for (const anchor of anchors) {
    if (anchor.modelIndex >= modelIndex) break;
    found = anchor;
  }
  return found;
}

/** Âncora global imediatamente posterior a um token do modelo. */
function nextCaptionAnchor(
  anchors: CaptionAlignmentPair[],
  modelIndex: number,
): CaptionAlignmentPair | undefined {
  return anchors.find((anchor) => anchor.modelIndex > modelIndex);
}

/** Distância de uma palavra até a borda mais próxima do trecho. */
function captionAnchorDistance(
  timingIndex: number,
  previous?: CaptionAlignmentPair,
  next?: CaptionAlignmentPair,
): number {
  const distances: number[] = [];
  if (previous) distances.push(Math.abs(timingIndex - previous.timingIndex));
  if (next) distances.push(Math.abs(timingIndex - next.timingIndex));
  return distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

/**
 * Transcreve a legenda com o whisper.cpp LOCAL, com timestamps por
 * palavra e SEM VAD.
 *
 * O VAD comprime a linha do tempo (os silêncios pulados não voltam nos
 * offsets), o que adiantava as falas em segundos. As palavras reais do
 * `-ojf` mantêm o texto no tempo da fala.
 */
export async function transcribeWithWhisperCpp(
  audioPath: string,
  opts: { model?: string; timeoutMs?: number; language?: string } = {},
): Promise<ParsedTranscript | null> {
  const result = await transcribeWav(audioPath, {
    provider: 'whisper-cpp',
    model: opts.model || DEFAULT_CAPTION_WHISPER_MODEL,
    language: opts.language ?? 'auto',
    vad: false,
    words: true,
    maxSegmentChars: 32,
    timeoutMs: opts.timeoutMs,
  });
  const lines: CaptionLine[] = [];
  for (const seg of result.segments) {
    const text = normalizeCaptionText(seg.text);
    if (!text) continue;
    lines.push({ startSec: seg.startSec, endSec: seg.endSec, text });
  }
  if (lines.length === 0) return null;
  const words = (result.words ?? [])
    .map((word) => ({
      text: normalizeCaptionText(word.text),
      startSec: word.startSec,
      endSec: word.endSec,
    }))
    .filter(
      (word) =>
        word.text &&
        Number.isFinite(word.startSec) &&
        Number.isFinite(word.endSec),
    );
  return {
    lines,
    ...(words.length ? { words } : {}),
    language: result.language ?? null,
    translated: false,
  };
}

/** Resultado do casamento entre o texto do modelo e o tempo do áudio. */
export interface CaptionTimingProjection {
  /** Linhas finais: o texto do modelo com o tempo real do áudio. */
  lines: CaptionLine[];
  /** Falas que casaram com o áudio. */
  anchoredLines: number;
  /** Total de falas do texto. */
  totalLines: number;
  /** O tempo veio do texto ORIGINAL e foi projetado no traduzido. */
  projected: boolean;
}

/**
 * Casa o texto do modelo com o TEMPO real do áudio (função PURA).
 *
 * O texto que casa com o áudio é o ORIGINAL (mesmo idioma da fala): o
 * provider local transcreve no idioma do áudio (`-l auto`) e o texto do
 * modelo pode estar TRADUZIDO (pt-BR) — texto em português não casa com
 * palavras em inglês, o LCS não acha âncora e o alinhamento erra o
 * tempo de todas as falas.
 *
 * A saída do Gemini traz as duas versões na MESMA ordem (`text` e
 * `text_pt` são o mesmo instante): então o tempo é casado no original e
 * PROJETADO na fala traduzida pelo índice.
 *
 * Sem original (ou com quantidades diferentes), o texto do modelo é
 * alinhado direto — e o chamador decide se o casamento foi bom o
 * suficiente (fail-closed no `alignWithTimingProvider`).
 */
export function projectCaptionTiming(
  parsed: Pick<
    ParsedTranscript,
    'lines' | 'originalLines' | 'translated' | 'partialTranslation'
  >,
  timingLines: CaptionLine[],
  opts: { words?: CaptionWord[] } = {},
): CaptionTimingProjection {
  const original = parsed.originalLines;
  const projected =
    (parsed.translated || parsed.partialTranslation === true) &&
    Array.isArray(original) &&
    original.length > 0 &&
    original.length === parsed.lines.length;
  const textForTiming = projected ? (original as CaptionLine[]) : parsed.lines;
  const alignment = alignCaptionTimingsDetailed(textForTiming, timingLines, {
    words: opts.words,
  });
  if (!projected) {
    return {
      lines: alignment.lines,
      anchoredLines: alignment.anchoredLines,
      totalLines: alignment.totalLines,
      projected: false,
    };
  }
  // O texto traduzido fica; o tempo vem do casamento do original.
  //
  // O alinhamento devolve as linhas em ordem CRONOLÓGICA: o índice de
  // cada fala no texto original vem no `order`. Sem esse mapa, um
  // empate de tempo (ou um fallback não monotônico) trocava o tempo
  // entre duas falas — a legenda aparecia antes da voz.
  const byInputIndex = new Map<number, CaptionLine>();
  alignment.order.forEach((inputIndex, position) => {
    const anchor = alignment.lines[position];
    if (anchor) byInputIndex.set(inputIndex, anchor);
  });
  const lines = parsed.lines.map((line, index) => {
    const anchor = byInputIndex.get(index);
    if (!anchor) return { ...line };
    return {
      ...line,
      startSec: anchor.startSec,
      endSec: anchor.endSec,
    };
  });
  return {
    lines,
    anchoredLines: alignment.anchoredLines,
    totalLines: alignment.totalLines,
    projected: true,
  };
}

/**
 * Erro que carrega a TRANSCRIÇÃO já paga.
 *
 * O alinhamento com o tempo real roda DEPOIS da transcrição: se ele
 * falha, a transcrição (cota do Gemini) não pode ser perdida — a
 * próxima rodada tem que refazer só o tempo.
 */
export class CaptionTranscriptError extends Error {
  readonly transcript: CaptionTranscriptCache;
  constructor(message: string, transcript: CaptionTranscriptCache) {
    super(message);
    this.name = 'CaptionTranscriptError';
    this.transcript = transcript;
  }
}

/**
 * A transcrição que o erro carrega (a que JÁ foi paga).
 *
 * Puro: o chamador guarda essa transcrição no marker e a próxima
 * rodada refaz só o tempo real — sem chamar o Gemini de novo.
 */
export function salvagedCaptionTranscript(
  error: unknown,
): CaptionTranscriptCache | null {
  if (!error || typeof error !== 'object') return null;
  const transcript = (error as { transcript?: CaptionTranscriptCache }).transcript;
  if (!transcript || !Array.isArray(transcript.lines) || transcript.lines.length === 0) {
    return null;
  }
  return transcript;
}

/**
 * Transcrição crua no formato do cache do marker.
 *
 * O `rawLines` é o texto ANTES das correções e da revisão: é o que o
 * re-render reaproveita (regra nova vale). A transcrição que veio do
 * Gemini ainda não passou por nenhum passe — ela É o texto cru.
 *
 * Texto estrangeiro SEM tradução fica sem `rawLines`: as correções do
 * dono são escritas em português e corromperiam o texto original.
 */
export function captionCacheFromParsed(
  parsed: ParsedTranscript,
  provider: CaptionProvider,
): CaptionTranscriptCache {
  const effective = captionEffectiveLanguage(
    parsed.language,
    parsed.lines.map((line) => line.text).join(' '),
  );
  const stillForeign = effective.needsTranslation && !parsed.translated;
  return {
    provider,
    language: parsed.language ?? null,
    translated: parsed.translated === true,
    timingSource: parsed.timingSource ?? 'model',
    lines: parsed.lines,
    ...(parsed.originalLines?.length ? { originalLines: parsed.originalLines } : {}),
    ...(stillForeign
      ? {}
      : { rawLines: parsed.lines.map((line) => ({ ...line })) }),
    ...(stillForeign || !parsed.originalLines?.length
      ? {}
      : { rawOriginalLines: parsed.originalLines.map((line) => ({ ...line })) }),
  };
}

/**
 * Casa o texto do modelo de linguagem com o TEMPO real do whisper
 * local.
 *
 * Sem provider de tempo configurado, a legenda sai como o modelo falou
 * — com o tempo inventado por ele.
 *
 * Quando o provider de tempo é pedido, ele é REQUIRED só no caso em
 * que ele tem algo a dizer: se ele devolveu transcrição VAZIA (o
 * whisper local é mudo no áudio, mas o Gemini ouviu a fala), a legenda
 * segue com o tempo do modelo — perder o Short por causa do tempo é
 * pior que um tempo imperfeito. Já quando o provider devolveu tempo,
 * mas o texto do modelo não se parece com o áudio (poucas âncoras),
 * os tempos reais não servem para este texto: aí o Short espera a
 * próxima rodada.
 */
async function alignWithTimingProvider(
  parsed: ParsedTranscript,
  audioPath: string,
  opts: {
    provider: 'whisper-cpp' | null;
    model: string;
    timeoutMs: number;
    transcriber?: CaptionProviderFn;
  },
): Promise<ParsedTranscript> {
  if (!opts.provider) return parsed;
  const log = getLogger().child({ feature: 'short-captions' });
  try {
    const timing = opts.transcriber
      ? await opts.transcriber(audioPath, 0, null)
      : await transcribeWithWhisperCpp(audioPath, {
          model: opts.model,
          timeoutMs: opts.timeoutMs,
        });
    if (!timing || timing.lines.length === 0) {
      // O provider de tempo NÃO achou fala no áudio. O tempo do modelo
      // é imperfeito, mas o Short não pode ser perdido por isso: o
      // silêncio do whisper local NÃO é final (o Gemini pode ter
      // ouvido a fala) e o alinhamento roda o provider local de novo.
      log.warn(
        { tempo: opts.provider },
        'provider de tempo não achou fala no áudio — a legenda segue com o tempo do modelo',
      );
      return { ...parsed, timingSource: parsed.timingSource ?? 'model' };
    }
    /**
     * O TEXTO que casa com o áudio é o ORIGINAL (mesmo idioma da fala).
     *
     * O provider local transcreve no idioma do áudio (`-l auto`); o texto
     * do modelo pode estar TRADUZIDO (pt-BR) — e texto em português não
     * casa com palavras em inglês: o LCS não acha âncora e o alinhamento
     * "erra" o tempo de todas as falas.
     *
     * A saída do Gemini traz as duas versões na MESMA ordem (`text` e
     * `text_pt` são o mesmo instante): então o tempo é casado no original
     * e projetado na fala traduzida pelo índice.
     */
    const projection = projectCaptionTiming(parsed, timing.lines, {
      words: timing.words,
    });
    const matchRatio =
      projection.totalLines > 0
        ? projection.anchoredLines / projection.totalLines
        : 0;
    // Poucas âncoras significa que o texto do modelo e o áudio não se
    // pareceram. Queimar os tempos do modelo nesse caso só troca um
    // defeito por outro: o Short espera a próxima rodada.
    if (matchRatio < 0.25) {
      // A transcrição JÁ foi paga (cota do Gemini): ela viaja no erro
      // para o cache do marker — a próxima rodada refaz só o tempo.
      throw new CaptionTranscriptError(
        `provider de tempo casou só ${projection.anchoredLines}/${projection.totalLines} falas`,
        captionCacheFromParsed(parsed, 'gemini'),
      );
    }
    log.info(
      {
        linhas: projection.lines.length,
        ancoradas: projection.anchoredLines,
        tempo: opts.provider,
        projetado: projection.projected,
      },
      'legenda alinhada com o tempo real do áudio',
    );
    return {
      ...parsed,
      lines: projection.lines,
      timingSource: 'whisper',
    };
  } catch (e) {
    log.warn(
      { err: String(e).slice(0, 200) },
      'não deu para alinhar o tempo da legenda — o Short fica para a próxima rodada',
    );
    throw e;
  }
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
  const whisperModel = opts.whisperModel || DEFAULT_CAPTION_WHISPER_MODEL;
  const dedicatedModel = opts.dedicatedModel || CAPTION_DEDICATED_MODEL;
  const silenceFinal = opts.silenceFinal !== false;
  const providers = captionProviders(opts.order);
  const log = getLogger().child({ feature: 'short-captions' });
  // Provider escrito errado (typo no .env) não pode passar em silêncio:
  // a ordem real é outra e o dono precisa saber.
  const pedido = String(opts.order ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const desconhecidos = pedido.filter(
    (p) => !providers.includes(p as CaptionProvider),
  );
  if (desconhecidos.length > 0) {
    log.warn(
      { desconhecidos, ordem: providers.join(',') },
      'provider de transcrição desconhecido na ordem — foi ignorado',
    );
  }
  // O vocabulário/correções do repo entram em TODA transcrição: o que o
  // dono corrige uma vez vale para todos os Shorts seguintes.
  const vocabulary = loadCaptionVocabulary(opts.vocabularyFile);
  const corrections = loadCaptionCorrections(opts.correctionsFile);
  // Arquivo ausente/corrompido = legenda sem correção, em silêncio. O
  // dono precisa saber (o arquivo é a fonte da verdade das regras).
  if (vocabulary.length === 0) {
    log.warn(
      { arquivo: opts.vocabularyFile ?? 'assets/caption-vocabulary.txt' },
      'vocabulário da legenda vazio ou ilegível — a legenda sai sem os nomes do repo',
    );
  }
  if (corrections.length === 0) {
    log.warn(
      { arquivo: opts.correctionsFile ?? 'assets/caption-corrections.txt' },
      'correções da legenda vazias ou ilegíveis — a legenda sai sem as regras do dono',
    );
  }
  // Os passes de IA (revisor/tradutor) só usam o Gemini real quando ele
  // está configurado E não há transcritor injetado (teste = sem rede).
  const useGemini = !!opts.geminiApiKey && !opts.transcribers;
  const refiner: CaptionRefinerFn | null =
    opts.refine === false
      ? null
      : (opts.geminiRefiner ??
        (!useGemini
          ? null
          : (lines, context) =>
              refineCaptionLines(lines, {
                apiKey: opts.geminiApiKey as string,
                model: geminiModel,
                timeoutMs,
                context,
                vocabulary,
                attempts: opts.geminiAttempts,
                retryDelayMs: opts.geminiRetryMs,
              })));
  const translator: CaptionTranslatorFn | null =
    opts.translate === false
      ? null
      : (opts.geminiTranslator ??
        (!useGemini
          ? null
          : (lines, language, context) =>
              translateCaptionLines(lines, {
                apiKey: opts.geminiApiKey as string,
                model: geminiModel,
                timeoutMs,
                language,
                context,
                vocabulary,
                attempts: opts.geminiAttempts,
                retryDelayMs: opts.geminiRetryMs,
              })));
  const transcriber: CaptionTranscriber = async (
    audioPath: string,
    durSec: number,
    context?: CaptionContext | null,
    cached?: CaptionTranscript | null,
  ): Promise<CaptionTranscript | null> => {
    transcriber.lastNoSpeechFrom = null;
    /**
     * Pós-processamento comum a QUALQUER provider, na ordem que não
     * estraga o texto:
     *
     * 1. TRADUÇÃO (o áudio estrangeiro vira pt-BR) — antes das regras
     *    do repo, porque elas são escritas em português: corrigir texto
     *    estrangeiro quebra palavra comum ("what a twist" → "Twistzz");
     * 2. CORREÇÕES do dono (regras literais, determinísticas);
     * 3. REVISÃO LLM (o passe que corrige nome/termo) — por último, e as
     *    regras passam de novo depois (o revisor pode reintroduzir uma
     *    forma errada).
     *
     * Falha de revisor/tradutor não derruba a legenda: o texto anterior
     * é o plano B. A tradução que falhou, porém, MARCA o Short como
     * "não traduzido" (a legenda em inglês não vai ao ar).
     */
    const finalize = async (
      parsed: ParsedTranscript,
      provider: CaptionProvider,
      offsetSec = 0,
    ): Promise<CaptionTranscript> => {
      const degraded: CaptionDegraded[] = [];
      const applied: string[] = [];
      let lines = parsed.lines;
      let translated = parsed.translated;
      let originalLines = parsed.originalLines;
      const timingSource =
        parsed.timingSource ??
        (provider === 'whisper-cpp' || provider === 'huggingface'
          ? 'whisper'
          : 'model');
      // O idioma que vale é o do provider CONFIRMADO pelo texto: gíria
      // em inglês não faz o áudio ser inglês (e o provider que erra o
      // idioma não pode segurar Short bom).
      const effective = captionEffectiveLanguage(
        parsed.language,
        lines.map((line) => line.text).join(' '),
      );
      const needsTranslation = effective.needsTranslation;
      // A tradução foi PEDIDA? `translate=false` é o dono aceitando a
      // legenda no idioma original — aí o Short NÃO é segurado.
      const translateRequested = opts.translate !== false;
      // A tradução FALHOU (erro/resposta inútil) ou só não tinha o que
      // traduzir? A diferença decide se o Short é segurado: falhou dá
      // para tentar de novo; "não mudou nada" é fala de nome/gíria e
      // segurar ali seria segurar Short bom.
      let translateFailed = false;
      if (parsed.partialTranslation) {
        log.warn(
          { linhas: lines.length },
          'a transcrição veio traduzida pela metade — o tradutor roda por cima',
        );
      }
      if (translator && !translated && needsTranslation) {
        try {
          // A sentinela de "estrangeiro sem nome" não vai para o prompt:
          // o tradutor recebe o idioma que o provider disse (ou nada).
          const out = await translator(
            lines,
            captionPromptLanguage(effective.language),
            context,
          );
          if (out && out.lines.length === lines.length) {
            if (out.outcome === 'translated') {
              // O `.orig.txt` guarda o que foi FALADO: quando a
              // transcrição veio traduzida pela metade, o original é o
              // do provider — não o texto misto que o tradutor viu.
              originalLines = parsed.originalLines ?? lines;
              lines = out.lines;
              translated = true;
            } else {
              // O tradutor devolveu as MESMAS falas: não há o que
              // traduzir (fala só de nome/gíria). Não é falha — segurar
              // o Short aqui seria segurar Short bom.
              log.info(
                { linhas: lines.length },
                'a tradução não mudou nada (fala só de nome/gíria)',
              );
            }
          } else {
            translateFailed = true;
          }
        } catch (e) {
          translateFailed = true;
          log.warn(
            { err: String(e).slice(0, 200) },
            'tradução da legenda falhou — mantendo o idioma original',
          );
        }
      }
      // Tradução pedida e não entregue: o Short sai degradado.
      if (translateFailed && !degraded.includes('translate')) {
        degraded.push('translate');
      }
      // Correções do dono (aplicadas uma vez por passo, com regex já
      // compilada). As regras são escritas em português: se a legenda
      // ainda está no idioma original, aplicá-las corromperia o texto
      // estrangeiro ("what a twist" → "what a Twistzz").
      const stillForeign = needsTranslation && !translated;
      // O texto ANTES das correções e da revisão: é o que o marker
      // guarda (assim regra nova/alterada vale no re-render).
      const rawLines = stillForeign ? undefined : lines.map((line) => ({ ...line }));
      const rawOriginalLines = stillForeign
        ? undefined
        : originalLines?.map((line) => ({ ...line }));
      if (!stillForeign) {
        lines = applyCaptionCorrections(lines, corrections, {
          contextNames: captionContextNames(context),
          applied,
        });
      }
      // O revisor NÃO roda em texto estrangeiro: as regras do repo são
      // em português (aplicá-las em inglês corromperia o texto) e ele
      // gastaria cota "aperfeiçoando" uma fala que vai ser traduzida.
      if (refiner && lines.length > 0 && !stillForeign) {
        try {
          const refined = await refiner(lines, context);
          if (refined && refined.length === lines.length) {
            lines = applyCaptionCorrections(refined, corrections, {
              contextNames: captionContextNames(context),
              applied,
            });
          }
        } catch (e) {
          degraded.push('refine');
          log.warn(
            { err: String(e).slice(0, 200) },
            'revisão da legenda falhou — mantendo a transcrição',
          );
        }
      }
      // O áudio era estrangeiro e a legenda ficou no idioma original.
      // O Short é segurado quando a tradução foi PEDIDA e não saiu:
      // - a tradução falhou de verdade (a próxima rodada tenta de novo);
      // - não há tradutor configurado (sem chave/ordem) — a legenda em
      //   inglês não vai ao ar (o dono pode forçar com --allow-no-captions).
      // Quando a tradução não tinha o que fazer (fala só de nome/gíria)
      // ou o dono desligou a tradução, o Short NÃO é segurado.
      const untranslated = needsTranslation && !translated;
      if (untranslated) {
        if (!degraded.includes('translate')) degraded.push('translate');
        if (!translator) {
          log.warn(
            { idioma: effective.language },
            translateRequested
              ? 'áudio estrangeiro sem tradutor configurado — o Short fica para a próxima rodada'
              : 'áudio estrangeiro sem tradutor (tradução desligada) — a legenda vai no idioma original',
          );
        } else if (!translateFailed) {
          // A tradução rodou e devolveu as mesmas falas: não há o que
          // traduzir. Não é falha — o Short não é segurado.
          log.info(
            { idioma: effective.language },
            'fala estrangeira sem nada a traduzir — a legenda vai no idioma original',
          );
        }
      }
      const holdUntranslated =
        untranslated && translateRequested && (translateFailed || !translator);
      // O tempo cortado no silêncio inicial volta aqui: o tempo da
      // legenda é sempre do Short, não do áudio trimmed.
      const shift = (line: CaptionLine): CaptionLine =>
        offsetSec > 0
          ? {
              ...line,
              startSec: line.startSec + offsetSec,
              endSec: line.endSec + offsetSec,
            }
          : line;
      const timed = lines.map(shift);
      // O texto ORIGINAL (antes da tradução) também é do Short: sem o
      // deslocamento, o `.orig.txt` ficava com os tempos do áudio cortado.
      const timedOriginal = originalLines?.map(shift);
      return {
        lines: timed,
        language: parsed.language,
        translated,
        provider,
        timingSource,
        // O texto CRU (antes das correções e da revisão) é o que o marker
        // guarda: é ele que permite regra nova/alterada no re-render.
        ...(rawLines ? { rawLines } : {}),
        ...(timedOriginal ? { originalLines: timedOriginal } : {}),
        ...(rawOriginalLines ? { rawOriginalLines } : {}),
        ...(degraded.length ? { degraded } : {}),
        ...(holdUntranslated ? { untranslated: true } : {}),
        ...(applied.length ? { correctionsApplied: applied } : {}),
      };
    };
    let sawFailure = false;
    let sawSilence = false;
    let lastError = '';
    let lastUnavailable = '';
    let lastSilentProvider: CaptionProvider | null = null;
    /**
     * Transcrição que JÁ foi paga e não pode ser perdida: ela sobrevive
     * à falha do alinhamento (cota do Gemini não se repete).
     */
    let salvaged: CaptionTranscriptCache | undefined;
    // O provider local pode ter falhado ANTES do Gemini e ainda assim
    // é indispensável como provider de TEMPO. "Já foi tentado" não é
    // "já entregou o tempo real": quando faltou o tempo, ele roda de
    // novo. O custo de uma segunda passada é menor que queimar uma
    // legenda com os tempos inventados pelo modelo.
    /**
     * Retoma do passo que falhou: com a transcrição guardada no marker
     * da rodada anterior, o provider de transcrição NÃO é chamado
     * (economiza cota do Gemini e o tempo do whisper) — só a tradução
     * e a revisão rodam de novo.
     *
     * O texto guardado é o CRU (`rawLines`): as correções do dono e a
     * revisão são aplicadas DE NOVO por cima dele, então uma regra nova
     * (ou uma regra apagada) vale no re-render.
     */
    const cachedRaw = cached?.rawLines?.length ? cached.rawLines : null;
    const cachedLines = cached?.lines?.length ? cached.lines : null;
    // O silêncio do COMEÇO do áudio sai antes da transcrição: o whisper
    // ancora a primeira fala no começo do arquivo e a legenda aparece
    // antes de quem fala. O tempo cortado volta nas falas (offset).
    //
    // O corte é DETERMINÍSTICO (mesmo áudio → mesmo offset): por isso
    // ele vale para o texto CRU guardado no marker (que está no tempo
    // do áudio, sem o offset).
    const trimmed =
      cachedLines && !cachedRaw ? null : await trimLeadingSilence(audioPath);
    const sourcePath = trimmed?.path ?? audioPath;
    const offsetSec = trimmed?.offsetSec ?? 0;
    try {
      if (cachedLines && cached) {
        log.info(
          {
            linhas: cachedLines.length,
            provider: cached.provider,
            cru: cachedRaw ? cachedRaw.length : 0,
          },
          'reaproveitando a transcrição guardada na rodada anterior',
        );
        const cachedProvider = captionProviderFrom(cached.provider);
        const cachedParsed: ParsedTranscript = {
          lines: cachedRaw ?? cachedLines,
          language: cached.language ?? null,
          translated: cached.translated === true,
          // De onde veio o tempo das falas guardadas: com o tempo do
          // whisper já queimado, o alinhamento NÃO roda de novo (o
          // provider local leva ~47s e o resultado seria o mesmo).
          ...(cached.timingSource ? { timingSource: cached.timingSource } : {}),
          // O texto ORIGINAL (antes da tradução) vem junto do CRU: sem
          // ele, o `.orig.txt` do re-render perderia o idioma de fora.
          ...(cachedRaw
            ? cached.rawOriginalLines?.length
              ? { originalLines: cached.rawOriginalLines }
              : {}
            : cached.originalLines?.length
              ? { originalLines: cached.originalLines }
              : {}),
        };
        // O cache do Gemini pode ter sido gravado com os tempos
        // inventados pelo modelo. O tempo real é refeito SEM chamar o
        // Gemini de novo: só o provider local de tempo roda.
        const timingJaReal = cached.timingSource === 'whisper';
        const alignedCached =
          cachedRaw && cachedProvider === 'gemini' && !timingJaReal
            ? await alignWithTimingProvider(cachedParsed, sourcePath, {
                provider: opts.timingProvider ?? null,
                model: opts.timingModel ?? whisperModel,
                timeoutMs,
                transcriber: opts.transcribers?.['whisper-cpp'],
              })
            : cachedParsed;
        return await finalize(
          alignedCached,
          cachedProvider,
          // O texto CRU está no tempo do áudio (sem o offset): o
          // deslocamento do silêncio inicial tem que ser aplicado de
          // novo. O texto já corrigido (marker antigo, sem `rawLines`)
          // vem com o offset dentro — somar de novo deslocaria a
          // legenda.
          cachedRaw ? offsetSec : 0,
        );
      }
      if (trimmed) {
        log.info(
          { offsetSec },
          'silêncio inicial cortado antes da transcrição (a legenda não nasce antes da voz)',
        );
      }
      for (const [providerIndex, provider] of providers.entries()) {
        const startedAt = Date.now();
        /**
         * O silêncio do provider LOCAL (whisper.cpp sem VAD) NÃO é final:
         * com `-sns` e o filtro de alucinação, um falso-negativo mataria
         * a legenda do Short inteiro (e o provider seguinte — que OUVE o
         * áudio — é quem decide se alguém falou).
         *
         * O silêncio de um provider remoto (Gemini/HuggingFace) é final:
         * é ele que sabe se havia fala.
         */
        const silenceIsFinal = (): boolean => {
          if (!silenceFinal) return false;
          if (provider !== 'whisper-cpp') return true;
          return providerIndex + 1 >= providers.length;
        };
        try {
          if (provider === 'gemini') {
          if (!opts.geminiApiKey && !opts.transcribers?.gemini) {
            log.info('gemini sem GEMINI_API_KEY — pulando');
            lastUnavailable = 'gemini sem GEMINI_API_KEY';
            continue;
          }
          let parsed: ParsedTranscript | null = null;
          try {
            parsed = opts.transcribers?.gemini
              ? await opts.transcribers.gemini(sourcePath, durSec, context)
              : await transcribeWithGemini(sourcePath, {
                  apiKey: opts.geminiApiKey as string,
                  model: geminiModel,
                  timeoutMs,
                  durSec,
                  context,
                  vocabulary,
                  translate: opts.translate !== false,
                  attempts: opts.geminiAttempts,
                  retryDelayMs: opts.geminiRetryMs,
                });
          } catch (e) {
            // Cota do free tier (20 generate_content/dia): o modelo
            // dedicado de transcrição NÃO conta nessa cota — é outra
            // métrica — então a legenda continua mesmo sem o modelo de
            // texto (que é o que traduz o áudio estrangeiro).
            if (!isQuotaError(e)) throw e;
            log.warn(
              { err: String((e as { message?: string })?.message ?? e).slice(0, 160) },
              'cota do Gemini — usando o modelo dedicado de transcrição',
            );
            parsed = opts.dedicatedTranscriber
              ? await opts.dedicatedTranscriber(sourcePath, durSec, context)
              : await transcribeWithGeminiDedicated(sourcePath, {
                  apiKey: opts.geminiApiKey as string,
                  model: dedicatedModel,
                  timeoutMs,
                  durSec,
                  vocabulary,
                  context,
                });
          }
          if (!parsed) {
            // Silêncio é estado FINAL por padrão (repetir não muda
            // nada). Com `silenceFinal: false` o próximo provider é
            // consultado: um falso-negativo do Gemini (devolveu vazio
            // num áudio com fala) não pode matar a legenda.
            log.warn('gemini devolveu transcrição vazia — o Short sai sem legenda');
            lastSilentProvider = provider;
            if (silenceIsFinal()) {
              // ...mas, se um provider JÁ falhou com erro de verdade, o
              // erro manda: o Short espera a próxima rodada.
              if (sawFailure) break;
              transcriber.lastNoSpeechFrom = provider;
              return null;
            }
            sawSilence = true;
            continue;
          }
          const aligned = await alignWithTimingProvider(parsed, sourcePath, {
            provider: opts.timingProvider ?? null,
            model: opts.timingModel ?? whisperModel,
            timeoutMs,
            transcriber: opts.transcribers?.['whisper-cpp'],
          });
          const result = await finalize(aligned, provider, offsetSec);
          log.info(
            {
              provider,
              linhas: result.lines.length,
              idioma: result.language,
              traduzida: result.translated,
              duracaoMs: Date.now() - startedAt,
            },
            'legenda transcrita',
          );
          return result;
        }
        if (provider === 'whisper-cpp') {
          const parsed = opts.transcribers?.['whisper-cpp']
            ? await opts.transcribers['whisper-cpp'](sourcePath, durSec, context)
            : await transcribeWithWhisperCpp(sourcePath, {
                model: whisperModel,
                timeoutMs,
              });
          if (!parsed) {
            // O silêncio do LOCAL não é final (ver `silenceIsFinal`): o
            // provider seguinte é quem decide se havia fala.
            log.warn('whisper.cpp devolveu transcrição vazia — o Short sai sem legenda');
            lastSilentProvider = provider;
            if (silenceIsFinal()) {
              if (sawFailure) break;
              transcriber.lastNoSpeechFrom = provider;
              return null;
            }
            sawSilence = true;
            continue;
          }
          const result = await finalize(parsed, provider, offsetSec);
          log.info(
            {
              provider,
              linhas: result.lines.length,
              idioma: result.language,
              traduzida: result.translated,
              duracaoMs: Date.now() - startedAt,
            },
            'legenda transcrita',
          );
          return result;
        }
        if (!opts.hfToken && !opts.transcribers?.huggingface) {
          log.info('huggingface sem HF_TOKEN — pulando');
          lastUnavailable = 'huggingface sem HF_TOKEN';
          continue;
        }
        const parsed = opts.transcribers?.huggingface
          ? await opts.transcribers.huggingface(sourcePath, durSec, context)
          : await transcribeWithHuggingface(sourcePath, {
              token: opts.hfToken as string,
              model: hfModel,
              timeoutMs,
            });
        if (!parsed) {
          // Silêncio é estado FINAL por padrão (ver o caminho do
          // Gemini); com `silenceFinal: false` o próximo provider é
          // consultado.
          log.warn('huggingface devolveu transcrição vazia — o Short sai sem legenda');
          lastSilentProvider = provider;
          if (silenceIsFinal()) {
            if (sawFailure) break;
            transcriber.lastNoSpeechFrom = provider;
            return null;
          }
          sawSilence = true;
          continue;
        }
        // O HuggingFace já devolve o tempo real de cada fala (é um
        // whisper): realinhar com o whisper local só gastaria tempo.
        const result = await finalize(parsed, provider, offsetSec);
        log.info(
          {
            provider,
            linhas: result.lines.length,
            duracaoMs: Date.now() - startedAt,
          },
          'legenda transcrita',
        );
        return result;
      } catch (e) {
        sawFailure = true;
        lastError = String(e).slice(0, 200);
        // A transcrição que JÁ foi paga (cota do Gemini) não pode ser
        // perdida: ela viaja no erro até o cache do marker.
        salvaged ??= salvagedCaptionTranscript(e) ?? undefined;
        log.warn(
          { provider, err: lastError },
          'provider de transcrição falhou',
        );
      }
      }
    } finally {
      // O áudio trimmed é temporário: ele some junto com o WAV.
      if (trimmed) {
        try {
          fs.rmSync(trimmed.path, { force: true });
        } catch {
          // best-effort
        }
      }
    }
    if (sawFailure) {
      // Falha de verdade (cota/chave/timeout/truncagem): o Short fica
      // marcado para nova tentativa na próxima rodada.
      const message = `nenhum provider de transcrição respondeu: ${lastError || 'erro'}`;
      // A transcrição que já foi paga viaja no erro: o marker a guarda e
      // a próxima rodada refaz só o tempo real (sem chamar o Gemini).
      if (salvaged) throw new CaptionTranscriptError(message, salvaged);
      throw new Error(message);
    }
    // Todos os providers responderam "ninguém falou" (e ninguém falhou):
    // silêncio de verdade, estado final — o Short sai sem legenda.
    if (sawSilence) {
      transcriber.lastNoSpeechFrom = lastSilentProvider;
      return null;
    }
    // Nenhum provider respondeu e nenhum calou: nenhum está configurado.
    throw new Error(
      `nenhum provider de transcrição configurado (${lastUnavailable || 'sem chave'})`,
    );
  };
  return transcriber;
}
