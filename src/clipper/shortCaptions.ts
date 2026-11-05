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
import path from 'node:path';

/** Uma linha de legenda (tempos relativos ao INÍCIO do Short). */
export interface CaptionLine {
  startSec: number;
  endSec: number;
  /** Texto da linha; `\n` vira quebra de linha no `.ass`. */
  text: string;
}

/** Onde a legenda fica no vertical. */
export type CaptionPosition = 'game-top' | 'below-crosshair' | 'bottom';

/**
 * Por que a legenda NÃO entrou no vertical.
 *
 * - `no-audio`: o clipe não tem trilha de áudio (não há o que transcrever);
 * - `no-speech`: ninguém falou na janela (estado final);
 * - `error`: a transcrição quebrou (timeout, chave, JSON inválido) — dá
 *   para tentar de novo;
 * - `failed`: a transcrição saiu, mas o libass não queimou a legenda no
 *   mp4 (fonte/ASS) — dá para tentar de novo;
 * - `untranslated`: o áudio era estrangeiro e a legenda ficou no idioma
 *   original (a tradução falhou) — dá para tentar de novo;
 * - `disabled`: a legenda não foi pedida.
 */
export type CaptionSkipReason =
  | 'no-audio'
  | 'no-speech'
  | 'error'
  | 'failed'
  | 'untranslated'
  | 'disabled';

/**
 * A transcrição guardada no marker do Short.
 *
 * Ela existe para RETOMAR do passo que falhou: quando a tradução (ou a
 * revisão) quebra, a próxima rodada reaproveita a transcrição e só
 * refaz o passe que faltou — sem gastar outra chamada de transcrição
 * (a cota do Gemini é pequena) nem rodar o whisper de novo.
 */
export interface CaptionTranscriptCache {
  /** Provider que fez a transcrição. */
  provider?: string;
  /** Idioma detectado pelo provider. */
  language?: string | null;
  /** A legenda já saiu traduzida? */
  translated?: boolean;
  /** Falas (tempos relativos ao início do Short). */
  lines: Array<{ startSec: number; endSec: number; text: string }>;
  /** Falas no idioma original (quando houve tradução). */
  originalLines?: Array<{ startSec: number; endSec: number; text: string }>;
}

/** Como a legenda ficou no vertical (o que o marker do Short guarda). */
export interface CaptionStatus {
  applied: boolean;
  provider?: string;
  language?: string | null;
  lines?: number;
  translated?: boolean;
  reason?: CaptionSkipReason;
  /**
   * Passes que rodaram "pela metade": `translate` (o áudio estrangeiro
   * ficou no idioma original) e/ou `refine` (a revisão não rodou).
   */
  degraded?: Array<'translate' | 'refine'>;
  /**
   * Regras de correção que mexeram na legenda (`molodoij>molodoy`).
   * O dono vê no marker qual regra disparou — é como se caça falso
   * positivo nas regras.
   */
  correctionsApplied?: string[];
  /**
   * Transcrição guardada: a próxima rodada refaz só o passe que
   * falhou (tradução/revisão) sem transcriar de novo.
   */
  transcript?: CaptionTranscriptCache;
}

/**
 * A falha é TÉCNICA (vale tentar de novo) ou FINAL?
 *
 * `no-audio`/`no-speech` são finais: repetir a transcrição não muda nada.
 * `error`/`failed`/`untranslated` são técnicas: a próxima rodada tenta de
 * novo.
 */
export function isRetryableCaptionFailure(
  status: CaptionStatus | null | undefined,
): boolean {
  return (
    status?.reason === 'error' ||
    status?.reason === 'failed' ||
    status?.reason === 'untranslated'
  );
}

/**
 * O Short pode subir sem a legenda que foi pedida?
 *
 * A legenda é pedida com `SHORTS_CAPTIONS=on` (ou sem `--no-captions`).
 * Se a transcrição QUEBROU, publicar assim entrega ao canal um Short sem
 * legenda que nunca mais vai ser refeito (o marker recebe o `youtubeId` e
 * a próxima rodada pula o clipe). Melhor segurar o Short para a próxima
 * rodada tentar de novo — o dono pode forçar com `--allow-no-captions`.
 */
export function canPublishShortWithCaptions(opts: {
  /** A legenda foi pedida? */
  captionsOn: boolean;
  /** Como a legenda ficou no arquivo que vai subir. */
  status: CaptionStatus | null | undefined;
  /** O dono mandou publicar mesmo sem a legenda? */
  allowNoCaptions: boolean;
}): { publish: boolean; reason?: string } {
  if (!opts.captionsOn) return { publish: true };
  // A legenda queimada está no IDIOMA ORIGINAL: o áudio estrangeiro não
  // foi traduzido. Publicar assim entrega ao canal um Short com legenda
  // em inglês — o Short fica para a próxima rodada (o tradutor pode
  // funcionar na próxima, depois da cota resetar).
  if (opts.status?.reason === 'untranslated') {
    if (opts.allowNoCaptions) return { publish: true };
    return {
      publish: false,
      reason:
        'a legenda ficou no idioma original (a tradução falhou) — a próxima rodada tenta de novo',
    };
  }
  if (opts.status?.applied) return { publish: true };
  if (!isRetryableCaptionFailure(opts.status)) return { publish: true };
  if (opts.allowNoCaptions) return { publish: true };
  return {
    publish: false,
    reason: `a legenda falhou (${opts.status?.reason}) — a próxima rodada tenta de novo`,
  };
}

/**
 * O erro do render veio do FILTRO de legenda (ass/libass/fonte)?
 *
 * Só nesse caso vale refazer o vertical sem a legenda: nas outras
 * causas (disco cheio, timeout, crop inválido) o render sem legenda
 * também falha e a mensagem real se perde.
 */
export function isCaptionFilterError(error: unknown): boolean {
  const message = String(
    (error as { message?: string })?.message ?? error ?? '',
  ).toLowerCase();
  return /parsed_ass|libass|\bass\b|fontselect|glyph|subtitle|caption/.test(message);
}

/** Quantas vezes a publicação do Short já falhou. */
export interface ShortAttemptState {
  /** Tentativas que falharam (a que está em curso ainda não conta). */
  attempts?: number | null;
  /** Quando foi a última tentativa que falhou (ISO). */
  lastAttemptAt?: string | null;
}

/**
 * Teto de tentativas: depois disso o Short para de ser tentado sozinho
 * (o dono tem que pedir com `--force`).
 */
export const MAX_SHORT_ATTEMPTS = 5;

/** Espera entre as tentativas: cresce com o número de falhas (ms). */
const RETRY_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/**
 * Quanto tempo esperar antes da próxima tentativa.
 *
 * A primeira falha espera 10min, a segunda 30min, a terceira 2h e a
 * quarta 6h: um provedor de IA fora do ar não pode virar uma fila de
 * chamadas a cada rodada.
 */
export function shortRetryBackoffMs(attempts: number): number {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  if (n === 0) return 0;
  const idx = Math.min(n - 1, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx];
}

/**
 * O Short deve ser pulado AGORA?
 *
 * - Backoff: a última falha foi há pouco (não adianta tentar de novo
 *   na mesma hora — o provedor provavelmente ainda está fora);
 * - Teto: já falhou `MAX_SHORT_ATTEMPTS` vezes — o dono precisa mandar
 *   com `--force`.
 */
export function shortRetryDecision(
  state: ShortAttemptState | null | undefined,
  nowMs: number = Date.now(),
): { skip: boolean; reason?: string; waitMs?: number } {
  const attempts = Math.max(0, Math.floor(Number(state?.attempts) || 0));
  if (attempts <= 0) return { skip: false };
  if (attempts >= MAX_SHORT_ATTEMPTS) {
    return {
      skip: true,
      reason: `já falhou ${attempts} vez(es) — o Short precisa de --force para ser tentado de novo`,
    };
  }
  const last = state?.lastAttemptAt ? Date.parse(String(state.lastAttemptAt)) : NaN;
  if (!Number.isFinite(last)) return { skip: false };
  const waitMs = shortRetryBackoffMs(attempts);
  const elapsed = nowMs - last;
  if (elapsed < waitMs) {
    const minRest = Math.ceil((waitMs - elapsed) / 60_000);
    return {
      skip: true,
      reason: `aguardando ${minRest}min antes de tentar de novo (última tentativa há ${Math.max(1, Math.floor(elapsed / 60_000))}min)`,
      waitMs: waitMs - elapsed,
    };
  }
  return { skip: false };
}

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
  /**
   * A fonte da legenda é a VERSÃO NO REPO (assets/fonts/BarlowCondensed-Bold.ttf).
   * Uma fonte do sistema ("Segoe UI Black") não existe em toda máquina e o
   * libass cairia num fallback silencioso — a legenda saía com outra
   * fonte em cada host (e a largura medida não batia).
   */
  fontFamily: 'Barlow Condensed',
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
 * Máximo de caracteres por linha que cabe na largura do vertical.
 *
 * `avgCharWidth` é a largura MÉDIA por caractere na fonte da legenda
 * (medida na fonte do repo). O padrão é o valor conservador de uma
 * fonte bold qualquer (0.62): com a fonte errada a linha estoura e o
 * libass re-quebra sozinho, furando o limite de linhas.
 */
export function captionMaxChars(
  width: number,
  fontSize: number,
  avgCharWidth = 0.62,
): number {
  const usable = Math.max(120, (Number(width) || 1080) - 80);
  const size = Math.max(16, Number(fontSize) || 54);
  const avg = Math.max(0.2, Number(avgCharWidth) || 0.62);
  return Math.max(14, Math.floor(usable / (size * avg)));
}

/**
 * Quebra o texto em BLOCOS que cabem em `maxLines` (sem perder fala).
 *
 * O texto é quebrado em linhas e as linhas viram grupos de `maxLines`:
 * cada grupo cabe na tela. Nenhum trecho é cortado com reticências —
 * o que não couber vira OUTRO bloco, com o tempo repartido.
 */
export function captionTextChunks(
  text: string,
  maxChars: number,
  maxLines: number,
): string[][] {
  const lines = wrapCaptionText(text, maxChars);
  if (lines.length === 0) return [];
  const max = Math.max(1, Math.floor(maxLines));
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += max) {
    chunks.push(lines.slice(i, i + max));
  }
  return chunks;
}

/** Reparte as palavras do texto em `pieces` grupos (sem cortar palavra). */
function splitTextByWords(text: string, pieces: number): string[] {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const count = Math.max(1, Math.min(pieces, words.length));
  const out: string[] = [];
  const per = Math.ceil(words.length / count);
  for (let i = 0; i < words.length; i += per) {
    out.push(words.slice(i, i + per).join(' '));
  }
  return out;
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

    // O bloco é dividido em pedaços que CABEM na tela (no máximo
    // `maxLines` linhas) e na tela por tempo (no máximo `maxLineSec`).
    // NENHUM trecho de fala é cortado: o que não cabe vira outro
    // pedaço, e o tempo é repartido entre eles.
    const span = end - start;
    const byTime = Math.max(1, Math.ceil(span / maxLineSec));
    let pieces = byTime;
    let groups: string[][] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      groups = splitTextByWords(text, pieces).map((part) => wrapCaptionText(part, maxChars));
      if (groups.every((g) => g.length > 0 && g.length <= maxLines)) break;
      pieces += 1;
    }
    if (groups.length === 0) continue;
    // A parte que ainda não cabe (palavra enorme) é o último recurso:
    // corta com reticências em vez de estourar a tela.
    const safeGroups = groups.map((g) =>
      g.length > maxLines ? fitCaptionLines(g.join(' '), maxChars, maxLines) : g,
    );

    const step = span / safeGroups.length;
    safeGroups.forEach((group, i) => {
      const pieceStart = start + step * i;
      const pieceEnd = i === safeGroups.length - 1 ? end : start + step * (i + 1);
      out.push({ startSec: pieceStart, endSec: pieceEnd, text: group.join('\n') });
    });
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
 * Nome do `.ass` que o filtro `ass` aceita.
 *
 * O filtro separa opções por `:` e a aspa simples fecha o valor: um
 * nome com apóstrofo (`O'Brien.ass`) quebrava o filtergraph. O nome
 * seguro tem só letras, números, ponto, hífen e underscore.
 */
export function safeAssName(filePath: string): string {
  const base = path.basename(String(filePath ?? ''));
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean || 'caption.ass';
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
