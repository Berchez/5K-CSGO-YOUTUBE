import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ProfileLock } from './stealthBrowser.js';
import { getLogger } from '../logger.js';

export interface GeminiWebOptions {
  profileDir: string;
  /** default true (sem janela). Se o Google barrar headless, rode headed. */
  headless?: boolean;
  timeoutMs?: number;
  /** Caminhos locais de imagens de referência (foto, logos, mapa). */
  attachments?: string[];
}

export const NEED_LOGIN_MESSAGE =
  'Gemini web sem login. Rode uma vez: npx tsx scripts/gemini-login.ts ' +
  '(abre o Chrome com UMA CONTA DESCARTÁVEL — nunca a conta dona do canal) ' +
  'e faça login manualmente.';

/**
 * Gera imagem via app web do Gemini (gemini.google.com) com Playwright.
 *
 * AVISOS:
 * - Automatizar a UI web viola os Termos do Google. Use conta descartável;
 *   NUNCA a conta dona do canal/projeto (risco de suspensão = morte do projeto).
 * - Layout do site muda sem aviso: qualquer falha retorna erro e o pipeline
 *   cai no fallback (thumb composta). Este provider é experimental/opt-in.
 */
export async function geminiWebBackground(
  prompt: string,
  opts: GeminiWebOptions,
): Promise<Buffer> {
  const headless = opts.headless ?? true;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  fs.mkdirSync(opts.profileDir, { recursive: true });

  let browser: Awaited<ReturnType<typeof import('./stealthBrowser.js').launchStealthContext>> | null = null;
  let profileLock: ProfileLock | null = null;
  const log = getLogger().child({ provider: 'gemini-web' });
  // O prefixo explícito ATIVA o modo de geração — sem ele o app responde com
  // TEXTO ("Sou apenas um modelo de linguagem"). Os textos do layout são
  // desejados (thumb completa), então o prefixo pede a imagem COM eles.
  const imagePrompt =
    `Generate a YouTube thumbnail image (16:9, 1920x1080) following this creative brief EXACTLY, ` +
    `rendering ALL specified text elements exactly as written:\n${prompt}`;
  const failShot = async (page: Page, why: string): Promise<void> => {
    try {
      const dir = './logs';
      fs.mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, `gemini-fail-${Date.now()}.png`);
      await page.screenshot({ path: shot });
      log.warn({ shot, why }, 'screenshot da falha salvo (abra para ver o estado da página)');
    } catch {
      log.warn({ why }, 'falha sem screenshot');
    }
  };
  try {
    const { launchStealthContext, trySolveChallenge, acquireProfileLock } = await import('./stealthBrowser.js');
    profileLock = await acquireProfileLock(opts.profileDir, log);
    browser = await launchStealthContext({
      profileDir: opts.profileDir,
      headless,
    });
    const page = browser.pages()[0] ?? (await browser.newPage());
    const { closeForeignTabs } = await import('./stealthBrowser.js');
    await closeForeignTabs(browser, page, log);
    log.info('abrindo gemini.google.com/app');
    await page.goto('https://gemini.google.com/app', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);

    await trySolveChallenge(page, log);

    if (
      page.url().includes('accounts.google.com') ||
      (await page.getByRole('button', { name: /sign in|fazer login/i }).count()) > 0
    ) {
      await failShot(page, 'sem login');
      throw new Error(NEED_LOGIN_MESSAGE);
    }
    log.info('login OK, procurando composer');

    // Composer: tenta seletores do mais semântico ao mais genérico
    const findBox = async () => {
      let b = page.getByRole('textbox').first();
      if ((await b.count()) === 0) {
        b = page.locator('div[contenteditable="true"], textarea').first();
      }
      return b;
    };
    let box = await findBox();
    if ((await box.count()) === 0) {
      await failShot(page, 'sem composer');
      throw new Error('composer do Gemini não encontrado (layout mudou?)');
    }
    // Detecção por TAMANHO (naturalWidth>=256), não por host: o Gemini serve
    // renders de hosts variados (lh3 ou outros) e o host muda sem aviso.
    // Filtra avatares/logos/ícones de UI pelo src/alt/classe.
    // Expressão única reutilizada em evaluate e waitForFunction.
    const listImgsJs = `Array.from(document.querySelectorAll('img'))
      .filter((i) => {
        const w = i.naturalWidth || 0;
        const s = ((i.currentSrc || i.src) + ' ' + (i.alt || '') + ' ' + (i.className || '')).toLowerCase();
        return w >= 256 && !/avatar|profile|logo|icon|emoji|badge/.test(s);
      })
      .map((i) => i.currentSrc || i.src)`;
    const attachments = (opts.attachments ?? []).filter(Boolean) as string[];
    if (attachments.length > 0) {
      const { attachFiles } = await import('./attachFiles.js');
      const res = await attachFiles(page, log, attachments);
      if (!res.ok) log.warn('anexos incompletos — prompt segue com texto + o que subiu');
      // O attach re-renderiza o composer: re-localiza antes de digitar,
      // senão fill+Enter vão para elemento stale e a conversa não nasce.
      box = await findBox();
      if ((await box.count()) === 0) {
        await failShot(page, 'sem composer pós-anexo');
        throw new Error('composer do Gemini sumiu após anexar (layout mudou?)');
      }
    }
    // 'before' DEPOIS do anexo: previews das referências já contam como
    // "imagens de antes" — só a resposta gerada é imagem NOVA.
    const before: string[] = await page.evaluate(`(${listImgsJs})`);
    log.info({ imagensAntes: before.length, anexos: attachments.length }, 'enviando prompt de imagem');
    await box.click({ timeout: 15_000 });
    await page.keyboard.press('Escape').catch(() => undefined); // fecha popups
    await box.fill(imagePrompt);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    // Com anexo o Enter pode não submeter (upload em processamento): se a URL
    // ainda é /app sem chatId, clica no botão de enviar e espera mais.
    if (/\/app\/?$/.test(page.url())) {
      const sendBtn = page
        .locator('button[aria-label*="send" i], button[aria-label*="enviar" i], button[type="submit"]')
        .last();
      if ((await sendBtn.count()) > 0) {
        log.info('Enter não criou a conversa, clicando botão de enviar');
        await sendBtn.click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(8000);
      }
    }
    // Prova de entrega: após o envio o app navega para /app/<chatId>.
    // Essa URL SÓ existe se o servidor recebeu o prompt — confira logado
    // com a MESMA conta da automação (não a conta do canal).
    log.info({ conversa: page.url() }, 'prompt enviado, aguardando render da imagem');

    // Aguarda imagem NOVA da resposta com polling manual (evaluate por vez):
    // waitForFunction quebra se o SPA do Gemini navegar no meio (contexto destruído).
    // Polling com validação por tamanho de download: previews de anexos são
    // pequenos; fundos gerados têm sido >=50KB. Imune a previews tardios.
    // Teto alto de propósito: ver chatgpt.ts (THUMB_AI_TIMEOUT_MS).
    const deadline = Date.now() + Math.min(timeoutMs, 1_800_000);
    const MIN_BYTES = 50_000;
    let buf: Buffer | null = null;
    const seen = new Set<string>(before);
    while (Date.now() < deadline && !buf) {
      await page.waitForTimeout(5000);
      let fresh: string[] = [];
      try {
        const after: string[] = (await page.evaluate(`(${listImgsJs})`)) as string[];
        fresh = after.filter((s) => !seen.has(s));
      } catch {
        continue; // navegação do SPA: tenta de novo
      }
      for (const src of fresh.slice().reverse()) {
        seen.add(src);
        try {
          const { downloadPageImage } = await import('./chatgpt.js');
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
      await failShot(page, 'timeout sem imagem (cota? texto em vez de imagem?)');
      throw new Error(
        'Gemini não retornou imagem a tempo — veja logs/gemini-fail-*.png. ' +
          'Causas comuns: cota grátis esgotada, ou resposta em texto.',
      );
    }
    log.info({ bytes: buf.length, conversa: page.url() }, 'fundo IA baixado');
    if (process.env.GEMINI_DEBUG_SHOTS === '1') {
      try {
        const shot = path.join('./logs', `gemini-ok-${Date.now()}.png`);
        await page.screenshot({ path: shot });
        log.info({ shot }, 'screenshot de sucesso salvo');
      } catch { /* melhor esforço */ }
    }
    return buf;
  } finally {
    await browser?.close().catch(() => undefined);
    const { releaseProfileLock } = await import('./stealthBrowser.js');
    releaseProfileLock(profileLock);
  }
}
