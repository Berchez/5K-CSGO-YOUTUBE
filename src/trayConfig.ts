import fs from 'node:fs';
import path from 'node:path';
import { ConfigSchema } from './config.js';
import type { AppConfig } from './config.js';

export type ConfigGroup = 'capture' | 'stream' | 'clips' | 'youtube' | 'system';

export interface ConfigField {
  key: keyof AppConfig;
  group: ConfigGroup;
  label: string;
  help?: string;
  type: 'number' | 'text' | 'select' | 'boolean';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  advanced?: boolean;
}

export interface EnvReadResult {
  raw: string;
  values: Record<string, string>;
}

export type ConfigPatchResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: Array<{ key: string; message: string }> };

const COUNTRY_OPTIONS = [
  { value: '', label: 'Sem preferência' },
  { value: 'BR', label: 'Brasil (BR)' },
  { value: 'US', label: 'Estados Unidos (US)' },
  { value: 'PT', label: 'Portugal (PT)' },
  { value: 'AR', label: 'Argentina (AR)' },
  { value: 'RU', label: 'Rússia (RU)' },
  { value: 'DE', label: 'Alemanha (DE)' },
  { value: 'FR', label: 'França (FR)' },
  { value: 'ES', label: 'Espanha (ES)' },
  { value: 'PL', label: 'Polônia (PL)' },
  { value: 'UA', label: 'Ucrânia (UA)' },
  { value: 'TR', label: 'Turquia (TR)' },
];

export const EDITABLE_FIELDS: ConfigField[] = [
  {
    key: 'MIN_STARS',
    group: 'capture',
    label: 'Estrelas mínimas',
    help: '0 = qualquer partida; 2 = somente 2★ ou mais. Partidas sem estrela continuam sujeitas ao mínimo de kills.',
    type: 'number',
    min: 0,
    max: 5,
    step: 1,
  },
  {
    key: 'MIN_KILLS',
    group: 'capture',
    label: 'Kills mínimas com estrela',
    help: '4 = 4k/5k; 5 = somente ACE.',
    type: 'number',
    min: 2,
    max: 5,
    step: 1,
  },
  {
    key: 'MIN_KILLS_NO_STARS',
    group: 'capture',
    label: 'Kills mínimas sem estrela',
    help: 'Partidas com 0★ no listing usam este limite (normalmente 5 = ACE).',
    type: 'number',
    min: 2,
    max: 5,
    step: 1,
  },
  {
    key: 'TOP_TIER_ONLY',
    group: 'capture',
    label: 'Somente torneios top-tier',
    help: 'Quando o listing permite classificar; reduz partidas de tier baixo.',
    type: 'boolean',
  },
  {
    key: 'POLL_INTERVAL_MS',
    group: 'capture',
    label: 'Intervalo de poll',
    help: 'Tempo entre verificações do listing. Muito baixo aumenta o risco de Cloudflare.',
    type: 'number',
    min: 5000,
    max: 600000,
    step: 1000,
    unit: 'ms',
  },
  {
    key: 'MAX_RECORDINGS',
    group: 'capture',
    label: 'Gravações simultâneas',
    help: 'Máximo de partidas com buffer ao mesmo tempo.',
    type: 'number',
    min: 1,
    max: 4,
    step: 1,
  },
  {
    key: 'STREAM_PRIORITY',
    group: 'stream',
    label: 'Prioridade de stream',
    help: 'Termos separados por vírgula. Ex.: official,en (oficial primeiro, depois inglês).',
    type: 'text',
  },
  {
    key: 'STREAM_PREFERRED_COUNTRY',
    group: 'stream',
    label: 'País preferido',
    help: 'Tenta primeiro uma stream deste país com audiência suficiente. Se não houver, usa a prioridade normal.',
    type: 'select',
    options: COUNTRY_OPTIONS,
  },
  {
    key: 'STREAM_PREFERRED_MIN_VIEWERS',
    group: 'stream',
    label: 'Audiência mínima do país',
    help: '0 = qualquer audiência. A stream preferida precisa ter pelo menos este número de viewers.',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 500,
    unit: 'viewers',
  },
  {
    key: 'CLIP_PRE_ROLL_SEC',
    group: 'clips',
    label: 'Pré-roll',
    help: 'Buffer antes do primeiro kill incluído no corte.',
    type: 'number',
    min: 15,
    max: 120,
    step: 5,
    unit: 's',
  },
  {
    key: 'CLIP_POST_ROLL_SEC',
    group: 'clips',
    label: 'Pós-roll',
    help: 'Buffer depois do último kill/placar.',
    type: 'number',
    min: 5,
    max: 60,
    step: 1,
    unit: 's',
  },
  {
    key: 'CLIP_CONTEXT_SEC',
    group: 'clips',
    label: 'Contexto antes do ACE',
    help: 'Segundos extras antes da primeira kill quando a âncora é confiável.',
    type: 'number',
    min: 0,
    max: 30,
    step: 1,
    unit: 's',
  },
  {
    key: 'CLIP_CONTEXT_UNCERTAIN_SEC',
    group: 'clips',
    label: 'Contexto com âncora incerta',
    help: 'Contexto maior quando o tracker pode ter entrado no meio do round.',
    type: 'number',
    min: 0,
    max: 120,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'CLIP_UPSCALE_HEIGHT',
    group: 'clips',
    label: 'Upscale do clipe',
    help: '1440p/2160p força codecs melhores no YouTube. 0 mantém a resolução nativa.',
    type: 'select',
    options: [
      { value: '0', label: 'Nativo (sem upscale)' },
      { value: '1080', label: '1080p' },
      { value: '1440', label: '1440p' },
      { value: '2160', label: '2160p (4K)' },
    ],
  },
  {
    key: 'CLIP_STREAM_SYNC',
    group: 'clips',
    label: 'Sync pelo placar',
    help: 'auto aplica o fim do round quando encontra a virada do placar; log só mede; off desliga.',
    type: 'select',
    options: [
      { value: 'auto', label: 'Automático' },
      { value: 'log', label: 'Só registrar' },
      { value: 'off', label: 'Desligado' },
    ],
  },
  {
    key: 'CLIP_AV_SYNC',
    group: 'clips',
    label: 'Correção A/V automática',
    help: 'auto mede e aplica quando os gates de confiança concordam; log só mede; off desliga.',
    type: 'select',
    options: [
      { value: 'auto', label: 'Automática' },
      { value: 'log', label: 'Só registrar' },
      { value: 'off', label: 'Desligada' },
    ],
  },
  {
    key: 'REPLAY_AWARE',
    group: 'clips',
    label: 'Replay-aware',
    help: 'shadow detecta a retomada do round seguinte e registra; off desliga.',
    type: 'select',
    options: [
      { value: 'shadow', label: 'Shadow (recomendado)' },
      { value: 'off', label: 'Desligado' },
      { value: 'on', label: 'Ligado (experimental)' },
    ],
    advanced: true,
  },
  {
    key: 'DISK_MIN_FREE_GB',
    group: 'clips',
    label: 'Disco livre mínimo',
    help: 'Abaixo disso o render é abortado e novos segmentos param de acumular.',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    unit: 'GB',
  },
  {
    key: 'THUMB_MODE',
    group: 'clips',
    label: 'Thumbnail',
    help: 'Composed usa um frame + selo; AI tenta gerar fundo com os providers configurados.',
    type: 'select',
    options: [
      { value: 'composed', label: 'Frame + selo' },
      { value: 'ai', label: 'IA (com fallback)' },
    ],
  },
  {
    key: 'AV_STATIC_OFFSET_MS',
    group: 'clips',
    label: 'Offset A/V estático',
    help: 'Correção manual em ms. Use 0 para desligar.',
    type: 'number',
    min: 0,
    max: 8000,
    step: 100,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'AV_STATIC_MATCHES',
    group: 'clips',
    label: 'Escopo do offset (matchIds)',
    help: 'IDs separados por vírgula. Vazio aplica em todas as partidas (cuidado).',
    type: 'text',
    advanced: true,
  },
  {
    key: 'AV_STREAM_OFFSETS',
    group: 'clips',
    label: 'Offset por stream',
    help: 'Ex.: "ESL TV=2000,Gaules=0".',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_UPLOAD',
    group: 'youtube',
    label: 'Enviar para o YouTube',
    help: 'Desligado = gera e mantém o clipe local, sem upload.',
    type: 'boolean',
  },
  {
    key: 'YT_PRIVACY',
    group: 'youtube',
    label: 'Privacidade do vídeo',
    help: 'O fluxo do bot usa unlisted por padrão.',
    type: 'select',
    options: [
      { value: 'private', label: 'Privado' },
      { value: 'unlisted', label: 'Não listado' },
      { value: 'public', label: 'Público' },
    ],
  },
  {
    key: 'YT_CATEGORY_ID',
    group: 'youtube',
    label: 'Categoria do YouTube',
    help: '20 = Gaming.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_DEFAULT_TAGS',
    group: 'youtube',
    label: 'Tags padrão',
    help: 'Separadas por vírgula.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'THUMB_AI_ORDER',
    group: 'youtube',
    label: 'Ordem dos providers de IA',
    help: 'Ex.: chatgpt,grok,gemini-web. Só usados quando THUMB_MODE=ai.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'THUMB_AI_TIMEOUT_MS',
    group: 'youtube',
    label: 'Timeout da thumb IA',
    help: 'Tempo máximo por provider.',
    type: 'number',
    min: 60000,
    max: 3600000,
    step: 30000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'LOG_LEVEL',
    group: 'system',
    label: 'Nível de log',
    help: 'debug mostra detalhes; info é o padrão; warn/error reduzem o volume.',
    type: 'select',
    options: [
      { value: 'debug', label: 'Debug' },
      { value: 'info', label: 'Info' },
      { value: 'warn', label: 'Warn' },
      { value: 'error', label: 'Error' },
    ],
  },
];

export const EDITABLE_KEYS = new Set<string>(EDITABLE_FIELDS.map((field) => String(field.key)));

export const CONFIG_GROUPS: Array<{ id: ConfigGroup; label: string; description: string }> = [
  { id: 'capture', label: 'Captura', description: 'O que entra no monitor e quantas partidas podem gravar.' },
  { id: 'stream', label: 'Stream', description: 'Qual transmissão é escolhida e em que ordem.' },
  { id: 'clips', label: 'Clipes e thumbs', description: 'Corte, sincronização, espaço em disco e thumbnail.' },
  { id: 'youtube', label: 'YouTube', description: 'Upload, privacidade e metadados.' },
  { id: 'system', label: 'Sistema', description: 'Diagnóstico e comportamento geral.' },
];

function unquoteEnvValue(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      if (first === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return value;
    }
  }
  const comment = value.indexOf(' #');
  if (comment >= 0) value = value.slice(0, comment).trim();
  return value;
}

export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = unquoteEnvValue(match[2]);
  }
  return out;
}

export function readEnvFile(filePath: string): EnvReadResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { raw, values: parseEnvFile(raw) };
  } catch {
    return { raw: '', values: {} };
  }
}

export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_.,:/+\-@%*= ]+$/.test(value) && !value.includes('#')) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function updateEnvFile(
  filePath: string,
  updates: Record<string, string>,
): { backupPath: string | null; changedKeys: string[] } {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = raw === '' || raw.endsWith('\n');
  let lines = raw === '' ? [] : raw.split(/\r?\n/);
  if (hadTrailing && lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.has(key)) throw new Error(`Configuração não editável: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`Valor inválido para ${key}: quebra de linha`);
    const lineRe = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lineRe.test(lines[i])) continue;
      lines[i] = `${key}=${formatEnvValue(value)}`;
      replaced = true;
      changedKeys.push(key);
      break;
    }
    if (!replaced) {
      lines.push(`${key}=${formatEnvValue(value)}`);
      changedKeys.push(key);
    }
  }
  const next = `${lines.join(eol)}${eol}`;
  let backupPath: string | null = null;
  if (raw !== '' && fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    fs.rmSync(tmp, { force: true });
  }
  return { backupPath, changedKeys };
}

function defaultValueFor(key: keyof AppConfig): string {
  const schema = ConfigSchema.shape[key];
  const parsed = schema.safeParse(undefined);
  if (!parsed.success) return '';
  const value = parsed.data;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '');
}

export function configValueForPanel(
  values: Record<string, string>,
  field: ConfigField,
): string {
  const raw = values[field.key];
  return raw === undefined ? defaultValueFor(field.key) : raw;
}

export function panelConfigValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of EDITABLE_FIELDS) out[field.key] = configValueForPanel(values, field);
  return out;
}

export function validateConfigPatch(patch: Record<string, unknown>): ConfigPatchResult {
  const errors: Array<{ key: string; message: string }> = [];
  const values: Record<string, string> = {};
  const fieldByKey = new Map(EDITABLE_FIELDS.map((field) => [String(field.key), field]));
  for (const [key, raw] of Object.entries(patch)) {
    if (!EDITABLE_KEYS.has(key)) {
      errors.push({ key, message: 'Configuração não editável.' });
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      errors.push({ key, message: 'Valor inválido.' });
      continue;
    }
    const field = fieldByKey.get(key);
    let value = String(raw).trim();
    if (field?.type === 'number') {
      const numeric = Number(value);
      if (value === '' || !Number.isFinite(numeric)) {
        errors.push({ key, message: 'Informe um número.' });
        continue;
      }
      if (field.min != null && numeric < field.min) {
        errors.push({ key, message: `Use um valor maior ou igual a ${field.min}.` });
        continue;
      }
      if (field.max != null && numeric > field.max) {
        errors.push({ key, message: `Use um valor menor ou igual a ${field.max}.` });
        continue;
      }
    }
    if (key === 'YT_UPLOAD' || key === 'TOP_TIER_ONLY') {
      const lower = value.toLowerCase();
      if (!['true', 'false', '1', '0'].includes(lower)) {
        errors.push({ key, message: 'Use ligado/desligado.' });
        continue;
      }
      value = lower === 'true' || lower === '1' ? 'true' : 'false';
    }
    if (key === 'STREAM_PREFERRED_COUNTRY') {
      value = value.toUpperCase();
      if (value !== '' && !/^[A-Z]{2,3}$/.test(value)) {
        errors.push({ key, message: 'Use um código de país com 2 ou 3 letras.' });
        continue;
      }
    }
    if (key === 'STREAM_PRIORITY' && value === '') {
      errors.push({ key, message: 'Informe ao menos um critério de prioridade.' });
      continue;
    }
    const schema = ConfigSchema.shape[key as keyof typeof ConfigSchema.shape];
    if (!schema) {
      errors.push({ key, message: 'Configuração desconhecida.' });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ key, message: issue?.message ?? 'Valor inválido.' });
      continue;
    }
    values[key] = value;
  }
  if (Object.keys(values).length === 0 && errors.length === 0) {
    errors.push({ key: '_', message: 'Nenhuma alteração informada.' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
