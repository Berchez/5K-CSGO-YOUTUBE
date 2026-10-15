import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type pino from 'pino';

/**
 * Anexa arquivos no composer (ChatGPT/Grok/Gemini).
 *
 * Causa raiz da falha ChatGPT (repro com evidência em logs/repro-*):
 * 1. `POST backend-api/files` → 429 em TODOS (conta free throttled; banner
 *    "Estamos com problemas para processar uploads no momento"). Nenhum
 *    método de anexo passa por 429 — a correção é detectar rápido, retry
 *    limitado e abortar com erro claro (fallback p/ próximo provider).
 * 2. Duplicação (3 arquivos 2x = 6 pills): o retry cego de setInputFiles
 *    re-disparava change e o app ANEXAVA DE NOVO; e pills/texto de runs
 *    mortas persistem no draft restaurado (9 pills = 3 restos + 3 + 3).
 *    Agora: UM set por arquivo, verificação por DELTA de pills (contagem
 *    antes/depois — restos não enganam), SEMPRE sem re-set sem remoção
 *    verificada. input.files NÃO serve de verificação (o app limpa o input).
 */
export interface AttachResult {
  ok: boolean;
  attached: string[];
  failed: Array<{ file: string; reason: string }>;
}

export interface AttachOptions {
  /** Clica em "Novo chat" antes (best-effort contra draft persistido). Só ChatGPT. */
  newChat?: boolean;
  /** Teto total do anexo (ms). Default 210s — nunca trava o pipeline. */
  budgetMs?: number;
}

/** Dedupe por caminho absoluto (puro/testável). */
export function dedupeFiles(files: string[]): { unique: string[]; dupes: string[] } {
  const seen = new Set<string>();
  const unique: string[] = [];
  const dupes: string[] = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) dupes.push(f);
    else {
      seen.add(abs);
      unique.push(abs);
    }
  }
  return { unique, dupes };
}

/** Textos de falha de upload (PT/EN) — pills e banner. */
export const FAIL_PATTERNS = [
  /falha no upload/i,
  /upload failed/i,
  /failed to upload/i,
  /erro no upload/i,
  /não foi possível anexar/i,
  /couldn't upload/i,
];

/** Textos de indisponibilidade do backend de upload (banner). */
export const BACKEND_DOWN_PATTERNS = [
  /problemas para processar uploads/i,
  /trouble.*uploads/i,
  /try again later/i,
  /tente novamente mais tarde/i,
];

/** Puro/testável: algum padrão casa com o texto? */
export function matchesAny(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function textCount(page: Page, text: string): Promise<number> {
  try {
    return await page.getByText(text, { exact: false }).count();
  } catch {
    return -1;
  }
}

/** Banner de backend fora do ar, se visível (p/ motivo descritivo). */
async function failureBanner(page: Page): Promise<string | null> {
  for (const pat of BACKEND_DOWN_PATTERNS) {
    try {
      const loc = page.getByText(pat, { exact: false });
      if ((await loc.count()) > 0) {
        const t = await loc.first().textContent().catch(() => null);
        if (t) return t.trim().slice(0, 160);
        return pat.source;
      }
    } catch {
      // segue
    }
  }
  return null;
}

async function failurePresent(page: Page): Promise<boolean> {
  for (const pat of FAIL_PATTERNS) {
    try {
      if ((await page.getByText(pat, { exact: false }).count()) > 0) return true;
    } catch {
      // segue
    }
  }
  return false;
}

/**
 * Remove as pills contendo o basename (clica o × da pill). Retorna true
 * SOMENTE se a contagem caiu — remoção não verificada = risco de duplicar
 * no re-set, então o chamador ABORTA em vez de tentar de novo.
 */
async function removePills(page: Page, log: pino.Logger, basenames: string[]): Promise<boolean> {
  const before: Record<string, number> = {};
  for (const b of basenames) before[b] = await textCount(page, b);
  try {
    await page.evaluate((names) => {
      const clicked = new Set<Element>();
      for (const n of names) {
        // Candidatos que contêm o nome, do MAIS específico (a pill) para o
        // mais genérico (wrappers do composer). O primeiro com botão DENTRO
        // DE SI é o container da pill. Antes: qualquer elemento pequeno
        // com o texto clicava o ÚLTIMO botão dos seus descendentes —
        // wrappers casavam e o "último botão" era o ENVIAR.
        const cands = Array.from(document.querySelectorAll('*'))
          .filter((e) => (e.textContent || '').includes(n))
          .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        for (const el of cands) {
          if (el.children.length > 6) break; // já é wrapper grande: para
          const btns = Array.from(el.querySelectorAll('button'));
          if (btns.length === 0) continue; // sobe um nível (pai da pill)
          const btn =
            btns.find((b) =>
              /remove|remover|delete|excluir|close|fechar|×|\bx\b/i.test(
                b.getAttribute('aria-label') || b.textContent || '',
              )) ?? btns[btns.length - 1];
          if (btn && !clicked.has(btn)) {
            clicked.add(btn);
            (btn as HTMLButtonElement).click();
          }
          break; // só o candidato mais específico com botão
        }
      }
    }, basenames);
  } catch {
    return false;
  }
  await sleep(3000);
  for (const b of basenames) {
    const after = await textCount(page, b);
    if (after < 0 || after >= before[b]) {
      log.warn({ file: b, antes: before[b], depois: after }, 'remoção de pill não verificada');
      return false;
    }
  }
  return true;
}

export async function attachFiles(
  page: Page,
  log: pino.Logger,
  files: string[],
  opts: AttachOptions = {},
): Promise<AttachResult> {
  const fail = (failed: AttachResult['failed']): AttachResult => ({ ok: false, attached: [], failed });
  if (files.length === 0) return { ok: true, attached: [], failed: [] };
  const { unique, dupes } = dedupeFiles(files);
  if (dupes.length > 0) log.warn({ dupes: dupes.map((f) => path.basename(f)) }, 'anexos duplicados descartados');
  const missing = unique.filter((f) => {
    try {
      return !fs.existsSync(f) || fs.statSync(f).size === 0;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    return fail(missing.map((f) => ({ file: path.basename(f), reason: 'arquivo ausente ou 0 bytes' })));
  }
  const budgetMs = opts.budgetMs ?? 210_000;
  const deadline = Date.now() + budgetMs;
  const basenames = unique.map((f) => path.basename(f));

  // Draft persistido (texto E pills de runs mortas): novo chat começa limpo.
  // Best-effort — a verificação por delta abaixo protege mesmo se falhar.
  if (opts.newChat) {
    try {
      const btn = page.getByRole('button', { name: /novo chat|new chat/i }).first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 8000 }).catch(() => undefined);
        await sleep(2500);
        log.info('novo chat solicitado (draft anterior deve sumir)');
      }
    } catch {
      // segue com o chat atual (delta protege)
    }
  }

  const existing = page.locator('input[type="file"]');
  if ((await existing.count()) === 0) {
    const attachBtn = page
      .getByRole('button', { name: /attach|anexar|clip|upload|\+/i })
      .first();
    if ((await attachBtn.count()) > 0) {
      await attachBtn.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(1500);
    }
  }

  // Baseline por arquivo: restos de runs mortas NÃO contam como nossos.
  const baseline: Record<string, number> = {};
  for (const b of basenames) baseline[b] = await textCount(page, b);
  // Baseline de previews (blob:/data:): UIs que renderizam thumbnail sem
  // o nome do arquivo — verificação só por texto dava falso "não subiu".
  const baselineImgs = await previewImgCount(page);

  async function setOnce(): Promise<void> {
    const multiple = page.locator('input[type="file"][multiple]').first();
    if ((await multiple.count()) > 0) {
      await multiple.setInputFiles(unique);
    } else {
      for (const f of unique) {
        const btn = page.getByRole('button', { name: /attach|anexar|clip|upload|\+/i }).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 5000 }).catch(() => undefined);
          await sleep(800);
        }
        await page.locator('input[type="file"]').first().setInputFiles(f);
        await sleep(2500);
      }
    }
    // Escape dispensa menu/chooser nativo aberto (senão engole o Enter do envio).
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  /** Imagens de preview no composer (blob:/data:) — thumbnails de anexos. */
  async function previewImgCount(p: Page): Promise<number> {
    try {
      return await p.locator('img[src^="blob:"], img[src^="data:"]').count();
    } catch {
      return -1;
    }
  }

  // UM set; verificação por DELTA (+1 pill por arquivo). NUNCA re-set sem
  // remoção verificada — re-set cego duplica (3 arquivos 2x = 6 pills).
  async function deltaOk(): Promise<boolean> {
    for (const b of basenames) {
      const c = await textCount(page, b);
      if (c < 0 || c < baseline[b] + 1) return false;
    }
    return true;
  }

  // Fallback p/ UIs sem nome textual: +1 preview por arquivo também prova
  // que subiu (ex.: composer com thumbnail sem nome/truncado).
  let viaPreview = false;
  async function presentOk(): Promise<boolean> {
    if (await deltaOk()) return true;
    const imgs = await previewImgCount(page);
    viaPreview = imgs >= 0 && imgs >= baselineImgs + unique.length;
    return viaPreview;
  }

  // Previews estabilizados (duas amostras iguais): sem isso o 'before' do
  // provider capturava thumbnails pela metade e a referência (mapa/logo)
  // podia passar por "imagem gerada" por já existir no momento do envio.
  async function previewsStable(): Promise<boolean> {
    const a = await previewImgCount(page);
    await sleep(1500);
    const b = await previewImgCount(page);
    return a >= 0 && a === b;
  }

  try {
    await setOnce();
  } catch (e) {
    return fail(unique.map((f) => ({ file: path.basename(f), reason: `setInputFiles: ${String(e).slice(0, 120)}` })));
  }
  const presentDeadline = Date.now() + 30_000;
  while (Date.now() < Math.min(presentDeadline, deadline) && !(await presentOk())) {
    await sleep(2500);
  }
  if (!(await presentOk())) {
    return fail(basenames.map((f) => ({ file: f, reason: 'pill não apareceu no composer (upload nem iniciou)' })));
  }

  // Conclusão: sem texto de falha. Retries SÓ com remoção verificada antes
  // (remove tudo nosso, confirma, backoff, anexa de novo). Sem isso, aborta.
  // Cada setOnce é VERIFICADO na volta do loop — o fluxo antigo verificava
  // só a 1ª tentativa e o resultado do último retry era descartado.
  for (let attempt = 0; ; attempt++) {
    if (!(await failurePresent(page))) {
      await sleep(4000);
      if (!(await failurePresent(page))) {
        const stableUntil = Date.now() + 10_000;
        while (Date.now() < Math.min(stableUntil, deadline) && !(await previewsStable())) {
          // previews ainda assentando
        }
        log.info({ n: basenames.length, viaPreview }, 'arquivos anexados (upload OK)');
        return { ok: true, attached: basenames, failed: [] };
      }
    }
    if (attempt >= 2 || Date.now() >= deadline) break;
    const banner = await failureBanner(page);
    log.warn({ attempt: attempt + 1, banner }, 'falha no upload detectada');
    if (!(await removePills(page, log, basenames))) {
      const banner2 = await failureBanner(page);
      return fail(
        basenames.map((f) => ({
          file: f,
          reason: `Falha no upload e remoção não verificada (sem retry seguro)${banner2 ? ` — backend: ${banner2}` : ''}`,
        })),
      );
    }
    await sleep(10000);
    try {
      await setOnce();
    } catch (e) {
      return fail(unique.map((f) => ({ file: path.basename(f), reason: `retry setInputFiles: ${String(e).slice(0, 120)}` })));
    }
    await sleep(15000);
  }
  const banner = await failureBanner(page);
  return fail(
    basenames.map((f) => ({
      file: f,
      reason: banner ? `backend de upload indisponível (${banner})` : 'Falha no upload persistente após retries',
    })),
  );
}
