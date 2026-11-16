/**
 * Adesivo do Short por CLIPE (config + precedência).
 *
 * POR QUE: o adesivo do começo do Short é uma decisão de CARA — cada
 * clipe tem o seu ("4K DO KSCERATO", "YEKINDAR 4K NA DUST2"). Com só
 * `.env`/flags, todo Short do lote sai igual — e rodar o script de novo
 * sem as flags REVERTIA o adesivo para o `auto` (o texto saía errado
 * sem aviso).
 *
 * Precedência (campo a campo, do mais forte para o mais fraco):
 *
 *   flag da CLI  >  arquivo por clipe  >  marker gravado  >  `.env`
 *
 * O marker entra na fila porque ele descreve o vertical que JÁ está em
 * disco: reusar é o que impede o adesivo de "voltar" ao padrão quando o
 * dono roda o script de novo.
 *
 * O marker guarda o spec PEDIDO (`auto`, `preset: gaules`...), não o
 * texto/estilo já resolvido: `auto` resolve de novo a cada rodada (o
 * adesivo não mente quando a janela muda de 5K para 4K) e o visual do
 * preset continua vindo do CÓDIGO atual. A CLI fica de fora do que é
 * gravado — um texto de teste de dry-run não vira o adesivo do próximo
 * `--publish`.
 *
 * Tudo aqui é PURO: entra a config crua e sai a config normalizada.
 */

/** Campos do adesivo que o dono pode ajustar. */
export interface ShortOverlaySpec {
  /** Texto do adesivo (`auto`, `none` ou texto literal). */
  text?: string | null;
  /** Preset do visual (`polex`, `gaules`, ...). */
  preset?: string | null;
  /** Segundos que o adesivo fica visível. */
  holdSec?: number | null;
  /** Duração do fade out (s). */
  fadeSec?: number | null;
  /** Posição vertical (fração da altura). */
  y?: number | null;
  /** Forma (`capsule`/`rect`). */
  style?: string | null;
  /** Tag pequena no topo. */
  tag?: string | null;
  /** Caixa alta forçada. */
  uppercase?: boolean | null;
  /** Cor de fundo. */
  background?: string | null;
  /** Cor do texto. */
  color?: string | null;
  /** Cor da borda. */
  borderColor?: string | null;
  /** Espessura da borda (0 = sem borda). */
  borderPx?: number | null;
  /** Cor da sombra. */
  shadowColor?: string | null;
  /** Deslocamento da sombra. */
  shadowPx?: number | null;
  /** Blur da sombra. */
  shadowBlurPx?: number | null;
  /** Inclinação (graus). */
  tiltDeg?: number | null;
  /** Fonte do texto. */
  font?: string | null;
}

/** De onde veio um campo do adesivo. */
export type ShortOverlaySource = 'cli' | 'file' | 'marker' | 'env';

/** Arquivo por clipe: `{ "<pasta do clipe>": { ... } }`. */
export type ShortOverlayConfig = Record<string, ShortOverlaySpec>;

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * Faixas dos campos numéricos do adesivo.
 *
 * São as MESMAS do schema do `.env` (`src/config.ts`): o arquivo por
 * clipe é editado à mão e um valor solto (`borderPx: 9999`) viraria um
 * SVG gigante (ou um adesivo fora da tela). Valor fora da faixa é
 * DESCARTADO — não vira `0` e não sobrescreve o `.env`.
 */
const OVERLAY_RANGES = {
  holdSec: { min: 0.5, max: 20 },
  fadeSec: { min: 0, max: 10 },
  y: { min: 0, max: 1 },
  borderPx: { min: 0, max: 40 },
  shadowPx: { min: 0, max: 40 },
  shadowBlurPx: { min: 0, max: 20 },
  tiltDeg: { min: -15, max: 15 },
} as const;

/** Cor hex (`#rrggbb` ou `rrggbb`); vazio/não-hex = inválida. */
function isHexColor(value: string): boolean {
  return /^#?[0-9a-f]{6}$/i.test(value.trim());
}

/**
 * Normaliza uma entrada do arquivo (ou de qualquer origem).
 *
 * Valores inválidos são DESCARTADOS (não viram `false`/`0`): um campo
 * quebrado no arquivo não pode sobrescrever o bom valor do `.env`.
 */
export function normalizeShortOverlaySpec(raw: unknown): ShortOverlaySpec {
  if (!isObj(raw)) return {};
  const out: ShortOverlaySpec = {};
  const text = str(raw.text);
  if (text != null) out.text = text;
  const preset = str(raw.preset);
  if (preset != null) out.preset = preset;
  const holdSec = num(raw.holdSec);
  if (holdSec != null && holdSec >= OVERLAY_RANGES.holdSec.min && holdSec <= OVERLAY_RANGES.holdSec.max) {
    out.holdSec = holdSec;
  }
  const fadeSec = num(raw.fadeSec);
  if (fadeSec != null && fadeSec >= OVERLAY_RANGES.fadeSec.min && fadeSec <= OVERLAY_RANGES.fadeSec.max) {
    out.fadeSec = fadeSec;
  }
  const y = num(raw.y);
  if (y != null && y >= OVERLAY_RANGES.y.min && y <= OVERLAY_RANGES.y.max) out.y = y;
  const style = str(raw.style);
  if (style != null) out.style = style;
  const tag = str(raw.tag);
  if (tag != null) out.tag = tag;
  const uppercase = bool(raw.uppercase);
  if (uppercase != null) out.uppercase = uppercase;
  const background = str(raw.background);
  if (background != null && isHexColor(background)) out.background = background;
  const color = str(raw.color);
  if (color != null && isHexColor(color)) out.color = color;
  const borderColor = str(raw.borderColor);
  if (borderColor != null && isHexColor(borderColor)) out.borderColor = borderColor;
  const borderPx = num(raw.borderPx);
  if (
    borderPx != null &&
    borderPx >= OVERLAY_RANGES.borderPx.min &&
    borderPx <= OVERLAY_RANGES.borderPx.max
  ) {
    out.borderPx = borderPx;
  }
  const shadowColor = str(raw.shadowColor);
  if (shadowColor != null && isHexColor(shadowColor)) out.shadowColor = shadowColor;
  const shadowPx = num(raw.shadowPx);
  if (
    shadowPx != null &&
    shadowPx >= OVERLAY_RANGES.shadowPx.min &&
    shadowPx <= OVERLAY_RANGES.shadowPx.max
  ) {
    out.shadowPx = shadowPx;
  }
  const shadowBlurPx = num(raw.shadowBlurPx);
  if (
    shadowBlurPx != null &&
    shadowBlurPx >= OVERLAY_RANGES.shadowBlurPx.min &&
    shadowBlurPx <= OVERLAY_RANGES.shadowBlurPx.max
  ) {
    out.shadowBlurPx = shadowBlurPx;
  }
  const tiltDeg = num(raw.tiltDeg);
  if (
    tiltDeg != null &&
    tiltDeg >= OVERLAY_RANGES.tiltDeg.min &&
    tiltDeg <= OVERLAY_RANGES.tiltDeg.max
  ) {
    out.tiltDeg = tiltDeg;
  }
  const font = str(raw.font);
  if (font != null) out.font = font;
  return out;
}

/**
 * Normaliza o arquivo inteiro de adesivos por clipe.
 *
 * Entradas que não são objeto (uma string solta, uma lista) são
 * ignoradas: um arquivo meio errado não pode derrubar o lote.
 */
export function parseShortOverlayConfig(raw: unknown): ShortOverlayConfig {
  if (!isObj(raw)) return {};
  const out: ShortOverlayConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    if (!name) continue;
    const spec = normalizeShortOverlaySpec(value);
    if (Object.keys(spec).length > 0) out[name] = spec;
  }
  return out;
}

/**
 * A entrada do arquivo para um clipe.
 *
 * A chave é o NOME DA PASTA do clipe (ex.: `2400207_Dust2_r17_YEKINDAR`).
 * Como atalho, o nome do arquivo do clipe (`<pasta>.mp4`) também vale.
 */
export function shortOverlaySpecForClip(
  config: ShortOverlayConfig | null | undefined,
  folderName: string,
  fileName?: string | null,
): ShortOverlaySpec | null {
  if (!config) return null;
  const folder = String(folderName ?? '').trim();
  if (folder && config[folder]) return config[folder];
  const file = String(fileName ?? '').trim();
  if (file && config[file]) return config[file];
  return null;
}

/** O spec do adesivo que o marker gravou (o pedido, não o estilo resolvido). */
export interface ShortOverlayMarker {
  /** Texto pedido (`auto`, `none` ou literal). */
  text?: string | null;
  preset?: string | null;
  holdSec?: number | null;
  fadeSec?: number | null;
  y?: number | null;
  style?: string | null;
  tag?: string | null;
  uppercase?: boolean | null;
  background?: string | null;
  color?: string | null;
  borderColor?: string | null;
  borderPx?: number | null;
  shadowColor?: string | null;
  shadowPx?: number | null;
  shadowBlurPx?: number | null;
  tiltDeg?: number | null;
  font?: string | null;
}

/** O marker gravou o adesivo? (o `short.render` da assinatura). */
export interface ShortOverlayMarkerSource {
  /** A assinatura do render (o `overlayText` é o texto GRAVADO). */
  render?: { overlayText?: string | null } | null;
  /** O spec pedido que o marker gravou. */
  overlaySpec?: ShortOverlaySpec | null;
}

/**
 * O spec do adesivo que o marker gravou (null = não vale).
 *
 * Duas regras:
 *
 * - marker SEM adesivo no vertical em disco (`render.overlayText` vazio)
 *   não manda nada: os zeros da assinatura (`holdSec` 0, `y` 0, sem
 *   borda/sombra) viravam override e o `auto` do `.env` nunca valia;
 * - marker com adesivo mas SEM spec (marker legado) também não vale: o
 *   que ele gravou foi o texto RESOLVIDO ("ACE kyousuke"), que congela
 *   o adesivo e mente quando a janela muda.
 */
export function markerOverlaySpec(
  marker: ShortOverlayMarkerSource | null | undefined,
): ShortOverlaySpec | null {
  if (!marker) return null;
  if (!marker.render?.overlayText) return null;
  const spec = marker.overlaySpec ? normalizeShortOverlaySpec(marker.overlaySpec) : {};
  return Object.keys(spec).length > 0 ? spec : null;
}

/**
 * O spec que vai GRAVADO no marker.
 *
 * Só entram os campos que o dono pediu explicitamente: o que veio do
 * **arquivo por clipe** e o que o marker já tinha.
 *
 * O que veio do `.env` NÃO é gravado — senão o marker congelava o `.env`:
 * o dono mudaria `SHORTS_OVERLAY_TEXT=none` (ou o preset, ou o tempo do
 * adesivo) e nenhum clipe já renderizado obedeceria (o marker, mais
 * forte que o `.env`, manteria o valor antigo).
 *
 * A flag da CLI também fica de fora (é decisão de UMA rodada: o texto de
 * teste do dry-run não pode virar o adesivo do `--publish` seguinte).
 */
export function overlaySpecForMarker(merge: ShortOverlayMerge): ShortOverlaySpec {
  const out: ShortOverlaySpec = {};
  for (const [key, value] of Object.entries(merge.spec)) {
    if (value === undefined || value === null) continue;
    const source = merge.origin[key];
    if (source !== 'file' && source !== 'marker') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export interface ShortOverlayMerge {
  /** Config final (campo a campo, pela precedência). */
  spec: ShortOverlaySpec;
  /** De onde veio cada campo (para o log do script). */
  origin: Record<string, ShortOverlaySource>;
  /** A fonte dominante (a de maior precedência que contribuiu). */
  source: ShortOverlaySource;
}

/**
 * Mistura as fontes do adesivo na ordem de precedência.
 *
 * O marker já chega como o spec PEDIDO e só quando o vertical em disco
 * tem adesivo (quem chama filtra) — por isso não há mais o descarte do
 * visual pelo hash dos presets: o que está gravado são escolhas do dono,
 * e o visual do preset vem sempre do código atual.
 */
export function mergeShortOverlaySources(input: {
  cli?: ShortOverlaySpec | null;
  file?: ShortOverlaySpec | null;
  marker?: ShortOverlayMarker | null;
  env?: ShortOverlaySpec | null;
}): ShortOverlayMerge {
  /**
   * Marker sem adesivo (`text` vazio) não manda NADA: os zeros da
   * assinatura do render (`holdSec` 0, `y` 0, sem borda/sombra) viravam
   * override e o `auto` do `.env` nunca valia. Marker sem `text` (só
   * `preset`, por exemplo) continua valendo — quem grava o marker
   * decide se houve adesivo.
   */
  const markerRaw = input.marker;
  const markerSpec: ShortOverlaySpec =
    markerRaw && typeof markerRaw.text === 'string' && markerRaw.text.trim() === ''
      ? {}
      : markerRaw
        ? normalizeShortOverlaySpec(markerRaw)
        : {};

  const sources: Array<[ShortOverlaySource, ShortOverlaySpec | null | undefined]> = [
    ['cli', input.cli],
    ['file', input.file],
    ['marker', markerSpec],
    ['env', input.env],
  ];

  const spec: Record<string, unknown> = {};
  const origin: Record<string, ShortOverlaySource> = {};
  for (const [source, values] of sources) {
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null) continue;
      if (key in spec) continue;
      spec[key] = value;
      origin[key] = source;
    }
  }

  const source: ShortOverlaySource =
    sources.find(([name, values]) =>
      Object.keys(values ?? {}).some((key) => origin[key] === name),
    )?.[0] ?? 'env';

  return { spec: spec as ShortOverlaySpec, origin, source };
}
