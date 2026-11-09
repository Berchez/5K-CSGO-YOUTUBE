import sharp from 'sharp';
import { escapeXml, stripUnsupportedGlyphs } from './shortBanner.js';

/**
 * Adesivo (sticker) que aparece no COMEÇO do Short e some em fade out.
 *
 * O visual vem de um PRESET (vermelho da PolexTV, azul do Gaules, amarelo
 * da MADHOUSE...) e cada campo pode ser sobrescrito pela config/CLI.
 * É um PNG com fundo transparente que o ffmpeg compõe por cima do
 * vertical; o filtro do overlay cuida do movimento (entra subindo,
 * balança de leve e perde a opacidade no fim).
 */

export type ShortOverlayShape = 'capsule' | 'rect';
export type ShortOverlayPreset =
  | 'custom'
  | 'polex'
  | 'polex-die'
  | 'gaules'
  | 'madhouse'
  | 'rei'
  | 'diecut'
  | 'pill';

/** Adesivo já RESOLVIDO (preset + overrides). */
export interface ShortOverlayButton {
  /** Preset usado (só informativo/assinatura). */
  preset: ShortOverlayPreset;
  text: string;
  shape: ShortOverlayShape;
  background: string;
  color: string;
  /** Cor da borda (ignorada quando `borderPx` é 0). */
  borderColor: string;
  borderPx: number;
  /** Opacidade da borda (a pílula antiga usava 0.22). */
  borderOpacity: number;
  shadowColor: string;
  /** Deslocamento da sombra em px (0 = sem sombra). */
  shadowPx: number;
  /** Blur da sombra em px (0 = sombra sólida). */
  shadowBlurPx: number;
  tiltDeg: number;
  font: string;
  uppercase: boolean;
  /** Tag pequena no topo (vazio = sem tag). */
  tag: string;
  tagBackground: string;
  tagColor: string;
  /** Fundo em gradiente (só a pílula antiga usa). */
  gradient: boolean;
  /** Borda irregular estilo figurinha recortada. */
  roughEdge: boolean;
  holdSec: number;
  fadeSec: number;
  /** Posição vertical: fração da altura do vertical (0 = topo). */
  y: number;
}

/** Overrides opcionais: vazio/`null` = valor do preset. */
export interface ShortOverlayOverrides {
  shape?: string | null;
  background?: string | null;
  color?: string | null;
  borderColor?: string | null;
  borderPx?: number | null;
  shadowColor?: string | null;
  shadowPx?: number | null;
  shadowBlurPx?: number | null;
  tiltDeg?: number | null;
  font?: string | null;
  uppercase?: boolean | null;
  tag?: string | null;
}

type PresetVisual = Omit<
  ShortOverlayButton,
  'preset' | 'text' | 'holdSec' | 'fadeSec' | 'y'
>;

/**
 * Base do `custom`: forma neutra e chapada; os campos mandam em tudo.
 * (A `pill` é o visual antigo, com gradiente e sombra desfocada.)
 */
const BASE: PresetVisual = {
  shape: 'capsule',
  background: '#e10600',
  color: '#ffffff',
  borderColor: '#ffffff',
  borderPx: 0,
  borderOpacity: 1,
  shadowColor: '#000000',
  shadowPx: 8,
  shadowBlurPx: 0,
  tiltDeg: 0,
  font: 'Arial Black',
  uppercase: true,
  tag: '',
  tagBackground: '#000000',
  tagColor: '#ffffff',
  gradient: false,
  roughEdge: false,
};

/**
 * Presets tirados das capturas de referência (PolexTV, Gaules, MADHOUSE,
 * Cortes do Rei, Cortes Donos da Bala). Cor chapada + sombra sólida.
 */
export const SHORT_OVERLAY_PRESET_VISUALS: Record<
  Exclude<ShortOverlayPreset, 'custom'>,
  PresetVisual
> = {
  polex: {
    ...BASE,
    shape: 'capsule',
    background: '#e10600',
    color: '#ffffff',
    borderPx: 0,
    shadowColor: '#7a0000',
    shadowPx: 10,
    font: 'Impact',
  },
  'polex-die': {
    ...BASE,
    shape: 'capsule',
    background: '#e10600',
    color: '#ffffff',
    borderColor: '#ffffff',
    borderPx: 7,
    shadowColor: '#ffd400',
    shadowPx: 10,
    font: 'Impact',
  },
  gaules: {
    ...BASE,
    shape: 'capsule',
    background: '#2563eb',
    color: '#ffffff',
    borderColor: '#93c5fd',
    borderPx: 4,
    shadowColor: '#1e3a8a',
    shadowPx: 10,
    font: 'Arial Black',
  },
  madhouse: {
    ...BASE,
    shape: 'rect',
    background: '#ffd400',
    color: '#111111',
    borderColor: '#6b21a8',
    borderPx: 8,
    shadowColor: '#3b0764',
    shadowPx: 8,
    tiltDeg: -1.5,
    font: 'Arial Black',
    tag: 'MADHOUSE',
    tagBackground: '#6b21a8',
    tagColor: '#ffd400',
  },
  rei: {
    ...BASE,
    shape: 'capsule',
    background: '#6d28d9',
    color: '#ffffff',
    borderPx: 0,
    shadowColor: '#3b0764',
    shadowPx: 10,
    font: 'Impact',
  },
  diecut: {
    ...BASE,
    shape: 'rect',
    background: '#e10600',
    color: '#ffffff',
    borderColor: '#ffffff',
    borderPx: 8,
    shadowColor: '#000000',
    shadowPx: 8,
    shadowBlurPx: 4,
    tiltDeg: -2,
    font: 'Impact',
    roughEdge: true,
  },
  pill: {
    ...BASE,
    shape: 'capsule',
    background: '#e10600',
    color: '#ffffff',
    borderColor: '#ffffff',
    borderPx: 2,
    borderOpacity: 0.22,
    shadowColor: '#000000',
    shadowPx: 6,
    shadowBlurPx: 5,
    font: 'Arial Black',
    uppercase: false,
    gradient: true,
  },
};

function isPreset(value: string): value is Exclude<ShortOverlayPreset, 'custom'> {
  return Object.hasOwn(SHORT_OVERLAY_PRESET_VISUALS, value);
}

/** Texto "limpo" (sem emoji/controle) e em caixa alta quando pedido. */
function cleanText(text: string, uppercase: boolean): string {
  const clean = stripUnsupportedGlyphs(String(text ?? ''));
  return uppercase ? clean.toUpperCase() : clean;
}

function pickText(value: string | null | undefined, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Cor do adesivo (puro): só aceita hex (`#rgb`/`#rrggbb`); qualquer
 * outra coisa cai no preset.
 *
 * O `.env` já é validado na config, mas o adesivo também é montado por
 * script/flag: uma cor inválida no SVG (`fill="vermelho"`) sai PRETO
 * (o fill padrão) — o adesivo aparece sem o texto. Melhor recusar a
 * cor e ficar com a do preset.
 */
function pickColor(value: string | null | undefined, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return fallback;
  const hex = trimmed.replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(hex)) return fallback;
  return `#${hex.toLowerCase()}`;
}

function pickNumber(value: number | null | undefined, fallback: number): number {
  return value == null || !Number.isFinite(value) ? fallback : value;
}

/**
 * Resolve preset + overrides no adesivo final. Puro/testável.
 *
 * Vazio (`''`/`null`) = usa o preset; `0` é override válido. Texto vazio
 * (ou só com emoji, que a fonte do sistema não tem) devolve `null` (sem
 * adesivo), independentemente do preset.
 */
export function resolveShortOverlayStyle(input: {
  preset: string;
  text: string;
  holdSec: number;
  fadeSec: number;
  y: number;
  overrides?: ShortOverlayOverrides;
}): ShortOverlayButton | null {
  const text = String(input.text ?? '').trim();
  if (!text) return null;
  const preset: ShortOverlayPreset = isPreset(input.preset)
    ? input.preset
    : input.preset === 'custom'
      ? 'custom'
      : 'polex';
  const visual = preset === 'custom' ? BASE : SHORT_OVERLAY_PRESET_VISUALS[preset];
  const o = input.overrides ?? {};
  const shape = o.shape === 'capsule' || o.shape === 'rect' ? o.shape : visual.shape;
  const font =
    o.font === 'Arial Black' || o.font === 'Impact' || o.font === 'Arial'
      ? o.font
      : visual.font;
  const uppercase = o.uppercase == null ? visual.uppercase : o.uppercase === true;
  // `none` = SEM tag (o valor vazio significa "usa a tag do preset").
  const tagOverride = o.tag == null ? null : String(o.tag).trim();
  const tag = tagOverride?.toLowerCase() === 'none' ? '' : pickText(tagOverride, visual.tag);
  // Emoji/controle não existe na fonte do sistema: um adesivo só com
  // emoji viraria uma forma VAZIA. Sem texto desenhável = sem adesivo.
  const clean = cleanText(text, uppercase);
  if (!clean.trim()) return null;
  return {
    preset,
    text: clean,
    shape,
    background: pickColor(o.background, visual.background),
    color: pickColor(o.color, visual.color),
    borderColor: pickColor(o.borderColor, visual.borderColor),
    borderPx: pickNumber(o.borderPx, visual.borderPx),
    borderOpacity: visual.borderOpacity,
    shadowColor: pickColor(o.shadowColor, visual.shadowColor),
    shadowPx: pickNumber(o.shadowPx, visual.shadowPx),
    shadowBlurPx: pickNumber(o.shadowBlurPx, visual.shadowBlurPx),
    tiltDeg: pickNumber(o.tiltDeg, visual.tiltDeg),
    font,
    uppercase,
    tag,
    tagBackground: visual.tagBackground,
    tagColor: visual.tagColor,
    gradient: visual.gradient,
    roughEdge: visual.roughEdge,
    holdSec: Math.max(0.1, input.holdSec),
    fadeSec: Math.max(0, input.fadeSec),
    y: Math.min(1, Math.max(0, input.y)),
  };
}

/**
 * Hash do visual dos presets (entra na assinatura do render).
 *
 * Mudou o preset no CÓDIGO (cor, borda, sombra, tag, forma), o vertical
 * antigo tem que ser refeito: sem o hash, o mp4 velho era reaproveitado
 * e o Short saía com o visual antigo.
 *
 * O hash é MEMORIZADO: o preset é uma constante do módulo, então o
 * resultado é sempre o mesmo — e a assinatura do render chama isto a
 * cada clipe (o JSON inteiro dos presets era serializado toda vez).
 */
let visualsHashCache: string | null = null;

export function shortOverlayVisualsHash(): string {
  if (visualsHashCache != null) return visualsHashCache;
  const json = JSON.stringify(SHORT_OVERLAY_PRESET_VISUALS);
  let hash = 5381;
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) >>> 0;
  }
  visualsHashCache = hash.toString(16);
  return visualsHashCache;
}

/**
 * Largura de AVANÇO de cada caractere (em 1/100 do tamanho da fonte),
 * medida com o MESMO renderizador do adesivo (librsvg do sharp).
 *
 * O `textLength` do SVG NÃO é respeitado pelo librsvg: sem esta tabela o
 * texto largo (Arial Black) estoura a forma do adesivo. O `_` é o espaço.
 */
const FONT_ADVANCE: Record<string, string> = {
  Impact:
    'A:54 B:55 C:56 D:55 E:41 F:40 G:55 H:54 I:30 J:32 K:54 L:38 M:72 N:54 O:54 P:50 Q:54 R:54 S:52 T:48 U:55 V:52 W:80 X:48 Y:48 Z:39 ' +
    'a:50 b:52 c:50 d:52 e:50 f:30 g:52 h:52 i:28 j:28 k:48 l:28 m:78 n:52 o:50 p:52 q:52 r:36 s:47 t:30 u:52 v:44 w:66 x:43 y:45 z:36 ' +
    '0:54 1:38 2:51 3:52 4:50 5:52 6:54 7:40 8:53 9:54 .:20 ,:16 !:26 ?:53 &:57 -:30 ::20 /:40 #:62 (:31 ):31 +:52 _:14',
  'Arial Black':
    'A:77 B:77 C:78 D:77 E:72 F:66 G:83 H:84 I:39 J:66 K:84 L:66 M:95 N:84 O:84 P:72 Q:84 R:78 S:73 T:73 U:84 V:77 W:100 X:78 Y:77 Z:74 ' +
    'a:66 b:68 c:66 d:68 e:67 f:41 g:68 h:68 i:34 j:34 k:67 l:34 m:100 n:68 o:66 p:67 q:67 r:49 s:61 t:46 u:67 v:61 w:94 x:68 y:61 z:55 ' +
    '0:68 1:67 2:66 3:67 4:68 5:67 6:66 7:67 8:68 9:66 .:32 ,:32 !:32 ?:60 &:88 -:34 ::32 /:28 #:66 (:39 ):39 +:66 _:34',
};

/** Largura usada quando o caractere não está na tabela (acentos, etc.). */
const FONT_ADVANCE_FALLBACK: Record<string, number> = {
  Impact: 55,
  'Arial Black': 76,
};

/** Margem de segurança da estimativa de largura (5%). */
const TEXT_WIDTH_SAFETY = 1.05;
/** Tamanho mínimo da fonte do adesivo (texto muito longo). */
const MIN_FONT_SIZE = 22;
/** Folga mínima do canvas em volta do adesivo (espaço da sombra). */
const SHADOW_MARGIN = 16;
/** Linhas que a legenda do adesivo pode ocupar antes de espremer. */
const MAX_LINES = 4;

const advanceCache = new Map<string, Map<string, number>>();

function advanceMap(font: string): Map<string, number> {
  const cached = advanceCache.get(font);
  if (cached) return cached;
  const map = new Map<string, number>();
  for (const part of (FONT_ADVANCE[font] ?? '').split(' ')) {
    const [rawChar, value] = part.split(':');
    if (!rawChar || value == null) continue;
    map.set(rawChar === '_' ? ' ' : rawChar, Number(value));
  }
  advanceCache.set(font, map);
  return map;
}

/** Caractere sem acento (a tabela é do ASCII). */
function baseChar(ch: string): string {
  const stripped = ch.normalize('NFD').replace(/\p{M}/gu, '');
  return stripped || ch;
}

/** Largura do texto (px) na fonte pedida (estimativa pela tabela). */
export function overlayTextWidth(text: string, font: string, fontSize: number): number {
  const map = advanceMap(font);
  const fallback = FONT_ADVANCE_FALLBACK[font] ?? 70;
  let units = 0;
  for (const ch of String(text ?? '')) {
    const key = baseChar(ch);
    units += map.get(key) ?? map.get(key.toUpperCase()) ?? fallback;
  }
  return (units / 100) * fontSize * TEXT_WIDTH_SAFETY;
}

export interface ShortOverlayMetrics {
  /** Largura do adesivo (px, sem a margem). */
  width: number;
  /** Altura do adesivo (px, sem a margem). */
  height: number;
  /** Tamanho da fonte (px). */
  fontSize: number;
  /** Margem de cada lado reservada para borda/sombra/inclinação (px). */
  margin: number;
  /** Linhas de texto (já quebradas). */
  lines: string[];
  /** Altura de cada linha (px). */
  lineHeight: number;
  /** Altura da tag do topo (0 = sem tag). */
  tagHeight: number;
  /** Largura da tag do topo (0 = sem tag). */
  tagWidth: number;
  /** Largura de cada linha (medida no render ou estimada). */
  lineWidths: number[];
}

/**
 * Medidas REAIS do texto (medidas pelo renderizador no momento do
 * render). Sem elas o adesivo usa a estimativa da tabela de fontes.
 */
export interface ShortOverlayMeasurement {
  /** Largura de cada linha do texto (px), na ordem das linhas. */
  lineWidths?: number[];
  /** Largura da tag do topo (px). */
  tagWidth?: number;
}

/** Cor `#rrggbb` clareada (`factor > 1`) ou escurecida (`factor < 1`). */
function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  const raw = m ? m[1] : 'e10600';
  const channel = (i: number): string => {
    const v = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    const scaled = Math.max(0, Math.min(255, Math.round(v * factor)));
    return scaled.toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Corta o texto com reticências até caber na largura pedida. */
function truncateToWidth(
  text: string,
  maxWidthPx: number,
  font: string,
  fontSize: number,
): string {
  if (overlayTextWidth(text, font, fontSize) <= maxWidthPx) return text;
  let out = text;
  while (out.length > 1 && overlayTextWidth(`${out}…`, font, fontSize) > maxWidthPx) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}…`;
}

/**
 * Quebra o texto pela LARGURA real (não pelo nº de caracteres): a mesma
 * contagem dá larguras muito diferentes ("MMMM" x "iiii").
 */
export function wrapOverlayTextByWidth(
  text: string,
  maxWidthPx: number,
  font: string,
  fontSize: number,
): string[] {
  const fits = (value: string): boolean =>
    overlayTextWidth(value, font, fontSize) <= maxWidthPx;
  const lines: string[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (fits(candidate)) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (fits(word)) {
        current = word;
        continue;
      }
      // Palavra sozinha maior que a linha: corta por caractere.
      let chunk = '';
      for (const ch of word) {
        if (fits(`${chunk}${ch}`)) {
          chunk += ch;
        } else {
          if (chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  if (lines.length === 0) return [' '];
  if (lines.length > MAX_LINES) {
    const kept = lines.slice(0, MAX_LINES - 1);
    const rest = lines.slice(MAX_LINES - 1).join(' ');
    kept.push(truncateToWidth(rest, maxWidthPx, font, fontSize));
    return kept;
  }
  return lines;
}

const DEFAULT_RENDER_STYLE: ShortOverlayButton = {
  ...SHORT_OVERLAY_PRESET_VISUALS.pill,
  preset: 'pill',
  text: 'CS2',
  holdSec: 2,
  fadeSec: 0.5,
  y: 0.54,
};

/** Completa um adesivo parcial com o visual da pílula (compatibilidade). */
function normalizeStyle(
  text: string,
  opts: { outWidth: number; outHeight: number } & Partial<ShortOverlayButton>,
): ShortOverlayButton {
  return {
    ...DEFAULT_RENDER_STYLE,
    ...opts,
    text: String(text ?? '').trim() || DEFAULT_RENDER_STYLE.text,
  };
}

/**
 * Medidas do adesivo para a largura do vertical (o texto é quebrado e a
 * forma é dimensionada pela largura REAL das linhas — medida no render ou
 * estimada pela tabela de fontes).
 */
export function shortOverlayMetrics(
  text: string,
  outWidth: number,
  outHeight: number,
  style?: Partial<ShortOverlayButton>,
  measurement?: ShortOverlayMeasurement,
): ShortOverlayMetrics {
  const s = normalizeStyle(text, { outWidth, outHeight, ...(style ?? {}) });
  // Compacto de propósito: o adesivo é um carimbo, não uma faixa.
  const baseFontSize = Math.round(
    Math.max(MIN_FONT_SIZE, Math.min(outWidth * 0.045, outHeight * 0.036)),
  );
  const maxWidth = Math.round(outWidth * 0.86);
  const clean = cleanText(s.text, s.uppercase);
  let fontSize = baseFontSize;
  let lines: string[] = [];
  let lineWidths: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const padX = Math.round(fontSize * 0.42);
    const available = Math.max(40, maxWidth - padX * 2);
    lines = wrapOverlayTextByWidth(clean, available, s.font, fontSize);
    // A medição real só vale para a 1ª tentativa (mesmo tamanho de fonte).
    const measured = attempt === 0 ? measurement?.lineWidths : undefined;
    lineWidths =
      measured && measured.length === lines.length
        ? measured
        : lines.map((line) => overlayTextWidth(line, s.font, fontSize));
    const widest = Math.max(...lineWidths);
    if (widest <= available || fontSize <= MIN_FONT_SIZE) break;
    fontSize = Math.max(MIN_FONT_SIZE, Math.floor(fontSize * (available / widest) * 0.98));
  }
  const padX = Math.round(fontSize * 0.42);
  const padY = Math.round(fontSize * 0.26);
  const lineHeight = Math.round(fontSize * 1.18);
  const widest = Math.max(...lineWidths);
  const width = Math.max(2, Math.min(maxWidth, Math.ceil(widest) + padX * 2));
  const height = Math.max(2, Math.round(lines.length * lineHeight) + padY * 2);
  const tagText = s.uppercase ? s.tag.trim().toUpperCase() : s.tag.trim();
  const tagHeight = tagText ? Math.round(fontSize * 0.62) : 0;
  const tagFontSize = Math.round(fontSize * 0.42);
  const measuredTag =
    fontSize === baseFontSize ? (measurement?.tagWidth ?? 0) : 0;
  const tagWidth = tagText
    ? Math.ceil(
        Math.max(
          measuredTag,
          overlayTextWidth(tagText, s.font, tagFontSize),
        ) + tagFontSize * 0.8,
      )
    : 0;
  const tilt = (Math.abs(s.tiltDeg) * Math.PI) / 180;
  const tiltGrow =
    Math.ceil((Math.max(width, tagWidth) * Math.sin(tilt) + height * (1 - Math.cos(tilt))) / 2) + 2;
  const margin = Math.max(
    SHADOW_MARGIN,
    Math.ceil(
      s.borderPx + s.shadowPx + s.shadowBlurPx * 2 + tiltGrow + tagHeight * 0.4,
    ),
  );
  return {
    width,
    height,
    fontSize,
    margin,
    lines,
    lineHeight,
    tagHeight,
    tagWidth,
    lineWidths,
  };
}

/** SVG do adesivo (puro: o teste compara a string). */
export function shortOverlayButtonSvg(
  text: string,
  opts: {
    outWidth: number;
    outHeight: number;
    /** Métricas já calculadas (evita recalcular com outra estimativa). */
    metrics?: ShortOverlayMetrics;
  } & Partial<ShortOverlayButton>,
): string {
  const s = normalizeStyle(text, opts);
  const m = opts.metrics ?? shortOverlayMetrics(text, opts.outWidth, opts.outHeight, s);
  const canvasW = m.width + m.margin * 2;
  const canvasH = m.height + m.margin * 2;
  const radius =
    s.shape === 'capsule' ? Math.round(m.height / 2) : Math.round(Math.min(18, m.height * 0.28));
  const innerX = m.margin;
  const innerY = m.margin;
  const outerX = m.margin - s.borderPx;
  const outerY = m.margin - s.borderPx;
  const outerW = m.width + s.borderPx * 2;
  const outerH = m.height + s.borderPx * 2;
  const shapeRadius = radius + s.borderPx;
  const centerX = innerX + m.width / 2;
  const centerY = innerY + m.height / 2;
  const fill = s.gradient ? 'url(#ovl-bg)' : s.background;
  const tag = s.uppercase ? s.tag.trim().toUpperCase() : s.tag.trim();
  const tagW = m.tagWidth;
  const tagX = Math.round(centerX - tagW / 2);
  const tagY = Math.round(innerY - m.tagHeight * 0.35);

  const defs: string[] = [];
  if (s.gradient) {
    defs.push(
      `<linearGradient id="ovl-bg" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${shade(s.background, 1.35)}"/>` +
        `<stop offset="0.55" stop-color="${s.background}"/>` +
        `<stop offset="1" stop-color="${shade(s.background, 0.72)}"/>` +
        `</linearGradient>`,
    );
  }
  if (s.shadowBlurPx > 0) {
    defs.push(
      `<filter id="ovl-shadow" x="-30%" y="-30%" width="160%" height="160%">` +
        `<feGaussianBlur stdDeviation="${s.shadowBlurPx}"/>` +
        `</filter>`,
    );
  }
  if (s.roughEdge) {
    defs.push(
      `<filter id="ovl-rough" x="-10%" y="-10%" width="120%" height="120%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="noise"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G"/>` +
        `</filter>`,
    );
  }

  const shapes: string[] = [];
  if (s.shadowPx > 0 || s.shadowBlurPx > 0) {
    shapes.push(
      `<rect x="${outerX + s.shadowPx}" y="${outerY + s.shadowPx}" width="${outerW}" height="${outerH}" rx="${shapeRadius}" ry="${shapeRadius}" fill="${s.shadowColor}"${s.shadowBlurPx > 0 ? ' filter="url(#ovl-shadow)"' : ''}/>`,
    );
  }
  if (s.borderPx > 0) {
    shapes.push(
      `<rect x="${outerX}" y="${outerY}" width="${outerW}" height="${outerH}" rx="${shapeRadius}" ry="${shapeRadius}" fill="${s.borderColor}" fill-opacity="${s.borderOpacity}"/>`,
    );
  }
  shapes.push(
    `<rect x="${innerX}" y="${innerY}" width="${m.width}" height="${m.height}" rx="${radius}" ry="${radius}" fill="${fill}"/>`,
  );

  const texts: string[] = [];
  const textStartY =
    innerY + Math.round((m.height - m.lines.length * m.lineHeight) / 2) + m.lineHeight / 2;
  m.lines.forEach((line, index) => {
    texts.push(
      `<text x="${centerX}" y="${Math.round(textStartY + index * m.lineHeight + m.fontSize * 0.35)}" font-family="${escapeXml(s.font)}, Arial Black, Arial, sans-serif" font-size="${m.fontSize}" font-weight="900" fill="${s.color}" text-anchor="middle">${escapeXml(line)}</text>`,
    );
  });

  const tagParts: string[] = [];
  if (tag) {
    tagParts.push(
      `<rect x="${tagX}" y="${tagY}" width="${tagW}" height="${m.tagHeight}" rx="${Math.round(m.tagHeight / 2)}" ry="${Math.round(m.tagHeight / 2)}" fill="${s.tagBackground}"/>`,
    );
    tagParts.push(
      `<text x="${centerX}" y="${Math.round(tagY + m.tagHeight / 2 + m.fontSize * 0.42 * 0.35)}" font-family="${escapeXml(s.font)}, Arial Black, Arial, sans-serif" font-size="${Math.round(m.fontSize * 0.42)}" font-weight="900" fill="${s.tagColor}" text-anchor="middle">${escapeXml(tag)}</text>`,
    );
  }

  const body = [...shapes];
  const core = s.roughEdge
    ? `<g filter="url(#ovl-rough)">${body.join('')}</g>`
    : body.join('');
  const rotate =
    s.tiltDeg !== 0
      ? `<g transform="rotate(${s.tiltDeg} ${centerX} ${centerY})">${core}${tagParts.join('')}${texts.join('')}</g>`
      : `${core}${tagParts.join('')}${texts.join('')}`;

  return `
<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
  <defs>${defs.join('')}</defs>
  ${rotate}
</svg>`;
}

/**
 * Largura REAL de um texto (px), medida com o mesmo renderizador do
 * adesivo. O `textLength` do SVG é ignorado pelo librsvg, então a forma
 * do adesivo é dimensionada por esta medição.
 */
async function measureTextWidth(text: string, font: string, fontSize: number): Promise<number> {
  const clean = String(text ?? '').trim();
  if (!clean) return 0;
  const estimate = overlayTextWidth(clean, font, fontSize);
  // Canvas com folga: o texto é centralizado e a medição só falha se
  // encostar na borda (o clip cortaria a medida).
  const canvasW = Math.min(8000, Math.ceil(estimate * 2) + 400);
  const canvasH = Math.ceil(fontSize * 2.2);
  const svg =
    `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${Math.round(canvasW / 2)}" y="${Math.round(fontSize * 1.5)}" font-family="${escapeXml(font)}, Arial Black, Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="#000000" text-anchor="middle">${escapeXml(clean)}</text>` +
    `</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let min = info.width;
  let max = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha > 16) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  return max < 0 ? 0 : max - min + 1;
}

/** Mede as linhas do texto e a tag com o renderizador. */
async function measureShortOverlay(
  metrics: ShortOverlayMetrics,
  style: ShortOverlayButton,
): Promise<ShortOverlayMeasurement> {
  const lineWidths: number[] = [];
  for (const line of metrics.lines) {
    lineWidths.push(await measureTextWidth(line, style.font, metrics.fontSize));
  }
  const tag = style.uppercase ? style.tag.trim().toUpperCase() : style.tag.trim();
  const tagWidth = tag
    ? await measureTextWidth(tag, style.font, Math.round(metrics.fontSize * 0.42))
    : 0;
  return { lineWidths, tagWidth };
}

/** Resultado do render do adesivo: o PNG e as métricas REAIS usadas nele. */
export interface ShortOverlayRender {
  /** Caminho do PNG gerado. */
  outPath: string;
  /**
   * Métricas REAIS (texto medido no renderizador). O PNG tem este
   * tamanho: quem posicionar o adesivo no vertical tem que usar ESTAS
   * medidas, não uma nova estimativa.
   */
  metrics: ShortOverlayMetrics;
}

/** Rasteriza o adesivo num PNG transparente (o ffmpeg usa como input). */
export async function renderShortOverlayButtonPng(
  text: string,
  opts: { outWidth: number; outHeight: number } & Partial<ShortOverlayButton>,
  outPath: string,
): Promise<ShortOverlayRender> {
  const style = normalizeStyle(text, opts);
  // 1ª passada: medidas estimadas; 2ª: medidas REAIS (a forma sai do
  // tamanho do texto, nunca do palpite).
  const base = shortOverlayMetrics(text, opts.outWidth, opts.outHeight, style);
  const measurement = await measureShortOverlay(base, style);
  const metrics = shortOverlayMetrics(
    text,
    opts.outWidth,
    opts.outHeight,
    style,
    measurement,
  );
  const svg = shortOverlayButtonSvg(text, { ...opts, metrics });
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return { outPath, metrics };
}

/** Segundos da entrada (sobe e assenta). */
const RISE_SEC = 0.32;
/** Altura da subida na entrada (px). */
const RISE_PX = 34;
/** Amplitude do balanço depois que assenta (px). */
const BOB_PX = 5;
/** Período do balanço (s). */
const BOB_PERIOD_SEC = 1.6;
/** Duração do fade-in (s). */
const FADE_IN_SEC = 0.18;

/**
 * Filtro que compõe o adesivo por cima do vertical (puro).
 *
 * Movimento: entra SUBINDO (com desaceleração), assenta e balança de
 * leve; perde a opacidade no fim (`fade` no canal alfa) em vez de
 * sumir de golpe. O `enable` tira o adesivo do resto do vídeo.
 */
export function shortOverlayFilter(opts: {
  /** Filtro do layout (termina no rótulo `[v]`). */
  baseFilter: string;
  /** Índice do input do PNG do adesivo. */
  inputIndex: number;
  holdSec: number;
  fadeSec: number;
  /** Posição vertical do PNG em px. */
  yPx: number;
}): string {
  const hold = Math.max(0.1, opts.holdSec);
  const fade = Math.min(Math.max(0, opts.fadeSec), hold);
  const fadeStart = Math.max(0, hold - fade);
  const rise = Math.min(RISE_PX, Math.max(10, Math.round(opts.yPx * 0.04) + 20));
  const y0 = Math.round(opts.yPx);
  // `min`/`max`/`pow`/`sin` são funções do avaliador do ffmpeg; as
  // vírgulas ficam protegidas pelas aspas simples do filtergraph.
  const yExpr =
    `${y0}` +
    `+${rise}*pow(1-min(t/${RISE_SEC.toFixed(2)},1),2)` +
    `+${BOB_PX}*sin(2*PI*max(t-${RISE_SEC.toFixed(2)},0)/${BOB_PERIOD_SEC.toFixed(2)})` +
    `*min(max((t-${RISE_SEC.toFixed(2)})/0.30,0),1)`;
  const base = opts.baseFilter.replace(/\[v\]$/, '[base]');
  return [
    base,
    `[${opts.inputIndex}:v]format=rgba,fade=t=in:st=0:d=${FADE_IN_SEC.toFixed(2)}:alpha=1,fade=t=out:st=${fadeStart.toFixed(2)}:d=${fade.toFixed(2)}:alpha=1[btn]`,
    `[base][btn]overlay=x=(W-w)/2:y='${yExpr}':enable='between(t,0,${hold.toFixed(2)})'[v]`,
  ].join(';');
}
