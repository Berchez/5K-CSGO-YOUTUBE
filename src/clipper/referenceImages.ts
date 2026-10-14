import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getLogger } from '../logger.js';

/** Caminhos locais das referências (cada uma opcional — tudo degrada). */
export interface ReferenceImages {
  /** Foto oficial do player (infobox da página dele na Liquipedia). */
  player?: string;
  /** Segunda foto do player (galeria da página — uniforme/pose em evento). */
  playerAlt?: string;
  team1Logo?: string;
  team2Logo?: string;
  mapImage?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** HTML via fetch simples; cai para Playwright stealth se o site desafiar. */
export async function fetchHtml(url: string): Promise<string> {
  const log = getLogger();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await res.text();
    if (res.ok && !/just a moment|checking your browser|cf-challenge/i.test(html.slice(0, 5000))) {
      return html;
    }
    throw new Error(`HTTP ${res.status} ou challenge`);
  } catch (e) {
    log.info({ url, err: String(e).slice(0, 80) }, 'fetch direto falhou, tentando Playwright');
    const { getBrowser } = await import('../monitor/hltvMonitor.js');
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(5000);
      return await page.content();
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** Escolhe o melhor título entre resultados de busca (puro, testável). */
export function pickTitle(term: string, titles: string[], teamPrefix = false): string | null {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(term);
  // Times: "Team X" ANTES do exato "X" — existe página "Spirit" que é OUTRO
  // time (logo errado já baixado por causa disso). Player: exato primeiro.
  if (teamPrefix) {
    const withTeam = titles.find((x) => norm(x) === `team${t}`);
    if (withTeam) return withTeam;
  }
  const exact = titles.find((x) => norm(x) === t);
  if (exact) return exact;
  if (teamPrefix) {
    const startsWithTeam = titles.find((x) => norm(x).startsWith(`team${t}`));
    if (startsWithTeam) return startsWithTeam;
  }
  const starts = titles.find((x) => norm(x).startsWith(t));
  if (starts) return starts;
  return titles[0] ?? null;
}

/** Extrai links /team/<id>/<slug> do HTML da busca HLTV (puro, testável). */
export function parseHltvTeamLinks(html: string): Array<{ id: string; slug: string }> {
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

/** og:image de uma página (puro, testável). */
export function parseOgImage(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/**
 * Escolhe o arquivo de logo quadrado (allmode) entre os File: do time (puro).
 * Scoring desambigua times homônimos: "Falcons allmode" traz Falcons Esports
 * (CS), Bad News Falcons (PUBM), Atlanta Falcons (NFL) etc.
 * +3 "esports" (convenção de orgs CS) | +2 "full" (versão vigente)
 * +1 ano mais alto | -1 "academy".
 */
export function pickAllmodeFile(files: string[], teamName: string): string | null {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = norm(teamName);
  const allmodes = files.filter((f) => /allmode\.(png|svg|webp|jpg)/i.test(f));
  if (allmodes.length === 0) return null;
  const scored = allmodes
    .map((f) => {
      const n = norm(f);
      // Válido: começa com a base ou com "team"+base. Elimina homônimos com
      // prefixo estranho (Green Hope High School Falcons, Atlanta Falcons...).
      if (!n.startsWith(base) && !n.startsWith(`team${base}`)) return null;
      const year = Number(f.match(/(19|20)\d{2}/)?.[0] ?? 0);
      let score = 1;
      if (/esports/i.test(f)) score += 3;
      if (/full/i.test(f)) score += 2;
      if (/academy/i.test(f)) score -= 1;
      score += year / 10000;
      return { f, score };
    })
    .filter((x): x is { f: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.f ?? null;
}

/** Busca arquivos File: no repositório COMUNS da Liquipedia (os ícones moram lá). */
export async function liquipediaCommonsFileSearch(term: string): Promise<string[]> {
  const url =
    'https://liquipedia.net/commons/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      list: 'search',
      srsearch: term,
      srnamespace: '6',
      srlimit: '30',
    });
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`liquipedia commons HTTP ${res.status}`);
  const data = (await res.json()) as { query?: { search?: Array<{ title: string }> } };
  return (data.query?.search ?? []).map((r) => r.title.replace(/^File:/i, ''));
}

/**
 * Converte o |image= do infobox (wordmark "full lightmode/darkmode") no nome
 * do allmode QUADRADO da mesma era: "Team Falcons 2022 full lightmode.png"
 * → "Team Falcons 2022 allmode.png" (validado pelo usuário como a logo certa).
 */
export function infoboxToAllmodeName(file: string): string {
  return file.replace(/\s*(full\s*)?(light|dark)mode/i, ' allmode');
}

/**
 * Extrai os arquivos da seção ==Logos== do wikitext do time, em ordem
 * cronológica (última = mais recente). Suporta {{Json|lightmode=X}} e
 * <gallery> "arquivo.png|caption".
 */
export function parseLogosSectionFiles(content: string): string[] {
  const m = content.match(/==\s*Logos\s*==([\s\S]*?)(?=\n==[^=]|$)/i);
  if (!m) return [];
  const section = m[1];
  const files: string[] = [];
  for (const mm of section.matchAll(/lightmode=([^|\n}]+)/gi)) {
    const f = mm[1].trim();
    if (f && !files.includes(f)) files.push(f);
  }
  if (files.length === 0) {
    for (const mm of section.matchAll(
      /^([^|\n=]+?\.(?:png|jpe?g|svg|webp))\s*\|/gim,
    )) {
      const f = mm[1].trim();
      if (f && !files.includes(f)) files.push(f);
    }
  }
  return files;
}

/**
 * Remove o fundo opaco de uma logo por FLOOD-FILL a partir dos 4 cantos:
 * pixels conectados aos cantos com cor ~igual à do canto ficam transparentes.
 * O interior do logo (mesma cor, não conectada) é preservado. Para shots do
 * HLTV — o asset da CDN é opaco e bloqueia download com alpha (HTTP 403).
 */
export async function removeCornerBackground(
  buf: Buffer,
  tolerance = 40,
): Promise<Buffer> {
  const sharpMod = (await import('sharp')).default;
  const { data, info } = await sharpMod(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const key = { r: data[0], g: data[1], b: data[2] };
  const near = (i: number): boolean =>
    Math.abs(data[i] - key.r) <= tolerance &&
    Math.abs(data[i + 1] - key.g) <= tolerance &&
    Math.abs(data[i + 2] - key.b) <= tolerance;
  const visited = new Uint8Array(W * H);
  const stack: Array<[number, number]> = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (visited[p] === 1) continue;
    visited[p] = 1;
    const i = p * 4;
    if (!near(i)) continue;
    data[i + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return sharpMod(data, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Logo do time (hierarquia validada com o usuário):
 * 1. allmode da MESMA era do infobox ("X full lightmode" → "X allmode")
 *    — Falcons: "Team Falcons 2022 allmode.png" ✓
 * 2. última entrada da seção ==Logos== (mais recente da galeria)
 *    — Spirit: "Team Spirit 2021 lightmode.png" ✓ (não há 2022 allmode)
 * 3. commons allmode com scoring (desambigua homônimos)
 * 4. infobox wordmark ("logo secundária") — último recurso Liquipedia
 * 5. HLTV og:image — best-effort, sujeito a Cloudflare
 */
export async function resolveTeamLogoUrl(teamName: string): Promise<string | null> {
  const log = getLogger().child({ refs: 'teamLogo', team: teamName });
  // Página do time: infobox + seção Logos em 1 consulta de wikitext
  let infoboxFile: string | null = null;
  let logosFiles: string[] = [];
  try {
    const data = (await liquipediaJson({
      action: 'query',
      format: 'json',
      list: 'search',
      srsearch: `Team ${teamName}`,
      srnamespace: '0',
      srlimit: '5',
    })) as { query?: { search?: Array<{ title: string }> } };
    const titles = (data.query?.search ?? []).map((r) => r.title);
    const title = pickTitle(teamName, titles, true);
    if (title) {
      const wikitext = await liquipediaPageContent(title);
      infoboxFile = wikitext.match(/\|\s*image\s*=\s*([^\n|}]+)/)?.[1]?.trim() ?? null;
      logosFiles = parseLogosSectionFiles(wikitext);
    }
  } catch (e) {
    log.warn({ err: String(e).slice(0, 100) }, 'liquipedia team page falhou');
  }
  // 1) allmode da mesma era do infobox
  if (infoboxFile) {
    const allmode = infoboxToAllmodeName(infoboxFile);
    if (allmode !== infoboxFile) {
      try {
        const url = await liquipediaFileUrl(allmode);
        if (url) {
          log.info({ file: allmode, kind: 'infobox-allmode' }, 'logo via liquipedia');
          return url;
        }
      } catch {
        // allmode da era não existe: segue para a seção Logos
      }
    }
  }
  // 2) seção Logos: última lightmode listada (mais recente)
  const latest = [...logosFiles].reverse().find(Boolean);
  if (latest) {
    try {
      const url = await liquipediaFileUrl(latest);
      if (url) {
        log.info({ file: latest, kind: 'logos-section' }, 'logo via liquipedia');
        return url;
      }
    } catch {
      // segue
    }
  }
  // 3) commons allmode (scoring desambigua homônimos)
  try {
    const files = await liquipediaCommonsFileSearch(`${teamName} allmode`);
    const allmode = pickAllmodeFile(files, teamName);
    if (allmode) {
      const url = await liquipediaFileUrl(allmode);
      if (url) {
        log.info({ file: allmode, kind: 'commons-allmode' }, 'logo via liquipedia');
        return url;
      }
    }
    log.info('sem allmode no commons, seguindo');
  } catch (e) {
    log.warn({ err: String(e).slice(0, 100) }, 'commons search falhou');
  }
  // 4) infobox wordmark (horizontal — "logo secundária")
  if (infoboxFile) {
    try {
      const url = await liquipediaFileUrl(infoboxFile);
      if (url) {
        log.info({ file: infoboxFile, kind: 'infobox-wordmark' }, 'logo via liquipedia');
        return url;
      }
    } catch {
      // segue
    }
  }
  // 5) HLTV (og:image) — sujeito a Cloudflare, best-effort
  const search = await fetchHtml(
    `https://www.hltv.org/search?query=${encodeURIComponent(teamName)}`,
  );
  const links = parseHltvTeamLinks(search);
  if (links.length === 0) return null;
  const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const best = links.find((l) => l.slug.replace(/-/g, '') === norm) ?? links[0];
  const page = await fetchHtml(`https://www.hltv.org/team/${best.id}/${best.slug}`);
  const og = parseOgImage(page);
  log.info({ team: `${best.id}/${best.slug}`, og: og?.slice(0, 90) }, 'logo via hltv');
  return og;
}

/** Conteúdo bruto (wikitext) de uma página da wiki CS da Liquipedia. */
async function liquipediaPageContent(title: string): Promise<string> {
  const data = (await liquipediaJson({
    action: 'query',
    format: 'json',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: title,
    formatversion: '2',
  })) as {
    query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> };
  };
  return data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? '';
}

async function liquipediaJson(params: Record<string, string>): Promise<unknown> {
  const url =
    'https://liquipedia.net/counterstrike/api.php?' + new URLSearchParams(params);
  const res = await fetch(url, {
    headers: { 'User-Agent': '5k-csgo-youtube/2.0 (thumbnail reference fetcher)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`liquipedia HTTP ${res.status}`);
  return res.json();
}

/** Título da página (player ou mapa) via busca Liquipedia. */
export async function liquipediaTitle(term: string): Promise<string | null> {
  const data = (await liquipediaJson({
    action: 'query',
    format: 'json',
    list: 'search',
    srsearch: term,
    srnamespace: '0',
    srlimit: '5',
  })) as { query?: { search?: Array<{ title: string }> } };
  const titles = (data.query?.search ?? []).map((r) => r.title);
  return pickTitle(term, titles);
}

/** Arquivo |image= do infobox via wikitext. */
export async function liquipediaInfoboxFile(title: string): Promise<string | null> {
  const data = (await liquipediaJson({
    action: 'query',
    format: 'json',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: title,
    formatversion: '2',
  })) as {
    query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> };
  };
  const content = data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? '';
  const m = content.match(/\|\s*image\s*=\s*([^\n|}]+)/);
  return m ? m[1].trim() : null;
}

/** URL direta do arquivo (thumb 800px) via imageinfo. */
export async function liquipediaFileUrl(filename: string): Promise<string | null> {
  const data = (await liquipediaJson({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|size',
    iiurlwidth: '800',
    titles: `File:${filename}`,
    formatversion: '2',
  })) as {
    query?: {
      pages?: Array<{ imageinfo?: Array<{ thumburl?: string; url?: string }> }>;
    };
  };
  const info = data.query?.pages?.[0]?.imageinfo?.[0];
  return info?.thumburl ?? info?.url ?? null;
}

/** Baixa e valida que é imagem (sharp); retorna o destino ou null. */
export async function downloadImage(url: string, dest: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5_000) return null;
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.format) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export interface FetchRefsOptions {
  player: string;
  team1: string;
  team2: string;
  map: string;
  dir: string;
  /** URLs explícitas têm prioridade sobre a busca automática. */
  overrides?: Partial<Record<'player' | 'team1Logo' | 'team2Logo' | 'mapImage', string>>;
}

/**
 * Extrai os arquivos da seção ==Gallery== do wikitext (fotos do player em
 * eventos, com uniforme). Linhas no formato "Arquivo.jpg|caption".
 */
export function parseGalleryFiles(content: string): string[] {
  const m = content.match(/==\s*Gallery\s*==([\s\S]*?)(?=\n==[^=]|$)/i);
  if (!m) return [];
  const files: string[] = [];
  for (const mm of m[1].matchAll(
    /^([^|\n=]+?\.(?:png|jpe?g|svg|webp))\s*\|/gim,
  )) {
    const f = mm[1].trim();
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

/**
 * Baixa as referências (2 fotos do player, logos, mapa). Cada uma é
 * best-effort: falha isolada vira undefined e o prompt degrada sozinho.
 */
export async function fetchReferenceImages(
  opts: FetchRefsOptions,
): Promise<ReferenceImages> {
  const log = getLogger().child({ player: opts.player });
  fs.mkdirSync(opts.dir, { recursive: true });
  const out: ReferenceImages = {};
  const jobs: Array<[string, Promise<Partial<ReferenceImages>>, string]> = [];

  const dl = async (url: string | null, name: string): Promise<string | null> => {
    if (!url) return null;
    return downloadImage(url, path.join(opts.dir, name));
  };

  // Fotos do player: infobox (oficial) + 1ª da galeria (uniforme em evento)
  if (opts.overrides?.player) {
    jobs.push([
      'player',
      (async () => {
        const primary = await dl(opts.overrides?.player ?? null, `ref-player-${slug(opts.player)}.jpg`);
        return primary ? { player: primary } : {};
      })(),
      'override',
    ]);
  } else {
    jobs.push([
      'player',
      (async () => {
        const title = await liquipediaTitle(opts.player);
        if (!title) return {};
        // 1 fetch de wikitext serve as duas fotos
        const content = await liquipediaPageContent(title);
        const infoboxFile = content.match(/\|\s*image\s*=\s*([^\n|}]+)/)?.[1]?.trim();
        const gallery = parseGalleryFiles(content);
        // dedupe: se a 1ª da galeria = infobox, usa a 2ª
        const altFile = gallery.find((f) => f !== infoboxFile) ?? null;
        const [pUrl, aUrl] = await Promise.all([
          infoboxFile ? liquipediaFileUrl(infoboxFile) : Promise.resolve(null),
          altFile ? liquipediaFileUrl(altFile) : Promise.resolve(null),
        ]);
        const result: Partial<ReferenceImages> = {};
        const primary = await dl(pUrl, `ref-player-${slug(opts.player)}.jpg`);
        if (primary) result.player = primary;
        const alt = await dl(aUrl, `ref-player-alt-${slug(opts.player)}.jpg`);
        if (alt) result.playerAlt = alt;
        return result;
      })(),
      'liquipedia',
    ]);
  }

  for (const [key, team] of [
    ['team1Logo', opts.team1],
    ['team2Logo', opts.team2],
  ] as const) {
    const ov = opts.overrides?.[key];
    if (ov) {
      jobs.push([
        key,
        (async () => {
          const local = await dl(ov, `ref-${key}.png`);
          return local ? { [key]: local } : {};
        })(),
        'override',
      ]);
    } else {
      jobs.push([
        key,
        (async () => {
          const url = await resolveTeamLogoUrl(team);
          const local = await dl(url, `ref-${key}.png`);
          return local ? { [key]: local } : {};
        })(),
        'liquipedia/hltv',
      ]);
    }
  }

  if (opts.overrides?.mapImage) {
    jobs.push([
      'mapImage',
      (async () => {
        const local = await dl(opts.overrides?.mapImage ?? null, `ref-map-${slug(opts.map)}.jpg`);
        return local ? { mapImage: local } : {};
      })(),
      'override',
    ]);
  } else if (opts.map && !/^test-?map$/i.test(opts.map)) {
    jobs.push([
      'mapImage',
      (async () => {
        const title = await liquipediaTitle(opts.map);
        if (!title) return {};
        const file = await liquipediaInfoboxFile(title);
        if (!file) return {};
        const url = await liquipediaFileUrl(file);
        const local = await dl(url, `ref-map-${slug(opts.map)}.jpg`);
        return local ? { mapImage: local } : {};
      })(),
      'liquipedia',
    ]);
  }

  for (const [key, p, src] of jobs) {
    try {
      const partial = await p;
      for (const [k, v] of Object.entries(partial)) {
        if (v) out[k as keyof ReferenceImages] = v as string;
      }
      const landed = Object.keys(partial);
      if (landed.length > 0) {
        log.info({ keys: landed, src }, 'referências prontas');
      } else {
        log.info({ key, src }, 'referência indisponível, seguindo sem ela');
      }
    } catch (e) {
      log.warn({ key, err: String(e).slice(0, 120) }, 'falha na referência');
    }
  }
  return out;
}
