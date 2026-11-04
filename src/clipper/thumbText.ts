import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { repoPath } from '../paths.js';
import { getLogger } from '../logger.js';

/**
 * Fontes da thumb composta (versionadas em assets/fonts, todas OFL).
 *
 * O librsvg que vem no sharp ignora @font-face: texto em `<text>` usaria
 * uma fonte do sistema (diferente em cada máquina). Por isso os textos da
 * thumb composta viram PATH (contorno) via opentype.js — o desenho é
 * idêntico em qualquer SO.
 */
export type ThumbFont = 'display' | 'script' | 'ui';

const FONT_FILES: Record<ThumbFont, string> = {
  /** Brush de impacto: label grande (4K/ACE/5K). */
  display: 'Rowdies-Bold.ttf',
  /** Brush manuscrito: nome do jogador. */
  script: 'Shrikhand-Regular.ttf',
  /** Condensada de UI: evento, killfeed, rodapé. */
  ui: 'BarlowCondensed-Bold.ttf',
};

const fontCache = new Map<ThumbFont, opentype.Font | null>();

/**
 * Caminho da fonte no repo.
 *
 * `repoPath` acha a raiz do repo pelo `package.json` — funciona no src
 * (tsx), no dist e com qualquer CWD (o `../../assets` relativo quebrava
 * no `dist/src/clipper`).
 */
export function thumbFontPath(font: ThumbFont): string {
  const file = FONT_FILES[font];
  const fromCwd = path.resolve(process.cwd(), 'assets', 'fonts', file);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return repoPath('assets', 'fonts', file);
}

/** Carrega (e memoiza) a fonte; null se o arquivo não existir. */
export function loadThumbFont(font: ThumbFont): opentype.Font | null {
  const cached = fontCache.get(font);
  if (cached !== undefined) return cached;
  let loaded: opentype.Font | null = null;
  try {
    const bytes = fs.readFileSync(thumbFontPath(font));
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    loaded = opentype.parse(ab);
  } catch (e) {
    // A fonte sumindo é um erro de instalação, não um detalhe: sem log
    // todas as thumbs caíam no <text> do sistema sem ninguém saber por quê.
    getLogger()
      .child({ feature: 'thumb-composite' })
      .warn(
        { font, file: FONT_FILES[font], err: String(e).slice(0, 120) },
        'fonte da thumb não carregou — o texto vai com a fonte do sistema',
      );
    loaded = null;
  }
  fontCache.set(font, loaded);
  return loaded;
}

/** Largura do texto (px) na fonte/tamanho dados. */
export function measureThumbText(font: opentype.Font, text: string, size: number): number {
  return font.getAdvanceWidth(text, size);
}

/** Texto como path SVG (`d`), com a LINHA DE BASE em y. */
export function thumbTextPath(
  font: opentype.Font,
  text: string,
  x: number,
  y: number,
  size: number,
): string {
  if (!text) return '';
  return pathCommandsToData(font.getPath(text, x, y, size).commands);
}

/**
 * Serializa os comandos do path em `d` SVG.
 *
 * NÃO usa `path.toPathData()`: o arredondamento do opentype.js 2.0.0
 * quebra com coordenadas whose casas decimais caem em notação científica
 * (ex.: 5e-7) e escreve "NaN" no path — o librsvg aí DESISTE do path e
 * desenha só os primeiros glifos (o texto aparece cortado).
 */
export function pathCommandsToData(
  commands: ReadonlyArray<opentype.PathCommand>,
  decimals = 2,
): string {
  const factor = 10 ** decimals;
  const n = (v: number): string => String(Math.round(v * factor) / factor);
  let d = '';
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        d += `M${n(cmd.x)} ${n(cmd.y)}`;
        break;
      case 'L':
        d += `L${n(cmd.x)} ${n(cmd.y)}`;
        break;
      case 'C':
        d += `C${n(cmd.x1)} ${n(cmd.y1)} ${n(cmd.x2)} ${n(cmd.y2)} ${n(cmd.x)} ${n(cmd.y)}`;
        break;
      case 'Q':
        d += `Q${n(cmd.x1)} ${n(cmd.y1)} ${n(cmd.x)} ${n(cmd.y)}`;
        break;
      case 'Z':
        d += 'Z';
        break;
    }
  }
  return d;
}

/**
 * Maior tamanho (até `desired`) com que o texto cabe em `maxWidth`.
 * Abaixo de `min` o texto encolhe e vaza — melhor que sumir.
 */
export function fitThumbTextSize(
  font: opentype.Font,
  text: string,
  maxWidth: number,
  desired: number,
  min: number,
): number {
  if (!text || maxWidth <= 0) return desired;
  const width = measureThumbText(font, text, desired);
  if (width <= maxWidth) return desired;
  const scaled = (desired * maxWidth) / width;
  return Math.max(min, Math.floor(scaled));
}
