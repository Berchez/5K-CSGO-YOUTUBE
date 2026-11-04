import sharp from 'sharp';

/**
 * Faixa do topo do Short quando NÃO há cam do streamer (canal sem cam
 * mapeada): fundo escuro + título do vídeo. É o substituto da cam, no
 * mesmo espaço (1080x540 por padrão) — o jogo continua embaixo.
 *
 * Determinístico e sem fonte externa: o texto vira SVG e o sharp
 * rasteriza (mesmo caminho do `thumbnailOverlay`).
 */

const ACCENT = '#e10600';
const ACCENT_2 = '#ffd400';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tira os caracteres que a fonte da faixa NÃO tem (emoji, símbolos).
 *
 * A fonte é do sistema (Arial Black) e o SVG é rasterizado sem fallback
 * de emoji: um emoji no título do vídeo viraria um quadradinho (tofu)
 * no topo do Short. Acento português continua ✓.
 */
export function stripUnsupportedGlyphs(text: string): string {
  return String(text ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\u0000-\u{001F}\u{007F}]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Quebra o texto em linhas de até `maxChars` (palavra inteira quando
 * couber; palavra maior que a linha é cortada). Acima de `maxLines` a
 * última linha ganha reticências — a faixa não pode ser um mural.
 */
export function wrapShortTitle(
  title: string | null | undefined,
  maxChars = 20,
  maxLines = 3,
): string[] {
  const limit = Math.max(4, Math.floor(maxChars));
  const words = stripUnsupportedGlyphs(String(title ?? ''))
    .split(/\s+/)
    .filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    let rest = word;
    while (rest.length > limit) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = current ? `${current} ${rest}` : rest;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = rest;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) return [];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines - 1));
  const tail = lines.slice(Math.max(1, maxLines - 1), maxLines).join(' ');
  kept.push(`${tail.slice(0, Math.max(1, limit - 1))}…`);
  return kept;
}

export interface ShortBannerText {
  /** Título (o mesmo do vídeo, quando houver). */
  title: string;
  /** Linha menor: jogador, confronto, evento. */
  subtitle?: string | null;
}

/**
 * Largura estimada do texto como fração da fonte.
 *
 * A fonte do banner é a do sistema (Arial Black), então não dá para
 * medir o texto de verdade: a estimativa é conservadora (Arial Black é
 * larga) e o `textLength` do SVG fecha a conta — a linha que ainda
 * assim estouraria é espremida até caber.
 */
const CHAR_WIDTH_RATIO = 0.62;
const CHAR_WIDTH_RATIO_SUBTITLE = 0.55;
/** Margem lateral da faixa (o texto não encosta na borda). */
const BANNER_SIDE_MARGIN = 0.92;

export interface BannerFit {
  /** Linhas do título já quebradas. */
  lines: string[];
  /** Tamanho da fonte do título (px). */
  size: number;
  /** Subtítulo cortado para caber. */
  subtitle: string;
  /** Tamanho da fonte do subtítulo (px). */
  subtitleSize: number;
  /**
   * Largura máxima de cada linha (px). A linha que passa disso é
   * espremida pelo SVG (`textLength`).
   */
  maxWidth: number;
}

/**
 * Título e subtítulo que CABEM na faixa.
 *
 * O tamanho da fonte cresce quando o título tem menos linhas (1 linha =
 * maior), então o limite de caracteres depende do tamanho: sem isso, um
 * título de 1 linha cheia (21 caracteres) saía colado nas duas bordas da
 * faixa de 1080px.
 */
export function fitBannerText(
  width: number,
  title: string | null | undefined,
  subtitle: string | null | undefined,
  maxLines = 3,
): BannerFit {
  const w = Math.max(2, Math.round(width));
  const maxWidth = Math.round(w * BANNER_SIDE_MARGIN);
  const sizeFor = (count: number): number =>
    count >= maxLines ? w * 0.062 : count === 2 ? w * 0.074 : w * 0.088;
  let size = sizeFor(1);
  let lines: string[] = [];
  // O tamanho e o limite de caracteres dependem um do outro: itera até
  // parar de mudar (no máximo 4 voltas).
  for (let i = 0; i < 4; i++) {
    const maxChars = Math.max(6, Math.floor(maxWidth / (size * CHAR_WIDTH_RATIO)));
    const next = wrapShortTitle(title, maxChars, maxLines);
    const nextSize = sizeFor(next.length);
    const stable = next.length === lines.length && Math.abs(nextSize - size) < 0.5;
    lines = next;
    size = nextSize;
    if (stable) break;
  }
  // A linha mais longa precisa caber: se não couber, o texto encolhe.
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (longest > 0) {
    const fit = maxWidth / (longest * CHAR_WIDTH_RATIO);
    if (fit < size) size = Math.max(w * 0.03, fit);
  }
  const subtitleSize = w * 0.034;
  const raw = stripUnsupportedGlyphs(String(subtitle ?? ''));
  const subMax = Math.max(
    6,
    Math.floor(maxWidth / (subtitleSize * CHAR_WIDTH_RATIO_SUBTITLE)),
  );
  const subtitleText = raw.length > subMax ? `${raw.slice(0, Math.max(1, subMax - 1))}…` : raw;
  return { lines, size, subtitle: subtitleText, subtitleSize, maxWidth };
}

/** SVG da faixa (puro: o teste compara a string). */
export function shortBannerSvg(width: number, height: number, text: ShortBannerText): string {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const fit = fitBannerText(w, text.title, text.subtitle);
  const lines = fit.lines;
  const size = fit.size;
  const lineH = size * 1.16;
  const subtitleSize = fit.subtitleSize;
  const subtitle = fit.subtitle;
  const subtitleH = subtitle ? subtitleSize * 2.1 : 0;
  const blockH = lines.length * lineH + subtitleH;
  const firstBaseline = (h - blockH) / 2 + size * 0.82;
  /**
   * `textLength` espreme a linha que ainda estouraria a faixa — o SVG
   * garante que ela NÃO sai da borda (a fonte é do sistema, então a
   * estimativa acima é só uma aproximação).
   */
  const titleSvg = lines
    .map((line, i) => {
      const estimated = line.length * size * CHAR_WIDTH_RATIO;
      const squeeze =
        estimated > fit.maxWidth
          ? ` textLength="${fit.maxWidth}" lengthAdjust="spacingAndGlyphs"`
          : '';
      return (
        `<text x="${Math.round(w / 2)}" y="${Math.round(firstBaseline + i * lineH)}" ` +
        `font-family="Arial Black, Arial, sans-serif" font-size="${Math.round(size)}" ` +
        `font-weight="900" fill="white" text-anchor="middle"${squeeze}>${esc(line)}</text>`
      );
    })
    .join('');
  const subtitleSvg = subtitle
    ? `<text x="${Math.round(w / 2)}" y="${Math.round(firstBaseline + lines.length * lineH + subtitleSize * 1.4)}" ` +
      `font-family="Arial, Arial, sans-serif" font-size="${Math.round(subtitleSize)}" ` +
      `font-weight="bold" fill="${ACCENT_2}" text-anchor="middle">${esc(subtitle)}</text>`
    : '';
  return `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16161c"/>
      <stop offset="1" stop-color="#050507"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${Math.round(w * 0.014)}" height="${h}" fill="${ACCENT}"/>
  <rect x="0" y="${h - Math.round(h * 0.028)}" width="${w}" height="${Math.round(h * 0.028)}" fill="${ACCENT_2}" opacity="0.9"/>
  ${titleSvg}
  ${subtitleSvg}
</svg>`;
}

/** Rasteriza a faixa num PNG (o ffmpeg usa como segundo input). */
export async function renderShortBannerPng(
  width: number,
  height: number,
  text: ShortBannerText,
  outPath: string,
): Promise<string> {
  await sharp(Buffer.from(shortBannerSvg(width, height, text))).png().toFile(outPath);
  return outPath;
}
