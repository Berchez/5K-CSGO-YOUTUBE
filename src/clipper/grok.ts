import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ProfileLock } from './stealthBrowser.js';
import { getLogger } from '../logger.js';
import { listContentImages, downloadPageImage } from './chatgpt.js';
import { findNearReference, hashReferences } from './imageFingerprint.js';

export interface GrokOptions {
  profileDir: string;
  /** default true (minimizado, sem popup em jogo): false = visível (debug de challenge). */
  minimized?: boolean;
  timeoutMs?: number;
  /** Caminhos locais de imagens de referência (foto, logos, mapa). */
  attachments?: string[];
}

export const NEED_GROK_LOGIN_MESSAGE =
  'Grok sem login. Rode uma vez: npx tsx scripts/grok-login.ts ' +
  '(abre o Chrome — use UMA CONTA X/DESCARTÁVEL, nunca contas importantes) ' +
  'e faça login manualmente.';

/** Marcadores de sessão expirada — reusada na entrada e nas falhas tardias. */
async function looksLoggedOut(page: Page): Promise<boolean> {
  try {
    if (page.url().includes('accounts.x.com') || page.url().includes('accounts.google.com')) {
      return true;
    }
    return /entrar|criar conta|log in|sign in/i.test(
      (await page.evaluate('(document.body ? document.body.innerText : "").slice(0, 600)')) as string,
    );
  } catch {
    return false;
  }
}

/**
 * Gera imagem via app web do Grok (grok.com) com Playwright.
 * Mesmo padrão do chatgpt: stealth, janela visível, anexos, validação de
 * resposta por tamanho de download (imune a previews de anexo).
 *
 * AVISOS: automatizar UI web viola os Termos da xAI — conta descartável;
 * layout muda sem aviso; falha retorna erro e o pipeline cai no próximo
 * provider da cadeia (THUMB_AI_ORDER).
 */
export async function grokBackground(
  prompt: string,
  opts: GrokOptions,
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const log = getLogger().child({ provider: 'grok' });
  fs.mkdirSync(opts.profileDir, { recursive: true });

  const failShot = async (page: Page, why: string): Promise<void> => {
    try {
      fs.mkdirSync('./logs', { recursive: true });
      const shot = path.join('./logs', `grok-fail-${Date.now()}.png`);
      await page.screenshot({ path: shot });
      log.warn({ shot, why }, 'screenshot da falha salvo');
    } catch {
      log.warn({ why }, 'falha sem screenshot');
    }
  };

  let browser: Awaited<ReturnType<typeof import('./stealthBrowser.js').launchStealthContext>> | null = null;
  let profileLock: ProfileLock | null = null;
  try {
    const { launchStealthContext, trySolveChallenge, acquireProfileLock } = await import('./stealthBrowser.js');
    profileLock = await acquireProfileLock(opts.profileDir, log);
    browser = await launchStealthContext({
      profileDir: opts.profileDir,
      headless: false,
      extraArgs: (opts.minimized ?? true) ? ['--start-minimized'] : [],
      minimize: opts.minimized ?? true,
    });
    const page = browser.pages()[0] ?? (await browser.newPage());
    const { closeForeignTabs } = await import('./stealthBrowser.js');
    await closeForeignTabs(browser, page, log);
    log.info('abrindo grok.com');
    await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);

    await trySolveChallenge(page, log);

    if (await looksLoggedOut(page)) {
      await failShot(page, 'sem login');
      throw new Error(NEED_GROK_LOGIN_MESSAGE);
    }
    log.info('login OK, procurando composer');

    // Composer real = contenteditable; a <textarea> do Grok é um espelho
    // aria-hidden (height:0) usado por a11y — fill nela não submete nada.
    const findBox = async () => {
      let b = page.locator('div[contenteditable="true"]').first();
      if ((await b.count()) === 0) {
        b = page.locator('textarea:not([aria-hidden="true"])').first();
      }
      return b;
    };
    let box = await findBox();
    if ((await box.count()) === 0) {
      // Re-checagem: composer sumido pode ser logout tardio.
      if (await looksLoggedOut(page)) {
        await failShot(page, 'sem login (tardio)');
        throw new Error(NEED_GROK_LOGIN_MESSAGE);
      }
      await failShot(page, 'sem composer');
      throw new Error('composer do Grok não encontrado (layout mudou?)');
    }

    const attachments = (opts.attachments ?? []).filter(Boolean) as string[];
    const referenceHashes = await hashReferences(attachments, log);
    if (attachments.length > 0) {
      const { attachFiles } = await import('./attachFiles.js');
      const res = await attachFiles(page, log, attachments);
      if (!res.ok) log.warn('anexos incompletos — prompt segue com texto + o que subiu');
      box = await findBox();
      if ((await box.count()) === 0) {
        if (await looksLoggedOut(page)) {
          await failShot(page, 'sem login (tardio, pós-anexo)');
          throw new Error(NEED_GROK_LOGIN_MESSAGE);
        }
        await failShot(page, 'sem composer pós-anexo');
        throw new Error('composer do Grok sumiu após anexar (layout mudou?)');
      }
    }
    const before = await listContentImages(page);
    log.info({ imagensAntes: before.length, anexos: attachments.length }, 'enviando prompt de imagem');
    await box.click({ timeout: 15_000 });
    await page.keyboard.press('Escape').catch(() => undefined);
    await box.fill(prompt);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    log.info({ conversa: page.url() }, 'prompt enviado, aguardando render da imagem');

    const graceUntil = Date.now() + 20_000;
    // Teto alto de propósito: ver chatgpt.ts (THUMB_AI_TIMEOUT_MS).
    const deadline = Date.now() + Math.min(timeoutMs, 1_800_000);
    const MIN_BYTES = 20_000;
    let buf: Buffer | null = null;
    const seen = new Set<string>(before);
    while (Date.now() < deadline && !buf) {
      await page.waitForTimeout(5000);
      if (Date.now() < graceUntil) continue;
      let fresh: string[] = [];
      try {
        const after = await listContentImages(page, 512);
        fresh = after.filter((s) => !seen.has(s));
      } catch {
        continue;
      }
      // Candidatos idênticos aos anexos (mapa/foto) são descartados: só a
      // imagem NOVA gerada interessa. Download com falha não queima o src.
      for (const src of fresh.slice().reverse()) {
        try {
          const cand = await downloadPageImage(page, src);
          if (cand.length < MIN_BYTES) continue;
          const near = await findNearReference(cand, referenceHashes);
          if (near) {
            seen.add(src);
            log.warn(
              { bytes: cand.length, ref: path.basename(near.name), distance: near.distance },
              'candidato igual à referência anexada — ignorando',
            );
            continue;
          }
          seen.add(src);
          buf = cand;
          break;
        } catch {
          // preview inválido/revogado: segue
        }
      }
    }
    if (!buf) {
      await failShot(page, 'timeout sem imagem');
      throw new Error(
        'Grok não retornou imagem a tempo — veja logs/grok-fail-*.png. ' +
          'Causas comuns: cota esgotada, ou resposta em texto.',
      );
    }
    log.info({ bytes: buf.length, conversa: page.url() }, 'imagem IA baixada');
    return buf;
  } finally {
    await browser?.close().catch(() => undefined);
    const { releaseProfileLock } = await import('./stealthBrowser.js');
    releaseProfileLock(profileLock);
  }
}
