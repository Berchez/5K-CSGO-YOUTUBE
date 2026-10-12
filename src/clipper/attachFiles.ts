import type { Page } from 'playwright';
import type pino from 'pino';

/**
 * Anexa arquivos no composer (ChatGPT/Gemini). Ordem de estratégia:
 * 1. input[type=file][multiple] — um setInputFiles com todos.
 * 2. input[type=file] comum — um arquivo por vez (input single aceita 1).
 * 3. Sem input visível: clica no botão de anexo (+/clipe) e repete 1-2.
 * Aguarda previews (imgs blob:/data:) antes de retornar. Best-effort:
 * falha retorna false e o prompt segue só com texto.
 */
export async function attachFiles(
  page: Page,
  log: pino.Logger,
  files: string[],
): Promise<boolean> {
  if (files.length === 0) return true;
  const existing = page.locator('input[type="file"]');
  if ((await existing.count()) === 0) {
    // UI esconde o input atrás do botão de anexo
    const attachBtn = page
      .getByRole('button', { name: /attach|anexar|clip|upload|\+/i })
      .first();
    if ((await attachBtn.count()) > 0) {
      await attachBtn.click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
    }
  }

  const multiple = page.locator('input[type="file"][multiple]').first();
  const single = page.locator('input[type="file"]').first();
  try {
    if ((await multiple.count()) > 0) {
      await multiple.setInputFiles(files);
    } else {
      for (const f of files) {
        await single.setInputFiles(f);
        await page.waitForTimeout(2500);
      }
    }
    // Aguarda previews ESTABILIZAREM (uploads são assíncronos): a contagem de
    // imgs precisa parar de mudar por 2 ciclos seguidos, senão o 'before' do
    // provider captura previews pela metade e o polling os acha como "novos".
    let lastCount = -1;
    let stable = 0;
    for (let i = 0; i < 10 && stable < 2; i++) {
      await page.waitForTimeout(3000);
      const count = (await page
        .evaluate(`document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length`)
        .catch(() => -1)) as number;
      if (count === lastCount) stable++;
      else stable = 0;
      lastCount = count;
    }
    log.info({ n: files.length, previews: lastCount }, 'arquivos anexados (previews estáveis)');
    return true;
  } catch (e) {
    log.warn({ err: String(e).slice(0, 160) }, 'falha ao anexar, seguindo só com texto');
    return false;
  }
}
