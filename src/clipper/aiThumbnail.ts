import fs from 'node:fs';
import sharp from 'sharp';
import type { AceEvent } from '../types.js';
import { prettyWeapon } from '../detector/aceDetector.js';
import { getLogger } from '../logger.js';
import type { ReferenceImages } from './referenceImages.js';

export type AiProvider =
  | 'huggingface'
  | 'pollinations'
  | 'gemini'
  | 'gemini-web'
  | 'chatgpt'
  | 'grok';

export interface AiThumbOptions {
  /** Ordem de tentativa. Default: chatgpt. */
  order?: AiProvider[];
  hfToken?: string;
  hfModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiWebProfileDir?: string;
  geminiWebHeadless?: boolean;
  chatgptProfileDir?: string;
  chatgptHeadless?: boolean;
  chatgptMinimized?: boolean;
  grokProfileDir?: string;
  grokMinimized?: boolean;
  /** Referências locais (foto, logos, mapa) — anexadas nos providers web. */
  references?: ReferenceImages;
  /** Timeout por provider (ms). Default 600s (THUMB_AI_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * 'full' (default no provider chatgpt): a imagem IA JÁ É a thumb
   * (só resize p/ 1280x720). 'hybrid': fundo IA + frame real + overlay.
   */
  layout?: 'hybrid' | 'full';
}

/** Cor de destaque do canal, usada no prompt e passível de reuso. */
export const ACCENT = 'neon lime green (#B6FF00)';

/**
 * Prompt de thumbnail PT-BR no layout de 3 zonas do canal.
 * Recebe TUDO que o evento tem: player, times, mapa, armas (principal +
 * sequência), vítimas, headshots, assists, flash-assists, granadas e placar.
 * O JSON do round vai embutido para a IA contextualizar.
 */
/**
 * Prompt de thumbnail PT-BR no layout de 3 zonas do canal.
 * portraitSafe=true (providers que recusam semelhança de pessoa real, ex. Gemini):
 * o retrato vira figura estilizada com rosto na sombra — mantém o layout,
 * troca só a linha do retrato, e o restante do layout (killfeed/textos) intacto.
 */
export function buildThumbnailPrompt(
  ace: AceEvent,
  refs?: ReferenceImages,
  portraitSafe = false,
): string {
  const s = ace.summary;
  const kills = s?.kills.length ?? ace.kills.length;
  const opp = s?.team
    ? s.team === ace.team1
      ? ace.team2
      : ace.team1
    : `${ace.team1} vs ${ace.team2}`;
  const team = s?.team || ace.team1;
  const playerName = s?.player || ace.player;
  // Rodapé sem duplicar: com summary, "time vs opp"; sem summary, o confronto direto.
  const footer = s?.team ? `${team} vs ${opp}` : opp;

  const refLines: string[] = [];
  if (refs?.player) refLines.push(`1. Foto do jogador ${playerName} — use rosto e uniforme como referência visual`);
  if (refs?.team1Logo) refLines.push(`2. Logo do time ${team} — use formas e cores exatos`);
  if (refs?.team2Logo) refLines.push(`3. Logo do adversário — use formas e cores exatos`);
  if (refs?.mapImage) refLines.push(`4. Imagem do mapa ${ace.map} — use o ambiente como cenário`);
  const refSection =
    refLines.length > 0
      ? `\nREFERÊNCIAS (imagens anexadas a esta mensagem, use-as como verdade visual):\n${refLines.join('\n')}\n`
      : '';

  const killfeed = (s?.kills ?? ace.kills)
    .map(
      (k, i) =>
        `  ${i + 1}. "${k.killer}" [${prettyWeapon(k.weapon ?? '') || k.weapon || '?'} icon]${
          k.headshot ? ' [headshot skull icon]' : ''
        } "${k.victim || '?'}"`,
    )
    .join('\n');

  const ctx = {
    player: playerName,
    team1: ace.team1,
    team2: ace.team2,
    playerTeam: team,
    opponents: opp,
    map: ace.map,
    round: ace.round,
    score: ace.score ?? null,
    event: ace.event,
    mainWeapon: s?.mainWeapon ? prettyWeapon(s.mainWeapon) : null,
    weapons: s?.weapons ?? [],
    victims: s?.victims ?? [],
    headshots: s?.headshots ?? 0,
    assists: s?.assists ?? [],
    flashAssists: s?.flashAssists ?? [],
    grenades: s?.grenades ?? [],
  };

  return `Gere uma thumbnail de YouTube 16:9 (1920x1080) para um clipe de Counter-Strike 2 que representa o ACE (5K) descrito neste json:
${JSON.stringify(ctx, null, 2)}
${refSection}
ESTILO
Thumbnail de esports profissional, fundo preto com acentos em ${ACCENT}, pinceladas/respingos de tinta, alto contraste, legível em tela pequena (mobile).

LAYOUT (3 zonas)
- ESQUERDA: logo do evento "${ace.event}" no topo; abaixo, logo do time ${team} e o nick "${playerName}" em letras brush/manuscritas brancas.
- CENTRO: ${portraitSafe
    ? `figura estilizada do jogador (camisa do ${team}), vista de lado com o rosto na sombra/contraluz — NÃO reproduza a semelhança facial de ninguém, é um atleta genérico`
    : `retrato em close do jogador ${playerName} (camisa do ${team}), olhando de lado, iluminação dramática com rim light`}. À direita dele, texto gigante "ACE" em ${ACCENT} estilo pincelada e "5K" em branco logo abaixo, com um traço de tinta sublinhando.
- DIREITA: killfeed estilo CS2 empilhado no topo, com ${kills} linhas (nick em verde, ícone da arma, ícone de headshot só onde indicado, adversário em azul):
${killfeed}
  Abaixo do killfeed, cenário do mapa ${ace.map} (ambiente reconhecível, luz quente, ponto de bomba pintado no chão) e a viewmodel em primeira pessoa da ${s?.mainWeapon ? prettyWeapon(s.mainWeapon) : 'arma principal'} com skin temática do ${team} entrando pelo canto inferior direito.
- RODAPÉ ESQUERDO: logos pequenos "${footer}" com texto em branco.

REGRAS
- Texto limitado a: evento, ${team}, "${playerName}", "ACE", "5K", killfeed e "${footer}". Sem outros textos.
- Diagonais de tinta ${ACCENT} costurando as zonas, vinheta escura nas bordas.
- Sem marca d'água, sem HUD extra.`.trim();
}

/**
 * Prompt de FUNDO para providers híbridos (gemini-web): SEM retrato de pessoa
 * real e SEM logos — o Gemini recusa semelhança de pessoa ("retrato em close
 * do jogador X"). O overlay sharp cuida de texto; o frame real cuida do rosto.
 * O mapa anexado (quando há) guia o cenário.
 */
export function buildBackgroundPrompt(ace: AceEvent): string {
  const s = ace.summary;
  const mainWeapon = s?.mainWeapon ? prettyWeapon(s.mainWeapon) : 'assault rifle';
  const weaponFlavor =
    s?.mainWeapon === 'awp'
      ? 'a sniper rifle silhouette glowing in the foreground,'
      : s?.mainWeapon === 'knife'
        ? 'a combat knife stuck in a wooden crate in the foreground,'
        : s && ['hegrenade', 'molotov', 'incgrenade', 'inferno'].includes(s.mainWeapon)
          ? 'massive fire explosion and thick smoke dominating the scene, embers flying,'
          : 'rifles on a weapon rack glowing in the foreground,';
  const nades = [...new Set((s?.grenades ?? []).map((g) => g.kind.toUpperCase()))];
  const hasFlash = (s?.flashAssists.length ?? 0) > 0;
  const mood =
    (s?.headshots ?? 0) >= 3
      ? 'Emphasize headshots: red impact effects, skull/crosshair accents.'
      : 'Emphasize speed and flow of the round.';
  return [
    'Counter-Strike 2 esports arena scene, 16:9 1920x1080 digital painting.',
    `Map environment: ${ace.map} (recognizable layout, dramatic lighting).`,
    weaponFlavor,
    ...(nades.length > 0 ? [`Subtle ${nades.join(' and ')} explosion smoke in the air.`] : []),
    ...(hasFlash ? ['Fading white flash bloom on one side.'] : []),
    'Epic red and gold spotlights, glowing particles, motion blur, high contrast.',
    'Bottom third dark and uncluttered (reserved for overlay text).',
    'NO people, NO faces, NO text, NO letters, NO numbers, NO logos, NO watermark.',
    mood,
  ].join(' ');
}

/** Prompt por provider: web (chatgpt/grok/gemini-web) = thumb completa; APIs = fundo. */
export function aiBackgroundPrompt(ace: AceEvent, provider?: string): string {
  if (provider === 'huggingface' || provider === 'gemini' || provider === 'pollinations') {
    return buildBackgroundPrompt(ace);
  }
  if (provider === 'gemini-web') {
    return buildThumbnailPrompt(ace, undefined, true);
  }
  return buildThumbnailPrompt(ace);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${label} após ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Garante que o buffer é imagem decodificável (sharp) antes de usar. */
async function assertImage(buf: Buffer, provider: string): Promise<void> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.format) throw new Error('sem dimensões/formato');
  } catch (e) {
    const head = buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`${provider} retornou bytes inválidos (${buf.length}b): ${head.slice(0, 100)}`);
  }
  if (buf.length < 20_000) throw new Error(`${provider} retornou imagem suspeita (${buf.length}b)`);
}
/** Pollinations.ai: era grátis sem chave; em 2026 passou a exigir créditos (HTTP 402).
 *  Mantido no código para quem tiver plano; sem créditos falha rápido e cai no próximo. */
async function pollinationsBackground(prompt: string, timeoutMs: number): Promise<Buffer> {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=1280&height=720&nologo=true&model=flux&seed=${Math.floor(Math.random() * 1e9)}`;
  const res = await withTimeout(fetch(url), timeoutMs, 'pollinations');
  if (!res.ok) throw new Error(`pollinations HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await assertImage(buf, 'pollinations');
  return buf;
}

/**
 * Hugging Face Inference: grátis com token gratuito (conta free, rate limits).
 * Criar em huggingface.co/settings/tokens (permissão mínima: Inference Providers).
 * Usa o SDK oficial (@huggingface/inference), que resolve o roteamento entre
 * providers (fal, replicate etc.) — URLs manuais quebram com frequência.
 * Modelo default: FLUX.1-schnell (rápido e bom para arte de fundo).
 */
async function huggingfaceBackground(
  prompt: string,
  token: string,
  model: string,
  timeoutMs: number,
): Promise<Buffer> {
  const { InferenceClient } = await import('@huggingface/inference');
  const run = (async () => {
    const client = new InferenceClient(token);
    const out = (await client.textToImage({
      provider: 'auto',
      model,
      inputs: prompt,
      parameters: { num_inference_steps: 5 },
    })) as unknown;
    // SDK novo retorna base64 (data URI ou cru); versões antigas retornavam Blob.
    if (typeof out === 'string') {
      const b64 = out.replace(/^data:image\/\w+;base64,/, '');
      return Buffer.from(b64, 'base64');
    }
    const blob = out as Blob;
    return Buffer.from(await blob.arrayBuffer());
  })();
  const buf = await withTimeout(run, timeoutMs, 'huggingface');
  await assertImage(buf, 'huggingface');
  return buf;
}
async function geminiBackground(
  prompt: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<Buffer> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const run = (async () => {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseModalities: ['TEXT', 'IMAGE'] } as Record<string, unknown>,
    });
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const data = (part as { inlineData?: { data?: string } }).inlineData?.data;
      if (data) return Buffer.from(data, 'base64');
    }
    throw new Error('gemini não retornou imagem');
  })();
  const buf = await withTimeout(run, timeoutMs, 'gemini');
  await assertImage(buf, 'gemini');
  return buf;
}

/** Resultado da geração: bytes + qual provider gerou + se já é a thumb final. */
export interface AiResult {
  image: Buffer;
  provider: AiProvider;
  /** true = imagem IA JÁ É a thumb (só resize); false = fundo p/ overlay. */
  fullThumb: boolean;
}

export interface ProviderPlan {
  prompt: string;
  attachments: string[];
  /** true = a imagem IA JÁ É a thumb (só resize); false = fundo p/ overlay. */
  fullThumb: boolean;
}

/**
 * Roteamento puro por provider (testável sem rede):
 * - chatgpt/grok (thumb completa): prompt do layout do canal + REFERÊNCIAS
 *   no texto + todos os anexos.
 * - gemini-web (thumb completa, policy-safe): mesmo layout, mas o retrato
 *   vira figura estilizada com rosto na sombra — o Gemini recusa semelhança
 *   de pessoa real; recebe as 4 referências igualmente.
 * - APIs (hf/gemini/pollinations): fundo, sem anexos locais.
 */
export function planForProvider(
  provider: AiProvider,
  ace: AceEvent,
  refs: ReferenceImages | undefined,
  availableAttachments: string[],
): ProviderPlan {
  if (provider === 'chatgpt' || provider === 'grok' || provider === 'gemini-web') {
    return {
      prompt: buildThumbnailPrompt(ace, refs, provider === 'gemini-web'),
      attachments: availableAttachments,
      fullThumb: true,
    };
  }
  return { prompt: buildBackgroundPrompt(ace), attachments: [], fullThumb: false };
}

/**
 * Cadeia de fallback: tenta cada provider NA ORDEM de THUMB_AI_ORDER.
 * Qualquer falha (sem login, cota, timeout, challenge, bytes inválidos) loga
 * e cai para o PRÓXIMO. Esgotada a cadeia, retorna null — quem chama usa a
 * thumb composta determinística (sharp, US$0, sempre funciona).
 */
export async function buildAiBackground(
  ace: AceEvent,
  opts: AiThumbOptions = {},
): Promise<AiResult | null> {
  const log = getLogger();
  const order = opts.order ?? ['chatgpt'];
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const refs = opts.references;
  const availableAttachments = refs
    ? [refs.player, refs.team1Logo, refs.team2Logo, refs.mapImage].filter(
        (f): f is string => !!f && fs.existsSync(f),
      )
    : [];
  if (availableAttachments.length > 0) {
    log.info({ n: availableAttachments.length }, 'referências prontas p/ anexo');
  }
  for (const provider of order) {
    try {
      const plan = planForProvider(provider, ace, refs, availableAttachments);
      if (provider === 'chatgpt' || provider === 'grok') {
        const isGrok = provider === 'grok';
        const mod = isGrok
          ? await import('./grok.js')
          : await import('./chatgpt.js');
        const fn = isGrok
          ? (mod as typeof import('./grok.js')).grokBackground
          : (mod as typeof import('./chatgpt.js')).chatgptBackground;
        const buf = await fn(plan.prompt, {
          profileDir: isGrok
            ? opts.grokProfileDir ?? './data/grok-profile'
            : opts.chatgptProfileDir ?? './data/chatgpt-profile',
          minimized: isGrok
            ? opts.grokMinimized ?? false
            : opts.chatgptMinimized ?? false,
          timeoutMs,
          attachments: plan.attachments,
        } as import('./chatgpt.js').ChatGptOptions & import('./grok.js').GrokOptions);
        await assertImage(buf, provider);
        log.info({ provider }, isGrok ? 'thumb IA via grok' : 'thumb IA via chatgpt');
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'gemini-web') {
        const { geminiWebBackground } = await import('./geminiWeb.js');
        const buf = await geminiWebBackground(plan.prompt, {
          profileDir: opts.geminiWebProfileDir ?? './data/gemini-profile',
          headless: opts.geminiWebHeadless ?? true,
          timeoutMs,
          attachments: plan.attachments,
        });
        await assertImage(buf, 'gemini-web');
        log.info('fundo IA via gemini-web');
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'huggingface') {
        if (!opts.hfToken) {
          log.info('huggingface pulado (sem HF_TOKEN — crie grátis em huggingface.co/settings/tokens)');
          continue;
        }
        const buf = await huggingfaceBackground(
          plan.prompt,
          opts.hfToken,
          opts.hfModel ?? 'black-forest-labs/FLUX.1-schnell',
          timeoutMs,
        );
        log.info('fundo IA via huggingface');
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'gemini') {
        if (!opts.geminiApiKey) {
          log.info('gemini pulado (sem GEMINI_API_KEY)');
          continue;
        }
        const buf = await geminiBackground(
          plan.prompt,
          opts.geminiApiKey,
          opts.geminiModel ?? 'gemini-3.1-flash-lite-image',
          timeoutMs,
        );
        log.info('fundo IA via gemini');
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'pollinations') {
        const buf = await pollinationsBackground(plan.prompt, timeoutMs);
        log.info('fundo IA via pollinations');
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      log.warn({ provider }, 'provider IA desconhecido, ignorando');
    } catch (e) {
      log.warn({ provider, err: String(e).slice(0, 160) }, 'provider IA falhou, tentando próximo');
    }
  }
  return null;
}

/**
 * Thumb híbrida: fundo IA + frame real em destaque (PiP) + overlay ACE.
 * Retorna null se qualquer etapa falhar (fallback = thumb composta).
 */
export async function buildAiThumbnail(
  framePath: string,
  outPath: string,
  ace: AceEvent,
  background: Buffer,
): Promise<string> {
  const { thumbnailOverlay } = await import('./thumbnail.js');
  const frameInset = await sharp(framePath)
    .resize(560, 315, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer();
  await sharp(background)
    .resize(1280, 720, { fit: 'cover' })
    .composite([
      { input: frameInset, top: 56, left: 664 },
      { input: thumbnailOverlay(ace), top: 0, left: 0 },
    ])
    .jpeg({ quality: 90 })
    .toFile(outPath);
  return outPath;
}
