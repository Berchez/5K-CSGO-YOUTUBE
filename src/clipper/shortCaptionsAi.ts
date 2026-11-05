import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';
import { repoPath } from '../paths.js';
import { transcribeWav } from '../transcription/transcribe.js';
import { resolveFfmpegBin } from './segmentProbe.js';
import { normalizeCaptionText, type CaptionLine } from './shortCaptions.js';

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
  'defuse',
  'plant',
  'push',
  'rush',
  'trade',
  'wallbang',
  'one-tap',
  'spray',
  'site',
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
}

export interface ParsedTranscript {
  lines: CaptionLine[];
  language: string | null;
  /** A legenda saiu traduzida para português? */
  translated: boolean;
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

export type CaptionTranscriber = (
  audioPath: string,
  durSec: number,
  context?: CaptionContext | null,
  /**
   * Transcrição da rodada anterior (guardada no marker): quando ela
   * existe, o provider NÃO é chamado — só a tradução/revisão rodam de
   * novo (é o que retoma do passo que falhou).
   */
  cached?: CaptionTranscript | null,
) => Promise<CaptionTranscript | null>;

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
  },
): Promise<ParsedTranscript | null> {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const audio = fs.readFileSync(audioPath);
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const translate = opts.translate !== false;
  const run = (async () => {
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
  const run = (async () => {
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
  })();
  return withTimeout(run, opts.timeoutMs, label);
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
  return { lines, language: result.language ?? null, translated: false };
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
              })));
  return async (
    audioPath: string,
    durSec: number,
    context?: CaptionContext | null,
    cached?: CaptionTranscript | null,
  ): Promise<CaptionTranscript | null> => {
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
    ): Promise<CaptionTranscript> => {
      const degraded: CaptionDegraded[] = [];
      const applied: string[] = [];
      let lines = parsed.lines;
      let translated = parsed.translated;
      let originalLines = parsed.originalLines;
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
      return {
        lines,
        language: parsed.language,
        translated,
        provider,
        ...(originalLines ? { originalLines } : {}),
        ...(degraded.length ? { degraded } : {}),
        ...(holdUntranslated ? { untranslated: true } : {}),
        ...(applied.length ? { correctionsApplied: applied } : {}),
      };
    };
    /**
     * Retoma do passo que falhou: com a transcrição guardada no marker
     * da rodada anterior, o provider de transcrição NÃO é chamado
     * (economiza cota do Gemini e o tempo do whisper) — só a tradução
     * e a revisão rodam de novo.
     */
    if (cached && Array.isArray(cached.lines) && cached.lines.length > 0) {
      log.info(
        { linhas: cached.lines.length, provider: cached.provider },
        'reaproveitando a transcrição guardada na rodada anterior',
      );
      return finalize(
        {
          lines: cached.lines,
          language: cached.language ?? null,
          translated: cached.translated === true,
          ...(cached.originalLines?.length
            ? { originalLines: cached.originalLines }
            : {}),
        },
        captionProviderFrom(cached.provider),
      );
    }
    let sawFailure = false;
    let sawSilence = false;
    let lastError = '';
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
          let parsed: ParsedTranscript | null = null;
          try {
            parsed = opts.transcribers?.gemini
              ? await opts.transcribers.gemini(audioPath, durSec, context)
              : await transcribeWithGemini(audioPath, {
                  apiKey: opts.geminiApiKey as string,
                  model: geminiModel,
                  timeoutMs,
                  durSec,
                  context,
                  vocabulary,
                  translate: opts.translate !== false,
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
              ? await opts.dedicatedTranscriber(audioPath, durSec, context)
              : await transcribeWithGeminiDedicated(audioPath, {
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
            if (silenceFinal) {
              // ...mas, se um provider JÁ falhou com erro de verdade, o
              // erro manda: o Short espera a próxima rodada.
              if (sawFailure) break;
              return null;
            }
            sawSilence = true;
            continue;
          }
          const result = await finalize(parsed, provider);
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
            ? await opts.transcribers['whisper-cpp'](audioPath, durSec, context)
            : await transcribeWithWhisperCpp(audioPath, {
                model: whisperModel,
                timeoutMs,
              });
          if (!parsed) {
            // Silêncio é estado FINAL por padrão (ver o caminho do
            // Gemini); com `silenceFinal: false` o próximo provider é
            // consultado.
            log.warn('whisper.cpp devolveu transcrição vazia — o Short sai sem legenda');
            if (silenceFinal) {
              if (sawFailure) break;
              return null;
            }
            sawSilence = true;
            continue;
          }
          const result = await finalize(parsed, provider);
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
          ? await opts.transcribers.huggingface(audioPath, durSec, context)
          : await transcribeWithHuggingface(audioPath, {
              token: opts.hfToken as string,
              model: hfModel,
              timeoutMs,
            });
        if (!parsed) {
          // Silêncio é estado FINAL por padrão (ver o caminho do
          // Gemini); com `silenceFinal: false` o próximo provider é
          // consultado.
          log.warn('huggingface devolveu transcrição vazia — o Short sai sem legenda');
          if (silenceFinal) {
            if (sawFailure) break;
            return null;
          }
          sawSilence = true;
          continue;
        }
        const result = await finalize(parsed, provider);
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
    // Todos os providers responderam "ninguém falou" (e ninguém falhou):
    // silêncio de verdade, estado final — o Short sai sem legenda.
    if (sawSilence) return null;
    // Nenhum provider respondeu e nenhum calou: nenhum está configurado.
    throw new Error(
      `nenhum provider de transcrição configurado (${lastUnavailable || 'sem chave'})`,
    );
  };
}
