/**
 * Logo do time direto da HLTV (fonte autoritativa, sempre atualizada).
 *
 * Roda NO BROWSER COMPARTILHADO do monitor (getBrowser): o Chromium trava
 * o user-data-dir por processo — lançar um 2º contexto persistente no
 * MESMO perfil (o que este módulo fazia) morria em produção ("Target
 * page, context or browser has been closed") e a feature só funcionava
 * no test-vod, com o monitor desligado. O browser do monitor já tem
 * clearance do Cloudflare e abas registradas no sweeper. Qualquer falha
 * retorna null e o pipeline cai no fallback Liquipedia.
 */
import type { Page } from 'playwright';
import { getLogger } from '../logger.js';

export interface HltvLogoOptions {
  /**
   * Perfil persistente COM clearance do Cloudflare. Mantido por
   * compatibilidade com chamadores — o browser compartilhado do monitor
   * já usa cfg.HLTV_PROFILE; este módulo NÃO lança contexto próprio.
   */
  profileDir: string;
}

/** Escolhe a maior entrada de um srcset ("url 100w, url 800w" ou "1x, 2x"). */
export function pickLargestSrcset(srcset: string, fallback: string): string {
  const cands: Array<{ url: string; w: number }> = [];
  for (const part of srcset.split(',')) {
    const m = part.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/);
    if (!m) continue;
    const v = Number.parseFloat(m[2]);
    cands.push({ url: m[1], w: m[3] === 'x' ? v * 1000 : v });
  }
  cands.sort((a, b) => b.w - a.w);
  return cands[0]?.url ?? fallback;
}

/** Links /team/<id>/<slug> num HTML (mesma regra do fetcher Liquipedia). */
export function parseTeamLinks(html: string): Array<{ id: string; slug: string }> {
  const out: Array<{ id: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/\/team\/(\d+)\/([a-z0-9-]+)/gi)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ id: m[1], slug: m[2] });
    }
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function logoSrcFromTeamPage(page: Page): Promise<string | null> {
  try {
    await page.waitForSelector('div.profile-team-logo-container img', { timeout: 30_000 });
  } catch {
    return null;
  }
  try {
    const found = (await page.evaluate(`(() => {
      const img = document.querySelector('div.profile-team-logo-container img');
      if (!img) return null;
      return { src: img.currentSrc || img.src || '', srcset: img.getAttribute('srcset') || '' };
    })()`)) as { src: string; srcset: string } | null;
    if (!found?.src) return null;
    const url = found.srcset ? pickLargestSrcset(found.srcset, found.src) : found.src;
    return url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

/**
 * Baixa a imagem cross-origin (img-cdn tem Cloudflare próprio, separado do
 * www — o GET via contexto falha e o canvas-export é barrado por CORS).
 * Ordem: GET com cookies do contexto → screenshot do elemento renderizado
 * (captura pixels, imune a CORS) → navegação direta + screenshot.
 */
async function downloadHltvImage(page: Page, src: string): Promise<Buffer | null> {
  const { downloadPageImage } = await import('./chatgpt.js');
  try {
    const buf = await downloadPageImage(page, src);
    if (buf.length >= 2_000) return buf;
  } catch {
    // segue p/ screenshot
  }
  try {
    const shot = await page.locator('div.profile-team-logo-container img').screenshot({ timeout: 15_000 });
    if (shot.length >= 1_000) return shot;
  } catch {
    // segue p/ navegação direta
  }
  const { trySolveChallenge } = await import('./stealthBrowser.js');
  const log = getLogger().child({ refs: 'hltv-logo' });
  await page.goto(src, { waitUntil: 'load', timeout: 60_000 });
  await trySolveChallenge(page, log);
  await page.waitForTimeout(2000);
  try {
    const shot = await page.locator('img').first().screenshot({ timeout: 15_000 });
    return shot.length >= 1_000 ? shot : null;
  } catch {
    return null;
  }
}

/**
 * Baixa a logo vigente do time na HLTV. Retorna bytes (png/jpg) ou null.
 * Nunca joga erro: falha = fallback Liquipedia no chamador.
 */
export async function fetchHltvTeamLogo(
  teamName: string,
  opts: HltvLogoOptions,
): Promise<Buffer | null> {
  const log = getLogger().child({ refs: 'hltv-logo', team: teamName });
  void opts; // compatibilidade: o browser compartilhado já usa o perfil certo
  let page: Page | null = null;
  try {
    const { newTrackedPage, waitForClearance } = await import('../monitor/hltvMonitor.js');
    page = await newTrackedPage();

    await page.goto(`https://www.hltv.org/search?query=${encodeURIComponent(teamName)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!(await waitForClearance(page))) {
      log.warn('busca HLTV bloqueada pelo Cloudflare');
      return null;
    }
    const links = parseTeamLinks(await page.content());
    if (links.length === 0) {
      log.warn('busca HLTV sem times');
      return null;
    }
    const n = norm(teamName);
    const exact = links.find((l) => l.slug.replace(/-/g, '') === n);
    const best = exact ?? links[0];
    if (!exact) {
      log.warn({ escolhido: `${best.id}/${best.slug}` }, 'slug sem match exato — risco de time homônimo');
    }
    log.info({ team: `${best.id}/${best.slug}` }, 'time na HLTV');

    await page.goto(`https://www.hltv.org/team/${best.id}/${best.slug}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!(await waitForClearance(page))) {
      log.warn('página do time bloqueada pelo Cloudflare');
      return null;
    }
    const src = await logoSrcFromTeamPage(page);
    if (!src) {
      log.warn('logo não encontrada na página do time');
      return null;
    }
    let buf = await downloadHltvImage(page, src);
    if (!buf || buf.length < 1_000) {
      log.warn('download da logo falhou');
      return null;
    }
    // Screenshot do elemento carrega o FUNDO da página embutido: remove o
    // fundo opaco por flood-fill dos cantos (best-effort — falha segue cru).
    try {
      const { removeCornerBackground } = await import('./referenceImages.js');
      buf = await removeCornerBackground(buf);
    } catch {
      // segue com o buffer original
    }
    log.info({ bytes: buf.length }, 'logo via hltv');
    return buf;
  } catch (e) {
    log.warn({ err: String(e).slice(0, 140) }, 'hltv falhou, segue liquipedia');
    return null;
  } finally {
    if (page) await page.close().catch(() => undefined);
  }
}
