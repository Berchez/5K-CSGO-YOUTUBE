/**
 * Legenda queimada no Short (a faixa que o YouTube oferece, gravada no
 * próprio `.mp4`).
 *
 * O texto vem da transcrição do áudio (IA) e vira um arquivo `.ass`
 * renderizado pelo libass do ffmpeg dentro do vertical. Aqui mora só a
 * parte PURA: normalizar o texto, quebrar em linhas, limitar os tempos e
 * gerar o `.ass`. Quem chama (o script dos Shorts) cuida do áudio, da IA
 * e do render.
 */

/** Uma linha de legenda (tempos relativos ao INÍCIO do Short). */
export interface CaptionLine {
  startSec: number;
  endSec: number;
  /** Texto da linha; `\n` vira quebra de linha no `.ass`. */
  text: string;
}

/** Onde a legenda fica no vertical. */
export type CaptionPosition = 'game-top' | 'below-crosshair' | 'bottom';

/** Onde a legenda fica no vertical e com que fonte. */
export interface CaptionStyle {
  /** Largura do vertical (`PlayResX`). */
  width: number;
  /** Altura do vertical (`PlayResY`). */
  height: number;
  /** Y do topo da legenda (âncora `\an8`, topo-centro). */
  topY: number;
  /** Tamanho da fonte em px. */
  fontSize: number;
  /** Família da fonte (o libass resolve pelo nome). */
  fontFamily: string;
  /** Máximo de caracteres por linha da legenda. */
  maxCharsPerLine: number;
  /** Máximo de linhas por bloco de legenda. */
  maxLines: number;
  /** Posição no vertical. */
  position: CaptionPosition;
  /** Margem de baixo (só no modo `bottom`). */
  bottomMargin: number;
}

export const CAPTION_DEFAULT_STYLE: CaptionStyle = {
  width: 1080,
  height: 1920,
  topY: 1350,
  fontSize: 54,
  fontFamily: 'Segoe UI Black',
  maxCharsPerLine: 32,
  maxLines: 2,
  position: 'below-crosshair',
  bottomMargin: 140,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Y do topo da legenda um pouco abaixo da mira: a mira fica no centro
 * da área do jogo (abaixo da faixa da cam). O offset empurra o texto
 * para baixo sem cobrir o centro da tela.
 */
export function captionCrosshairTopY(
  height: number,
  camHeight: number,
  offsetPx = 60,
): number {
  const h = Math.max(1, Number(height) || 1920);
  const top = clamp(Number(camHeight) || 0, 0, h);
  const offset = Number.isFinite(offsetPx) ? offsetPx : 60;
  return Math.round(top + (h - top) / 2 + offset);
}

/**
 * Limpa o texto que a IA devolveu: espaços extras, notas musicais e
 * marcadores entre colchetes (`[music]`) não viram legenda.
 */
export function normalizeCaptionText(raw: string): string {
  let text = String(raw ?? '');
  text = text.replace(/[\u266a\u266b]/g, ' ');
  text = text.replace(/\[[^\]]{0,32}\]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  return text;
}

/**
 * Quebra o texto em linhas de até `maxChars` (palavra inteira quando
 * couber; palavra maior que a linha é cortada).
 */
export function wrapCaptionText(text: string, maxChars: number): string[] {
  const limit = Math.max(8, Math.floor(maxChars));
  const words = String(text ?? '')
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
  return lines;
}

/**
 * Quebra o texto e corta o que não cabe em `maxLines`: a última linha
 * ganha reticências — a legenda não pode ser um mural.
 */
export function fitCaptionLines(
  text: string,
  maxChars: number,
  maxLines: number,
): string[] {
  const lines = wrapCaptionText(text, maxChars);
  if (lines.length === 0) return [];
  const max = Math.max(1, Math.floor(maxLines));
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, Math.max(1, max - 1));
  const tail = lines.slice(Math.max(1, max - 1), max).join(' ');
  kept.push(`${tail.slice(0, Math.max(1, maxChars - 1))}…`);
  return kept;
}

export interface CaptionTimingOptions {
  /** Duração do Short (s) — nada passa dela. */
  durSec: number;
  maxCharsPerLine?: number;
  maxLines?: number;
  /** Tempo máximo de um bloco na tela (s). */
  maxLineSec?: number;
  /** Tempo mínimo de um bloco na tela (s). */
  minLineSec?: number;
}

/**
 * Máximo de caracteres por linha que cabe na largura do vertical
 * (estimativa da largura média do Arial Bold).
 */
export function captionMaxChars(width: number, fontSize: number): number {
  const usable = Math.max(120, (Number(width) || 1080) - 80);
  const size = Math.max(16, Number(fontSize) || 54);
  return Math.max(14, Math.floor(usable / (size * 0.56)));
}

/**
 * Transforma as linhas cruas da transcrição em blocos de legenda prontos:
 * texto limpo, quebrado em no máximo `maxLines` linhas, tempos dentro da
 * duração do Short, sem um bloco por cima do outro e com tempo mínimo de
 * leitura.
 */
export function buildCaptionLines(
  raw: CaptionLine[],
  opts: CaptionTimingOptions,
): CaptionLine[] {
  const dur = Math.max(0.1, Number(opts.durSec) || 0.1);
  const maxChars = opts.maxCharsPerLine ?? CAPTION_DEFAULT_STYLE.maxCharsPerLine;
  const maxLines = opts.maxLines ?? CAPTION_DEFAULT_STYLE.maxLines;
  const maxLineSec = Math.max(1, opts.maxLineSec ?? 6);
  const minLineSec = Math.max(0.2, opts.minLineSec ?? 0.9);
  const out: CaptionLine[] = [];

  for (const item of raw ?? []) {
    const text = normalizeCaptionText(item?.text ?? '');
    if (!text) continue;
    const start = clamp(Number(item.startSec) || 0, 0, dur);
    const end = clamp(Number(item.endSec) || 0, 0, dur);
    if (end - start < 0.05) continue;

    // Um bloco de 15s na tela não é lido: divide em pedaços e reparte o
    // tempo e o texto proporcionalmente.
    const pieces = Math.max(1, Math.ceil((end - start) / maxLineSec));
    if (pieces === 1) {
      out.push(makeCaptionBlock(text, start, end, maxChars, maxLines));
      continue;
    }
    let consumed = 0;
    for (let i = 0; i < pieces; i++) {
      const targetLen =
        i === pieces - 1 ? text.length - consumed : Math.ceil(text.length / pieces);
      // Quebra no limite de palavra (não corta no meio); último pedaço usa até o fim.
      let pieceEnd = Math.min(text.length, consumed + targetLen);
      if (i !== pieces - 1) {
        while (pieceEnd > consumed && text[pieceEnd - 1] !== ' ') pieceEnd--;
        if (pieceEnd === consumed) pieceEnd = Math.min(text.length, consumed + targetLen);
      }
      const piece = text.slice(consumed, pieceEnd).trim();
      consumed = pieceEnd;
      if (!piece) continue;
      const pieceStart = start + ((end - start) * i) / pieces;
      const pieceEndSec =
        i === pieces - 1 ? end : start + ((end - start) * (i + 1)) / pieces;
      out.push(makeCaptionBlock(piece, pieceStart, pieceEndSec, maxChars, maxLines));
    }
  }

  // Um bloco termina quando o próximo começa: legenda não se sobrepõe.
  out.sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].endSec > out[i + 1].startSec) out[i].endSec = out[i + 1].startSec;
  }
  // Tempo mínimo de leitura (e nunca além do fim do Short, nem além do próximo).
  for (const line of out) {
    if (line.endSec - line.startSec < minLineSec) {
      const desired = Math.min(dur, line.startSec + minLineSec);
      const nextStart = out
        .filter((l) => l.startSec > line.startSec + 0.001)
        .sort((a, b) => (a.startSec || 0) - (b.startSec || 0))[0]?.startSec;
      line.endSec = Math.min(desired, nextStart == null ? dur : Math.min(dur, nextStart));
    }
  }
  return out.filter((line) => line.endSec > line.startSec && line.text.trim().length > 0);
}

function makeCaptionBlock(
  text: string,
  startSec: number,
  endSec: number,
  maxChars: number,
  maxLines: number,
): CaptionLine {
  const lines = fitCaptionLines(text, maxChars, maxLines);
  return { startSec, endSec, text: lines.join('\n') };
}

/** Tempo no formato do `.ass` (`H:MM:SS.cc`). */
export function formatAssTime(sec: number): string {
  const totalCs = Math.round(Math.max(0, Number(sec) || 0) * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Escapa o texto para o `.ass`: `{` e `}` abrem blocos de formatação
 * (o libass tentaria interpretá-los) e a quebra de linha vira `\N`.
 */
export function escapeAssText(text: string): string {
  return String(text ?? '')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N');
}

/**
 * Caminho do `.ass` pronto para o filtro `ass` do ffmpeg: barras viram
 * `/`, o `:` da unidade Windows (`C:`) é escapado e o caminho vai entre
 * aspas simples (o filtro separa opções por `:`).
 */
export function escapeAssFilterPath(filePath: string): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  const escaped = normalized.replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * Gera o arquivo `.ass` da legenda (a fonte do libass).
 *
 * A posição é fixada por `\pos` (não pela margem do estilo): por padrão
 * a legenda entra um pouco abaixo da mira do player, no centro da área
 * do jogo; `game-top` volta para logo abaixo da cam e `bottom` para o
 * rodapé.
 */
export function buildCaptionsAss(
  lines: CaptionLine[],
  style: Partial<CaptionStyle> = {},
): string {
  const s: CaptionStyle = { ...CAPTION_DEFAULT_STYLE, ...style };
  // Sanitizar nome de fonte para não quebrar o campo Style: (vírgula, chaves,
  // quebras de linha). O libass usa o nome cru; uma vírgula corrompe a ordem.
  const safeFont = String(s.fontFamily ?? 'Segoe UI Black').replace(/[{},\r\n]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ') || 'Segoe UI Black';
  const x = Math.round(s.width / 2);
  const y =
    s.position === 'bottom' ? Math.round(s.height - s.bottomMargin) : Math.round(s.topY);
  const anchor = s.position === 'bottom' ? 2 : 8;
  const header = [
    '[Script Info]',
    '; Legenda queimada do Short (gerada pelo bot)',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(s.width)}`,
    `PlayResY: ${Math.round(s.height)}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${safeFont},${Math.round(s.fontSize)},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,3,1,${anchor},40,40,20,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const events = (lines ?? [])
    .filter((line) => line && line.text.trim() && line.endSec > line.startSec)
    .map(
      (line) =>
        `Dialogue: 0,${formatAssTime(line.startSec)},${formatAssTime(line.endSec)},Caption,,0,0,0,,` +
        `{\\an${anchor}\\pos(${x},${y})}${escapeAssText(line.text)}`,
    );
  return `${header}\n${events.join('\n')}\n`;
}
