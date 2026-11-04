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
  const words = String(title ?? '')
    .trim()
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

/** SVG da faixa (puro: o teste compara a string). */
export function shortBannerSvg(width: number, height: number, text: ShortBannerText): string {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const lines = wrapShortTitle(text.title, Math.max(8, Math.round(w / 52)), 3);
  const subtitle = String(text.subtitle ?? '').trim();
  const size = lines.length >= 3 ? w * 0.062 : lines.length === 2 ? w * 0.074 : w * 0.088;
  const lineH = size * 1.16;
  const subtitleSize = w * 0.034;
  const subtitleH = subtitle ? subtitleSize * 2.1 : 0;
  const blockH = lines.length * lineH + subtitleH;
  const firstBaseline = (h - blockH) / 2 + size * 0.82;
  const titleSvg = lines
    .map(
      (line, i) =>
        `<text x="${Math.round(w / 2)}" y="${Math.round(firstBaseline + i * lineH)}" ` +
        `font-family="Arial Black, Arial, sans-serif" font-size="${Math.round(size)}" ` +
        `font-weight="900" fill="white" text-anchor="middle">${esc(line)}</text>`,
    )
    .join('');
  const subtitleSvg = subtitle
    ? `<text x="${Math.round(w / 2)}" y="${Math.round(firstBaseline + lines.length * lineH + subtitleSize * 1.4)}" ` +
      `font-family="Arial, Arial, sans-serif" font-size="${Math.round(subtitleSize)}" ` +
      `font-weight="bold" fill="${ACCENT_2}" text-anchor="middle">${esc(subtitle.slice(0, 64))}</text>`
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
