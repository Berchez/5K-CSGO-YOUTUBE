/**
 * Dia de cota em um fuso horário arbitrário.
 *
 * POR QUE: a cota do YouTube NÃO zera à meia-noite UTC — ela zera à
 * meia-noite do horário do Pacifico (Los Angeles). A guarda local usava
 * o dia UTC e bloqueava publicações legítima bem antes da cota real
 * acabar (o dia UTC "anda" 7–8h na frente do dia do Pacifico).
 *
 * Tudo aqui é PURO (a entrada é o instante; a saída é o cálculo) — o
 * `Intl` do Node resolve o fuso sem depender do relógio do sistema.
 */

/** Partes de data/hora de um instante em um fuso (via `Intl`). */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  // `hour` pode vir como '24' à meia-noite (bug antigo do ICU): vira 0.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Deslocamento do fuso (ms) em um instante: `local - utc`.
 *
 * Positivo = o fuso está à frente do UTC (ex.: +09:00 do Japao).
 */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // O relógio de parede não tem fração de segundo: truncar o instante
  // antes da subtração evita devolver o deslocamento "menos os ms" (o
  // `slice` de `sqlDateTime` mascarava, mas a conta ficava errada).
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSecond;
}

/**
 * Início do dia (00:00) do fuso em um instante dado.
 *
 * Duas passadas: a primeira estima com o deslocamento do UTC, a segunda
 * refaz com o deslocamento REAL do instante estimado (é o que resolve a
 * virada do horário de verão).
 */
export function startOfDayInTimeZone(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  const wallUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const guess = new Date(wallUtc - timeZoneOffsetMs(instant, timeZone));
  const refined = new Date(wallUtc - timeZoneOffsetMs(guess, timeZone));
  return refined;
}

/** `Date` → `'YYYY-MM-DD HH:MM:SS'` (formato do SQLite). */
export function sqlDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Início do dia do fuso em texto SQLite (pronto para o `WHERE`).
 *
 * Ex.: em `America/Los_Angeles`, 2026-11-14T00:30Z (que ainda é 13/11
 * 16:30 em LA) devolve o início de 2026-11-13 no Pacífico.
 */
export function startOfDaySql(instant: Date, timeZone: string): string {
  return sqlDateTime(startOfDayInTimeZone(instant, timeZone));
}
