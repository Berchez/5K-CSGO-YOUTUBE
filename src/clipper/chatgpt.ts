import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ProfileLock } from './stealthBrowser.js';
import { getLogger } from '../logger.js';

export interface ChatGptOptions {
  profileDir: string;
  headless?: boolean;
  /** default false (janela visível): minimizada o Cloudflare encrenca. */
  minimized?: boolean;
  timeoutMs?: number;
  /** Caminhos locais de imagens de referência (foto, logos, mapa). */
  attachments?: string[];
}

export const NEED_CHATGPT_LOGIN_MESSAGE =
  'ChatGPT sem login. Rode uma vez: npx tsx scripts/chatgpt-login.ts ' +
  '(abre o Chrome — use UMA CONTA DESCARTÁVEL, nunca contas importantes) ' +
  'e faça login manualmente.';

/** Baixa imagem da página: http(s) via request; blob:/data: ou falha via canvas. */
export async function downloadPageImage(page: Page, src: string): Promise<Buffer> {
  if (!src.startsWith('blob:') && !src.startsWith('data:')) {
    try {
      const resp = await page.request.get(src, { timeout: 60_000 });
      if (resp.ok()) return Buffer.from(await resp.body());
    } catch {
      // cai para o canvas abaixo
    }
  }
  const dataUrl = (await page.evaluate(
    `((u) => {
      const img = Array.from(document.querySelectorAll('img'))
        .find((i) => (i.currentSrc || i.src) === u);
      if (!img) throw new Error('img saiu do DOM antes da captura');
      if ((img.naturalWidth || 0) < 64) throw new Error('img ainda carregando');
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('sem contexto 2d');
      ctx.drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    })(${JSON.stringify(src)})`,
  )) as string;
  return Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
}

/** Lista srcs de imagens GRANDES (>=minWidth), ignorando UI/avatares. */
export async function listContentImages(page: Page, minWidth = 256): Promise<string[]> {
  const expr = `Array.from(document.querySelectorAll('img'))
    .filter((i) => {
      const w = i.naturalWidth || 0;
      const s = ((i.currentSrc || i.src) + ' ' + (i.alt || '') + ' ' + (i.className || '')).toLowerCase();
      return w >= ${minWidth} && !/avatar|profile|logo|icon|emoji|badge/.test(s);
    })
    .map((i) => i.currentSrc || i.src)`;
  return (await page.evaluate(`(${expr})`)) as string[];
}

/**
 * Gera imagem via app web do ChatGPT (chatgpt.com) com Playwright.
 *
 * AVISOS:
 * - Automatizar a UI web viola os Termos da OpenAI. Use conta descartável;
 *   NUNCA contas importantes (risco de suspensão).
 * - Layout muda sem aviso: qualquer falha retorna erro e o pipeline cai no
 *   fallback. Provider experimental/opt-in.
 */
export async function chatgptBackground(
  prompt: string,
  opts: ChatGptOptions,
): Promise<Buffer> {
  // Headless cai no desafio Cloudflare com frequência; headed minimizado tem
  // fingerprint limpo e quase não aparece (só ícone na barra por alguns min).
  const headless = opts.headless ?? false;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const log = getLogger().child({ provider: 'chatgpt' });
  fs.mkdirSync(opts.profileDir, { recursive: true });

  const failShot = async (page: Page, why: string): Promise<void> => {
    try {
      fs.mkdirSync('./logs', { recursive: true });
      const shot = path.join('./logs', `chatgpt-fail-${Date.now()}.png`);
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
      headless,
      extraArgs: opts.minimized ? ['--start-minimized'] : [],
    });
    const page = browser.pages()[0] ?? (await browser.newPage());
    const { closeForeignTabs } = await import('./stealthBrowser.js');
    await closeForeignTabs(browser, page, log);
    log.info('abrindo chatgpt.com');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);

    if (!(await trySolveChallenge(page, log))) {
      await failShot(page, 'bloqueado pelo desafio Cloudflare');
      throw new Error(
        'ChatGPT bloqueado pelo desafio Cloudflare mesmo após tentativas. ' +
          'Tente de novo mais tarde (IP pode estar marcado) ou use outro provider.',
      );
    }

    if (
      page.url().includes('auth.openai.com') ||
      (await page.getByRole('button', { name: /log in|sign up/i }).count()) > 0
    ) {
      await failShot(page, 'sem login');
      throw new Error(NEED_CHATGPT_LOGIN_MESSAGE);
    }
    log.info('login OK, procurando composer');

    let box = page.locator('#prompt-textarea').first();
    if ((await box.count()) === 0) {
      box = page.locator('div[contenteditable="true"], textarea').first();
      if ((await box.count()) === 0) {
        await failShot(page, 'sem composer');
        throw new Error('composer do ChatGPT não encontrado (layout mudou?)');
      }
    }
    const attachments = (opts.attachments ?? []).filter(Boolean) as string[];
    if (attachments.length > 0) {
      const { attachFiles } = await import('./attachFiles.js');
      const res = await attachFiles(page, log, attachments, { newChat: true });
      if (!res.ok) {
        await failShot(page, 'anexos com falha');
        throw new Error(
          'upload de anexos falhou no ChatGPT (' +
            res.failed.map((f) => `${f.file}: ${f.reason}`).join(' | ') +
            ') — abortando antes do envio',
        );
      }
    }
    // 'before' DEPOIS do anexo: previews das referências já contam como
    // "imagens de antes" — só a resposta gerada é imagem NOVA.
    const before = await listContentImages(page);
    log.info({ imagensAntes: before.length, anexos: attachments.length }, 'enviando prompt de imagem');
    await box.click({ timeout: 15_000 });
    await page.keyboard.press('Escape').catch(() => undefined);
    await box.fill(prompt);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    log.info({ conversa: page.url() }, 'prompt enviado, aguardando render da imagem');

    // Carência de 20s + validação por TAMANHO DE DOWNLOAD: previews dos anexos
    // são pequenos (<=50KB); imagens GERADAS por este prompt foram 300KB+.
    // Candidato só vale se baixar >=100KB — imune a previews tardios.
    const graceUntil = Date.now() + 20_000;
    // Teto alto de propósito: o configurável THUMB_AI_TIMEOUT_MS (default 10min)
    // precisa valer — render web às vezes passa de 5min.
    const deadline = Date.now() + Math.min(timeoutMs, 1_800_000);
    const MIN_BYTES = 100_000;
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
        continue; // navegação do SPA: tenta de novo
      }
      // Testa do mais novo pro mais velho; srcs testados entram em 'seen'
      for (const src of fresh.reverse()) {
        seen.add(src);
        try {
          const cand = await downloadPageImage(page, src);
          if (cand.length >= MIN_BYTES) {
            buf = cand;
            break;
          }
        } catch {
          // preview inválido/revogado: segue
        }
      }
    }
    if (!buf) {
      await failShot(page, 'timeout sem imagem');
      throw new Error(
        'ChatGPT não retornou imagem a tempo — veja logs/chatgpt-fail-*.png. ' +
          'Causas comuns: cota grátis esgotada, ou resposta em texto.',
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
