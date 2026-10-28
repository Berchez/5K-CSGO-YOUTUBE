import { getLogger } from '../logger.js';
import type { MetadataAiFn, MetadataContext, MetadataDraft } from './videoMetadata.js';

export type MetadataAiProvider = 'gemini' | 'huggingface';

export interface MetadataAiOptions {
  order?: string;
  timeoutMs?: number;
  geminiApiKey?: string;
  geminiModel?: string;
  hfToken?: string;
  hfModel?: string;
}

const DEFAULT_ORDER = 'gemini,huggingface';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_HF_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
const PROVIDER_FAILURE_LIMIT = 2;

export function metadataAiProviders(order: string | undefined): MetadataAiProvider[] {
  const raw = (order ?? DEFAULT_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: MetadataAiProvider[] = [];
  for (const p of raw) {
    if ((p === 'gemini' || p === 'huggingface') && !out.includes(p)) out.push(p);
  }
  return out.length > 0 ? out : ['gemini', 'huggingface'];
}

export function buildMetadataPrompt(ctx: MetadataContext): string {
  const facts: Record<string, unknown> = {
    jogador: ctx.player,
    time_do_jogador: ctx.team,
    evento: ctx.event,
    mapa: ctx.map,
    round: ctx.round,
    kills: ctx.kills,
    headshots: ctx.headshots,
    arma_principal: ctx.mainWeapon,
    abates: ctx.feed.map((f) => ({
      vitima: f.victim,
      arma: f.weapon,
      headshot: f.headshot,
      no_scope: f.noscope,
      wallbang: f.wallbang,
      flash_de: f.flashAssistBy ?? '',
    })),
    assistencias_de_flash: ctx.flashAssists,
    granadas: ctx.grenades,
    placar: ctx.score ?? '',
  };
  // Só entra o confronto quando o lado do jogador é conhecido: sem isso a
  // IA inventa um rival ("contra a X") e o título inteiro é descartado.
  if (ctx.rival) facts.rival = ctx.rival;
  return [
    'Você escreve metadados de YouTube para um canal de highlights de CS2 (Counter-Strike 2).',
    'Tom: esports brasileiro, criativo e direto, mas 100% factual.',
    '',
    'FACTOS DO ROUND (JSON) — use SOMENTE estes dados:',
    JSON.stringify(facts, null, 2),
    '',
    'REGRAS OBRIGATÓRIAS:',
    `1. O jogador fez exatamente ${ctx.kills} kills. Nunca cite outro número de kills e nunca use a palavra "ace" se ${ctx.kills} < 5.`,
    '2. É proibido inventar: clutch, 1vX, resultado do round (vitória/derrota/GG), placar, jogador, arma, mapa ou evento que não estejam no JSON.',
    ctx.rival
      ? '3. O rival do jogador está em "rival": pode citá-lo.'
      : '3. Não cite nenhum time (nem "contra X"): não sabemos de que lado o jogador estava. O confronto e a linha de contexto entram depois, no corpo da descrição.',
    `4. O título precisa conter o nome do jogador (${ctx.player}) e o evento (${ctx.event}) ou o time.`,
    '5. Título: no máximo 100 caracteres, no máximo 1 emoji (use só um destes: 🔥 💥 ⚡ 🎯 💀 🚨 ❗), sem aspas, sem URL, sem hashtag e sem quebra de linha.',
    '6. Escreva a ABERTURA da descrição em dois blocos: (a) uma linha de impacto com o nome do jogador, o número de kills e o mapa; (b) um parágrafo curto de 1 a 2 frases, direto e na 2ª pessoa ("assiste donk..."), sem clichê vazio.',
    '7. NÃO liste as eliminações uma a uma, NÃO cite o placar, NÃO use emoji, hashtag ou URL: a lista com timestamps, as estatísticas e as hashtags entram depois.',
    '8. Devolva 3 opções de título, da mais chamativa para a mais limpa.',
    '',
    'Responda APENAS com JSON válido, neste formato:',
    '{"titles": ["titulo 1", "titulo 2", "titulo 3"], "opening": "linha de impacto\\n\\nparágrafo curto"}',
  ].join('\n');
}

export function parseAiDraft(raw: string): MetadataDraft | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  const parsed = tryParseJson(candidate) ?? tryParseJson(repairJson(candidate));
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { titles?: unknown; opening?: unknown; description?: unknown };
  const titles = Array.isArray(obj.titles)
    ? obj.titles.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const opening =
    typeof obj.opening === 'string'
      ? obj.opening
      : typeof obj.description === 'string'
        ? obj.description
        : '';
  if (titles.length === 0 && !opening.trim()) return null;
  return { titles, opening };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function repairJson(text: string): string {
  let out = '';
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    out += ch;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
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

export async function geminiText(
  prompt: string,
  opts: { apiKey: string; model: string; timeoutMs: number },
): Promise<string> {
  const { GoogleGenAI, Type } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const run = (async () => {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            titles: { type: Type.ARRAY, items: { type: Type.STRING } },
            opening: { type: Type.STRING },
          },
          required: ['titles', 'opening'],
        },
        temperature: 0.9,
        // Os modelos Gemini 3 gastam tokens de "thought" no mesmo orçamento
        // da resposta: sem limite, o texto truncava no meio do 2º título (e a
        // descrição nunca chegava). 8192 cabe pensamento + 3 títulos + texto.
        maxOutputTokens: 8192,
        // Escrever metadados não precisa de raciocínio longo: sem pensamento
        // a chamada fica mais rápida, barata e previsível.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return res.text ?? '';
  })();
  return withTimeout(run, opts.timeoutMs, 'gemini-texto');
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
  }
  throw new Error(`${label}: ${String(lastError).slice(0, 200)}`);
}

export async function huggingfaceText(
  prompt: string,
  opts: { token: string; model: string; timeoutMs: number },
): Promise<string> {
  const { InferenceClient } = await import('@huggingface/inference');
  const client = new InferenceClient(opts.token);
  const run = (async () => {
    const res = await client.chatCompletion({
      model: opts.model,
      messages: [
        {
          role: 'system',
          content:
            'Você escreve metadados de YouTube para um canal de CS2, em português do Brasil. Responda apenas com JSON válido.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 900,
      temperature: 0.9,
    });
    return res.choices?.[0]?.message?.content ?? '';
  })();
  return withTimeout(run, opts.timeoutMs, 'huggingface-texto');
}

export function createMetadataAi(opts: MetadataAiOptions = {}): MetadataAiFn {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const geminiModel = opts.geminiModel || DEFAULT_GEMINI_MODEL;
  const hfModel = opts.hfModel || DEFAULT_HF_MODEL;
  const providers = metadataAiProviders(opts.order);
  const log = getLogger().child({ feature: 'metadata-ai' });
  const failures = new Map<MetadataAiProvider, number>();
  const disabled = new Set<MetadataAiProvider>();
  return async (ctx: MetadataContext): Promise<MetadataDraft | null> => {
    const prompt = buildMetadataPrompt(ctx);
    for (const provider of providers) {
      if (disabled.has(provider)) continue;
      try {
        let raw = '';
        if (provider === 'gemini') {
          if (!opts.geminiApiKey) {
            log.info('gemini sem GEMINI_API_KEY — pulando');
            continue;
          }
          raw = await withRetry(
            () =>
              geminiText(prompt, {
                apiKey: opts.geminiApiKey as string,
                model: geminiModel,
                timeoutMs,
              }),
            2,
            'gemini-texto',
          );
        } else {
          if (!opts.hfToken) {
            log.info('huggingface sem HF_TOKEN — pulando');
            continue;
          }
          raw = await withRetry(
            () =>
              huggingfaceText(prompt, {
                token: opts.hfToken as string,
                model: hfModel,
                timeoutMs,
              }),
            1,
            'huggingface-texto',
          );
        }
        const draft = parseAiDraft(raw);
        if (!draft) {
          log.warn({ provider, raw: raw.slice(0, 120) }, 'resposta da IA sem JSON utilizável');
          continue;
        }
        failures.set(provider, 0);
        log.info({ provider, titles: draft.titles.length }, 'metadados gerados pela IA');
        return { ...draft, provider };
      } catch (e) {
        const count = (failures.get(provider) ?? 0) + 1;
        failures.set(provider, count);
        log.warn(
          { provider, err: String(e).slice(0, 200), falhas: count },
          'provider de texto falhou',
        );
        if (count >= PROVIDER_FAILURE_LIMIT) {
          disabled.add(provider);
          log.warn({ provider }, 'provider de texto desligado nesta sessão');
        }
      }
    }
    return null;
  };
}
