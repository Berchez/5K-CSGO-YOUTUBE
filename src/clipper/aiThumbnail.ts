import fs from 'node:fs';
import sharp from 'sharp';
import type { AceEvent } from '../types.js';
import { killLabel, prettyWeapon } from '../detector/aceDetector.js';
import { getLogger } from '../logger.js';
import { notifyWindows } from '../notify.js';
import type { ReferenceImages } from './referenceImages.js';
import {
  WEB_LOGIN_PROVIDERS,
  clearLoggedOut,
  isLoginError,
  isProviderLoggedOut,
  loadLoggedOut,
  loginScriptFor,
  markLoggedOut,
} from './providerStatus.js';

export type AiProvider =
  | 'huggingface'
  | 'pollinations'
  | 'gemini'
  | 'gemini-web'
  | 'chatgpt'
  | 'grok';

/** Janela em que o provider rodou (para cruzar visibilidade × resultado). */
export type ThumbWindowMode = 'minimized' | 'visible' | 'headless' | 'api';

/** Causa da falha (para o diagnóstico "precisava estar visível?"). */
export type ThumbFailKind = 'challenge' | 'login' | 'timeout' | 'layout' | 'backend' | 'unknown';

/** Modo de janela efetivo do provider nesta tentativa. */
export function thumbWindowMode(provider: AiProvider, opts: AiThumbOptions): ThumbWindowMode {
  if (provider === 'chatgpt') return (opts.chatgptMinimized ?? true) ? 'minimized' : 'visible';
  if (provider === 'grok') return (opts.grokMinimized ?? true) ? 'minimized' : 'visible';
  if (provider === 'gemini-web') return (opts.geminiWebHeadless ?? true) ? 'headless' : 'visible';
  return 'api';
}

/**
 * Classifica a falha (puro/testável). Ordem importa: login antes de
 * challenge (mensagem de challenge pode citar retry), challenge antes de
 * backend (texto de challenge cita "tente de novo").
 */
export function classifyThumbFailure(errText: string): ThumbFailKind {
  if (isLoginError(errText)) return 'login';
  if (/desafio cloudflare|challenge|turnstile|captcha|just a moment/i.test(errText)) return 'challenge';
  if (/não retornou .* a tempo|timeout|timed out|expir/i.test(errText)) return 'timeout';
  // Layout: só os formatos reais ("não encontrado"/"sumiu") — "pill não
  // apareceu no composer" é falha de upload, não de layout.
  if (/composer[^.!?]*(não encontrado|sumiu)|layout mudou/i.test(errText)) return 'layout';
  if (/problemas para processar uploads|try again later|tente novamente|429|throttl/i.test(errText)) return 'backend';
  return 'unknown';
}

export interface ChallengeStreakTracker {
  /** Registra falha; true UMA vez ao atingir o limiar (sem spam). */
  register: (provider: string, mode: ThumbWindowMode, failKind: ThumbFailKind) => boolean;
  reset: (provider: string) => void;
  snapshot: () => Record<string, number>;
}

/** Falhas de challenge seguidas (sem janela) que disparam o alerta. */
export const CHALLENGE_ALERT_THRESHOLD = 3;

/**
 * Conta falhas de challenge SEM janela visível por provider. Quando o bot
 * roda minimizado e o challenge dispara em sequência, é o sinal de que
 * aquele provider precisava estar visível — o chamador emite ERROR + toast.
 * Sucesso zera. Puro/testável (estado encapsulado).
 */
export function createChallengeStreakTracker(
  threshold = CHALLENGE_ALERT_THRESHOLD,
): ChallengeStreakTracker {
  const fails = new Map<string, number>();
  return {
    register(provider, mode, failKind) {
      if (failKind !== 'challenge' || mode === 'visible') {
        fails.delete(provider);
        return false;
      }
      const n = (fails.get(provider) ?? 0) + 1;
      fails.set(provider, n);
      return n === threshold;
    },
    reset(provider) {
      fails.delete(provider);
    },
    snapshot() {
      return Object.fromEntries(fails);
    },
  };
}

/** Contador global da cadeia (reinicia com o processo — heurística, não estado). */
const challengeStreaks = createChallengeStreakTracker();

export interface AiThumbOptions {
  /** Ordem de tentativa. Default: chatgpt. */
  order?: AiProvider[];
  hfToken?: string;
  hfModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiWebProfileDir?: string;
  geminiWebChromeProfile?: string;
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
  /** Store de status de login (default data/provider-status.json). Testes injetam tmp. */
  statusFile?: string;
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
  // Sidecar antigo/serializado pode ter summary sem 'kills': cai no ace.kills.
  const kills = s?.kills?.length ?? ace.kills.length;
  const opp = s?.team
    ? s.team === ace.team1
      ? ace.team2
      : ace.team1
    : `${ace.team1} vs ${ace.team2}`;
  const team = s?.team || ace.team1;
  const playerName = s?.player || ace.player;
  // Rodapé sem duplicar: com summary, "time vs opp"; sem summary, o confronto direto.
  const footer = s?.team ? `${team} vs ${opp}` : opp;

  // REFERÊNCIAS: numeração dinâmica NA MESMA ORDEM dos anexos (o provider
  // recebe os arquivos nessa sequência). Nomes específicos de tudo —
  // o gerador precisa saber O QUE é cada anexo e de quem.
  const refItems: Array<{ key: keyof NonNullable<ReferenceImages>; label: string }> = [];
  if (refs?.player) {
    refItems.push({
      key: 'player',
      label: `Foto oficial do jogador "${playerName}" — rosto e identidade visual dele`,
    });
  }
  if (refs?.playerAlt) {
    refItems.push({
      key: 'playerAlt',
      label: `Segunda foto do jogador "${playerName}" em evento com a camisa do ${team} — use para o uniforme e a pose`,
    });
  }
  if (refs?.team1Logo) {
    refItems.push({
      key: 'team1Logo',
      label: `Logo do time ${team} — reproduza formas e cores exatos`,
    });
  }
  if (refs?.team2Logo) {
    refItems.push({
      key: 'team2Logo',
      label: `Logo do time adversário ${ace.team2} — reproduza formas e cores exatos`,
    });
  }
  if (refs?.mapImage) {
    refItems.push({
      key: 'mapImage',
      label: `Cenário do mapa ${ace.map} — use como ambiente da cena`,
    });
  }
  const refSection =
    refItems.length > 0
      ? `\nREFERÊNCIAS OBRIGATÓRIAS (as ${refItems.length} imagens anexadas a esta mensagem, NESTA EXATA ORDEM — siga-as como verdade visual para identidade, cores, formas e cenário):\n${refItems
        .map((r, i) => `${i + 1}. ${r.label}`)
        .join('\n')}\n`
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

  // Label dinâmico: ACE (≥5 kills) ou 3K/4K — o "5K" só existe em ace.
  const label = killLabel(kills);
  const bigText =
    kills >= 5
      ? `texto gigante "ACE" em ${ACCENT} estilo pincelada e "5K" em branco logo abaixo, com um traço de tinta sublinhando`
      : `texto gigante "${label}" em ${ACCENT} estilo pincelada, com um traço de tinta sublinhando`;

  return `Gere uma thumbnail de YouTube 16:9 (1920x1080) para um clipe de Counter-Strike 2 que representa o ${label === 'ACE' ? 'ACE (5K)' : `multikill de ${label}`} descrito neste json:
${JSON.stringify(ctx, null, 2)}
${refSection}
ESTILO
Thumbnail de esports profissional, fundo preto com acentos em ${ACCENT}, pinceladas/respingos de tinta, alto contraste, legível em tela pequena (mobile).

LAYOUT (3 zonas)
- ESQUERDA: logo do evento "${ace.event}" no topo; abaixo, logo do time ${team} e o nick "${playerName}" em letras brush/manuscritas brancas.
- CENTRO: ${portraitSafe
    ? `figura estilizada do jogador (camisa do ${team}), vista de lado com o rosto na sombra/contraluz — NÃO reproduza a semelhança facial de ninguém, é um atleta genérico`
    : `retrato em close do jogador ${playerName} (camisa do ${team}), olhando de lado, iluminação dramática com rim light`}. À direita dele, ${bigText}.
- DIREITA: killfeed estilo CS2 empilhado no topo, com ${kills} linhas (nick em verde, ícone da arma, ícone de headshot só onde indicado, adversário em azul):
${killfeed}
  Abaixo do killfeed, cenário do mapa ${ace.map} (ambiente reconhecível, luz quente, ponto de bomba pintado no chão) e a viewmodel em primeira pessoa da ${s?.mainWeapon ? prettyWeapon(s.mainWeapon) : 'arma principal'} com skin temática do ${team} entrando pelo canto inferior direito.
- RODAPÉ ESQUERDO: logos pequenos "${footer}" com texto em branco.

REGRAS
- Texto limitado a: evento, ${team}, "${playerName}", "${label}"${kills >= 5 ? ', "5K"' : ''}, killfeed e "${footer}". Sem outros textos.
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
  const hasFlash = (s?.flashAssists?.length ?? 0) > 0;
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
  const statusFile = opts.statusFile;
  // Login expirado persiste entre clipes: provider flagado é PULADO (zero
  // browser, zero timeout) até o script de relogin limpar a flag.
  const loggedOut = loadLoggedOut(statusFile);
  /** Sucesso = login funciona: limpa flag (auto-correção de falso positivo). */
  const clearIfFlagged = (p: string): void => {
    if (isProviderLoggedOut(loggedOut, p)) clearLoggedOut(p, statusFile);
  };
  /**
   * Linha-resumo por tentativa (lida pelo diag:thumbs): provider × modo de
   * janela × resultado × causa. É o que responde "precisava estar visível?".
   */
  const note = (provider: AiProvider, outcome: 'ok' | 'fail', failKind: ThumbFailKind | null): void => {
    const mode = thumbWindowMode(provider, opts);
    log.info({ provider, windowMode: mode, outcome, failKind }, 'thumb IA: tentativa');
    if (outcome === 'ok') {
      challengeStreaks.reset(provider);
    } else if (challengeStreaks.register(provider, mode, failKind ?? 'unknown')) {
      log.error(
        { provider, mode, fails: CHALLENGE_ALERT_THRESHOLD },
        'challenge repetido sem janela visível — considere voltar visível (CHATGPT_MINIMIZED=0, GROK_MINIMIZED=0)',
      );
      notifyWindows(
        '5K Bot: thumbs caindo no fallback',
        `Provider "${provider}" falhou ${CHALLENGE_ALERT_THRESHOLD}x seguidas em challenge (${mode}). Considere voltar a janela visível.`,
      );
    }
  };
  const refs = opts.references;
  const availableAttachments = refs
    ? [refs.player, refs.playerAlt, refs.team1Logo, refs.team2Logo, refs.mapImage].filter(
        (f): f is string => !!f && fs.existsSync(f),
      )
    : [];
  if (availableAttachments.length > 0) {
    log.info({ n: availableAttachments.length }, 'referências prontas p/ anexo');
  }
  for (const provider of order) {
    if (WEB_LOGIN_PROVIDERS.has(provider) && isProviderLoggedOut(loggedOut, provider)) {
      log.info(
        { provider, cmd: loginScriptFor(provider) },
        'pulando provider: login expirado — relogue para restaurar',
      );
      continue;
    }
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
        clearIfFlagged(provider);
        note(provider, 'ok', null);
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'gemini-web') {
        const { geminiWebBackground } = await import('./geminiWeb.js');
        const buf = await geminiWebBackground(plan.prompt, {
          profileDir: opts.geminiWebProfileDir ?? './data/gemini-profile',
          chromeProfileDirectory: opts.geminiWebChromeProfile,
          headless: opts.geminiWebHeadless ?? true,
          timeoutMs,
          attachments: plan.attachments,
        });
        await assertImage(buf, 'gemini-web');
        log.info('fundo IA via gemini-web');
        clearIfFlagged('gemini-web');
        note('gemini-web', 'ok', null);
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
        note('huggingface', 'ok', null);
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
        note('gemini', 'ok', null);
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      if (provider === 'pollinations') {
        const buf = await pollinationsBackground(plan.prompt, timeoutMs);
        log.info('fundo IA via pollinations');
        note('pollinations', 'ok', null);
        return { image: buf, provider, fullThumb: plan.fullThumb };
      }
      log.warn({ provider }, 'provider IA desconhecido, ignorando');
    } catch (e) {
      const errText = String(e);
      const failKind = classifyThumbFailure(errText);
      note(provider, 'fail', failKind);
      // Login expirado: marca (transição grita 1x + toast) e segue a cadeia.
      // Falhas transitórias (challenge, backend, timeout) continuam como hoje.
      if (WEB_LOGIN_PROVIDERS.has(provider) && isLoginError(errText)) {
        const fresh = markLoggedOut(provider, errText.slice(0, 200), statusFile);
        if (fresh) {
          log.error(
            { provider, cmd: loginScriptFor(provider) },
            'LOGIN EXPIRADO — rode o script de relogin (provider pulado nos clipes até lá)',
          );
          notifyWindows(
            '5K Bot: login expirado',
            `O provider "${provider}" está deslogado. Rode: ${loginScriptFor(provider) ?? 'npm run chatgpt:login'} — ele volta sozinho após o relogin.`,
          );
        } else {
          log.warn({ provider }, 'login expirado (já avisado) — tentando próximo');
        }
      } else {
        log.warn({ provider, err: errText.slice(0, 160), failKind }, 'provider IA falhou, tentando próximo');
      }
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
