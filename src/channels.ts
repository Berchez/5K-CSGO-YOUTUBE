/**
 * Identidade de canal (multi-canal).
 *
 * Dado gravado antes do multi-canal não tem `channelId` (sidecar antigo,
 * linha do banco, pasta de clipe). Todo leitor assume o canal DEFAULT
 * (BR) — nunca inventa outro.
 */
export const DEFAULT_CHANNEL_ID = 'br';

/**
 * Id válido: começa com letra minúscula e só tem [a-z0-9_].
 *
 * Sem `-`: o id vira PREFIXO de env (`PT-BR_`), e nem o shell nem o pm2
 * aceitam esse nome de variável (`export PT-BR_X=1` é erro de sintaxe).
 */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
}

/** Normaliza para comparação/prefixo (trim + minúsculo). Não valida. */
export function normalizeChannelId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Id de um dado gravado (sidecar, linha do banco).
 *
 * - AUSENTE (sidecar v1, linha antiga): assume o canal default (`br`) —
 *   dado legado é do BR, nunca de outro canal;
 * - PRESENTE e INVÁLIDO: erro. Um id inválido não pode virar `br` em
 *   silêncio: o clipe do EN seria publicado no canal do BR.
 */
export function channelIdOrDefault(value: unknown): string {
  if (value == null) return DEFAULT_CHANNEL_ID;
  const id = normalizeChannelId(value);
  if (id === '') return DEFAULT_CHANNEL_ID;
  if (!isChannelId(id)) {
    throw new Error(`channelId inválido: "${String(value)}"`);
  }
  return id;
}

/** Prefixo das envs do canal (`en` -> `EN_`). */
export function channelEnvPrefix(id: string): string {
  return `${normalizeChannelId(id).toUpperCase()}_`;
}

/** O canal default (BR) é o único que lê as chaves SEM prefixo. */
export function isDefaultChannel(id: string): boolean {
  return normalizeChannelId(id) === DEFAULT_CHANNEL_ID;
}

/**
 * Lê `--channel <id>` / `--channel=<id>` de uma linha de comando.
 *
 * Default = canal DEFAULT (BR) para os scripts continuarem funcionando
 * sem flag. Um id inválido falha alto: script de auth/cota no canal
 * errado é caro (token/cota do projeto errado).
 */
export function channelFromArgv(
  argv: string[],
  fallback: string = DEFAULT_CHANNEL_ID,
): string {
  let raw: string | undefined;
  let found = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel') {
      found = true;
      raw = argv[i + 1];
      break;
    }
    if (arg.startsWith('--channel=')) {
      found = true;
      raw = arg.slice('--channel='.length);
      break;
    }
  }
  if (!found) return fallback;
  const id = normalizeChannelId(raw);
  if (!isChannelId(id)) {
    throw new Error(
      `--channel inválido: "${raw ?? ''}" (use letra inicial e [a-z0-9_])`,
    );
  }
  return id;
}
