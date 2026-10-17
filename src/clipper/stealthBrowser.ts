import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import type pino from 'pino';
import { getLogger } from '../logger.js';

chromium.use(StealthPlugin());

export interface StealthContextOptions {
  profileDir: string;
  headless: boolean;
  extraArgs?: string[];
  /**
   * Minimiza a janela via CDP após o launch (reforço do --start-minimized,
   * que o Chrome real às vezes ignora). Sem efeito em headless. Best-effort:
   * retorna false se falhar — nunca derruba o caller.
   */
  minimize?: boolean;
  /**
   * Args default do Playwright a ignorar. O Playwright desliga o bloqueador
   * de popups por padrão (--disable-popup-blocking) — o HLTV abre popunders
   * de anúncio que viram abas about:blank presas. Passe
   * ['--disable-popup-blocking'] para VOLTAR a bloquear (monitor não usa
   * popup; logins manuais continuam com o default).
   */
  ignoreDefaultArgs?: string[];
}

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Minimiza a janela do browser via CDP (reforço do --start-minimized).
 * Puro efeito colateral, best-effort: true se o estado aplicado foi
 * minimizado, false em qualquer falha (headless, sem janela, CDP indisponível).
 */
export async function minimizeBrowserWindow(ctx: BrowserContext): Promise<boolean> {
  try {
    const browser = ctx.browser();
    if (!browser) return false;
    const session = await browser.newBrowserCDPSession();
    try {
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      const targets = (await send('Target.getTargets', {})) as {
        targetInfos: Array<{ type: string; targetId: string }>;
      };
      const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
      if (!pageTarget) return false;
      const { windowId } = (await send('Browser.getWindowForTarget', {
        targetId: pageTarget.targetId,
      })) as { windowId: number };
      await send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      const { bounds } = (await send('Browser.getWindowForTarget', {
        targetId: pageTarget.targetId,
      })) as { bounds: { windowState?: string } };
      return bounds.windowState === 'minimized';
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

/**
 * Contexto persistente com stealth (puppeteer-extra-plugin-stealth):
 * remove navigator.webdriver e outras assinaturas de CDP que fazem o
 * Cloudflare/Turnstile entrar em loop mesmo com clique manual.
 * Tenta Chrome real instalado; cai para o chromium do Playwright.
 */
export async function launchStealthContext(
  opts: StealthContextOptions,
): Promise<BrowserContext> {
  const args = [...BASE_ARGS, ...(opts.extraArgs ?? [])];
  // SEM userAgent fixo de propósito: o navegador real envia o UA autêntico
  // (+ Client Hints consistentes). UA fixo desatualizado é assinatura clássica.
  const common = {
    headless: opts.headless,
    args,
    viewport: { width: 1366, height: 900 },
    ...(opts.ignoreDefaultArgs ? { ignoreDefaultArgs: opts.ignoreDefaultArgs } : {}),
  };
  try {
    const ctx = (await chromium.launchPersistentContext(opts.profileDir, {
      ...common,
      channel: 'chrome',
    })) as unknown as BrowserContext;
    if (opts.minimize && !opts.headless) {
      const ok = await minimizeBrowserWindow(ctx);
      getLogger().debug({ minimized: ok }, 'janela do browser minimizada (CDP)');
    }
    return ctx;
  } catch {
    const ctx = (await chromium.launchPersistentContext(
      opts.profileDir,
      common,
    )) as unknown as BrowserContext;
    if (opts.minimize && !opts.headless) {
      const ok = await minimizeBrowserWindow(ctx);
      getLogger().debug({ minimized: ok }, 'janela do browser minimizada (CDP)');
    }
    return ctx;
  }
}

async function hasChallenge(page: Page): Promise<boolean> {
  if (/challenge|turnstile|captcha/i.test(page.url())) return true;
  // Widget Turnstile renderiza num iframe cross-origin: o texto NÃO aparece
  // no DOM da página — detecta também pelo iframe em si.
  if (
    (await page
      .locator('iframe[src*="cloudflare"], iframe[src*="turnstile"], iframe[src*="challenge"]')
      .count()) > 0
  ) {
    return true;
  }
  if (page.frames().some((f) => /cloudflare|turnstile|challenge/i.test(f.url()))) {
    return true;
  }
  return (
    (await page
      .getByText(/confirme que é humano|verify you are human|prova que você não é um robô/i)
      .count()) > 0
  );
}

/**
 * Tenta resolver o desafio Cloudflare/Turnstile: clica no checkbox do widget
 * (com movimento de mouse humanizado) e aguarda liberação. Retorna true se
 * não há desafio ou foi resolvido. Usado pelos providers web e login manual.
 */
export async function trySolveChallenge(
  page: Page,
  log: pino.Logger,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!(await hasChallenge(page))) return true;
    log.info({ tentativa: i + 1 }, 'desafio Cloudflare detectado, tentando resolver');
    const frames = page.frames().filter((f) => /cloudflare|turnstile|challenge/i.test(f.url()));
    let clicked = false;
    for (const f of frames) {
      const target = f
        .locator('label, input[type="checkbox"], [role="checkbox"]')
        .first();
      try {
        if ((await target.count()) > 0) {
          await target.hover({ timeout: 10_000 });
          await page.waitForTimeout(600 + Math.random() * 900);
          await target.click({ timeout: 10_000 });
          clicked = true;
          break;
        }
      } catch {
        // tenta próximo frame/seletor
      }
    }
    if (!clicked) {
      // fallback: clica no centro do widget via coordenadas do iframe
      try {
        const frameEl = page
          .locator('iframe[src*="cloudflare"], iframe[src*="turnstile"], iframe[src*="challenge"]')
          .first();
        if ((await frameEl.count()) > 0) {
          await frameEl.hover({ timeout: 10_000 });
          await page.waitForTimeout(500);
          await frameEl.click({ position: { x: 30, y: 30 }, timeout: 10_000 });
          clicked = true;
        }
      } catch {
        // sem alvo clicável
      }
    }
    await page.waitForTimeout(9000);
    if (!(await hasChallenge(page))) {
      log.info('desafio resolvido');
      return true;
    }
  }
  const stillBlocked = await hasChallenge(page);
  if (!stillBlocked) return true;
  log.warn('desafio persiste após tentativas (IP/perfil marcado?)');
  return false;
}

/**
 * Fecha abas estranhas ao redor da página de trabalho (popups de login,
 * restos de execuções mortas no mesmo perfil). Browsers de thumb são
 * curtos (minutos) — qualquer aba extra é lixo ou popup travado em branco.
 * Chamadores passam o logger do provider p/ observabilidade.
 */
export async function closeForeignTabs(
  browser: BrowserContext,
  keep: Page,
  log?: pino.Logger,
): Promise<number> {
  let closed = 0;
  for (const p of browser.pages()) {
    if (p === keep || p.isClosed()) continue;
    const url = p.url().slice(0, 80);
    await p.close().catch(() => undefined);
    closed++;
    log?.info({ url }, 'aba estranha fechada');
  }
  return closed;
}

/**
 * Lock por perfil: o Chromium trava o user-data-dir por processo — dois
 * launches concorrentes no MESMO perfil colidem ("Abrindo em uma sessão
 * de navegador existente" + morte). O bot live dispara thumbs em paralelo
 * (um handleAce por partida), então providers do mesmo perfil (ex: 2 runs
 * chatgpt) precisam serializar. Lock liberado no finally, APÓS browser.close.
 */
export interface ProfileLock {
  dir: string;
  done: () => void;
}

const profileTails = new Map<string, Promise<void>>();

export async function acquireProfileLock(dir: string, log?: pino.Logger): Promise<ProfileLock> {
  const prev = profileTails.get(dir) ?? Promise.resolve();
  let done!: () => void;
  const cur = new Promise<void>((r) => {
    done = r;
  });
  profileTails.set(dir, prev.then(() => cur));
  const t0 = Date.now();
  await prev;
  const waited = Date.now() - t0;
  if (waited > 1000) log?.info({ dir, waitedMs: waited }, 'aguardou lock do perfil');
  return { dir, done };
}

export function releaseProfileLock(lock: ProfileLock | null): void {
  if (lock) lock.done();
}
