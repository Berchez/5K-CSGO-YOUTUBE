import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import type pino from 'pino';

chromium.use(StealthPlugin());

export interface StealthContextOptions {
  profileDir: string;
  headless: boolean;
  extraArgs?: string[];
}

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

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
  };
  try {
    return (await chromium.launchPersistentContext(opts.profileDir, {
      ...common,
      channel: 'chrome',
    })) as unknown as BrowserContext;
  } catch {
    return (await chromium.launchPersistentContext(
      opts.profileDir,
      common,
    )) as unknown as BrowserContext;
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
