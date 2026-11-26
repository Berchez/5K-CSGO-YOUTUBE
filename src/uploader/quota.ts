/**
 * Guarda de cota do YouTube (puro).
 *
 * `videos.insert` tem um bucket próprio, separado das units dos demais
 * endpoints. A decisão é isolada aqui (função pura) para poder ser testada
 * sem tocar no banco nem na rede.
 */

export const UPLOAD_CALLS_PER_VIDEO = 1;

export interface QuotaDecision {
  /** Pode subir agora? */
  allowed: boolean;
  /** Uploads já consumidos no dia. */
  used: number;
  /** Limite diário de chamadas `videos.insert`. */
  limit: number;
  /** Chamadas usadas depois do upload atual. */
  uploads: number;
  /** Motivo da recusa (quando `allowed` é false). */
  reason?: string;
}

/**
 * Decide se o upload cabe na cota do dia.
 *
 * O limite padrão é 100 chamadas por dia. O dia usa o fuso configurado
 * em `src/timeZone.ts`; a reserva manual não pode ser consumida pelo bot.
 */
export function quotaDecision(input: {
  used: number;
  limit: number;
  perUpload?: number;
  reservedUploads?: number;
}): QuotaDecision {
  const perUpload = input.perUpload ?? UPLOAD_CALLS_PER_VIDEO;
  const used = Math.max(0, Number(input.used) || 0);
  const limit = Math.max(0, Number(input.limit) || 0);
  const reservedUploads = Math.max(0, Math.floor(Number(input.reservedUploads) || 0));
  const uploads = used + perUpload;
  const automatedLimit = Math.max(0, limit - reservedUploads * perUpload);
  if (uploads > automatedLimit) {
    return {
      allowed: false,
      used,
      limit,
      uploads,
      reason: `limite diário de uploads do YouTube: ${used} usados; ${reservedUploads} reservado(s) para publicação manual (${limit} no total)`,
    };
  }
  return { allowed: true, used, limit, uploads };
}
