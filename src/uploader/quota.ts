/**
 * Guarda de cota do YouTube (puro).
 *
 * Cada `videos.insert` custa 1600 units do limite diário do projeto de
 * API. A decisão é isolada aqui (função pura) para poder ser testada
 * sem tocar no banco nem na rede.
 */

export const QUOTA_UNITS_PER_UPLOAD = 1600;

export interface QuotaDecision {
  /** Pode subir agora? */
  allowed: boolean;
  /** Units já consumidas no dia. */
  used: number;
  /** Teto do dia. */
  limit: number;
  /** Units que o upload atual consumiria. */
  units: number;
  /** Motivo da recusa (quando `allowed` é false). */
  reason?: string;
}

/**
 * Decide se o upload cabe na cota do dia.
 *
 * O limite e o consumo são configuráveis (o padrão do YouTube é 10000,
 * mas o projeto pode ter cota ampliada) e o dia é o do fuso configurado
 * — ver `src/timeZone.ts`.
 */
export function quotaDecision(input: {
  used: number;
  limit: number;
  perUpload?: number;
}): QuotaDecision {
  const perUpload = input.perUpload ?? QUOTA_UNITS_PER_UPLOAD;
  const used = Math.max(0, Number(input.used) || 0);
  const limit = Math.max(0, Number(input.limit) || 0);
  const units = used + perUpload;
  if (units > limit) {
    return {
      allowed: false,
      used,
      limit,
      units,
      reason: `cota diária do YouTube esgotada (${used} units usados; cada upload custa ${perUpload} de ${limit})`,
    };
  }
  return { allowed: true, used, limit, units };
}
