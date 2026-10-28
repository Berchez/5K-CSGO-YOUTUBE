import type { AceEvent } from '../types.js';
import { killLabel, prettyWeapon } from '../detector/aceDetector.js';
import { getLogger } from '../logger.js';

export type MetadataMode = 'ai' | 'template' | 'legacy';
export type MetadataPrivacy = 'private' | 'unlisted' | 'public';

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_MAX = 30;
export const TAGS_CHARS_MAX = 500;

const ALLOWED_EMOJI = ['🔥', '💥', '⚡', '🎯', '💀', '🚨', '❗'];
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const URL_TEST_RE = /https?:\/\/|www\./i;

export interface MetadataFeedRow {
  victim: string;
  weapon: string;
  headshot: boolean;
  noscope: boolean;
  wallbang: boolean;
  assistBy?: string;
  flashAssistBy?: string;
  /** Epoch ms da kill (para o timestamp dentro do vídeo). */
  at?: number;
  /** Segundos desde o início do clipe (undefined = sem timestamp). */
  timeSec?: number;
}

export interface MetadataContext {
  player: string;
  team: string;
  rival: string;
  opponents: string;
  team1: string;
  team2: string;
  matchup: string;
  event: string;
  map: string;
  round: number;
  kills: number;
  label: string;
  headshots: number;
  mainWeapon: string;
  feed: MetadataFeedRow[];
  assists: string[];
  flashAssists: string[];
  grenades: string[];
  score?: string;
  scoreBefore?: string;
  scoreAfter?: string;
  detectedAt: string;
  /** Início do clipe (epoch ms) — âncora dos timestamps das eliminações. */
  clipStartMs?: number;
  /** Duração do clipe (s), quando conhecida. */
  clipDurationSec?: number;
}

export interface MetadataValidation {
  ok: boolean;
  reason?: string;
}

export interface MetadataDraft {
  titles: string[];
  /** Abertura da descrição (impacto + parágrafo). O corpo é determinístico. */
  opening: string;
  /** Alias antigo: aceito como 'opening' quando a IA manda só 'description'. */
  description?: string;
  provider?: string;
}

export type MetadataAiFn = (ctx: MetadataContext) => Promise<MetadataDraft | null>;

export interface MetadataOptions {
  mode?: MetadataMode;
  ai?: MetadataAiFn;
  brand?: string;
  cta?: string;
  privacy?: MetadataPrivacy;
  defaultTags?: string;
  /** Início do clipe (epoch ms): âncora dos timestamps das eliminações. */
  clipStartMs?: number;
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  source: 'ai' | 'template';
  provider?: string;
  reason?: string;
}

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function slugify(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
}

export function buildMetadataContext(
  ace: AceEvent,
  clipStartMs?: number,
): MetadataContext {
  const summary = ace.summary;
  const kills = summary?.kills?.length ?? ace.kills.length;
  const rawKills = summary?.kills ?? ace.kills;
  const feed: MetadataFeedRow[] = rawKills.map((k) => {
    const timeSec =
      clipStartMs != null && k.at != null ? Math.max(0, (k.at - clipStartMs) / 1000) : undefined;
    return {
      victim: k.victim || '?',
      weapon: prettyWeapon(k.weapon ?? ''),
      headshot: Boolean(k.headshot),
      noscope: Boolean(k.noscope),
      wallbang: Boolean(k.wallbang),
      assistBy: k.assistBy,
      flashAssistBy: k.flashAssistBy,
      at: k.at,
      timeSec,
    };
  });
  const team = summary?.team ?? '';
  const team1 = ace.team1 ?? '';
  const team2 = ace.team2 ?? '';
  const matchup = team1 && team2 ? `${team1} vs ${team2}` : team1 || team2;
  const rival = team && team1 && team2 ? (team === team1 ? team2 : team === team2 ? team1 : '') : '';
  const headshots = summary?.headshots ?? feed.filter((f) => f.headshot).length;
  const weaponCounts = new Map<string, number>();
  for (const row of feed) {
    if (!row.weapon) continue;
    weaponCounts.set(row.weapon, (weaponCounts.get(row.weapon) ?? 0) + 1);
  }
  const mainWeapon =
    (summary?.mainWeapon ? prettyWeapon(summary.mainWeapon) : '') ||
    [...weaponCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
    '';
  const assists = [
    ...new Set(
      [
        ...(summary?.assists ?? []).map((a) => a.by),
        ...feed.map((f) => f.assistBy ?? ''),
      ].filter(Boolean),
    ),
  ];
  const flashAssists = [
    ...new Set(
      [
        ...(summary?.flashAssists ?? []).map((a) => a.by),
        ...feed.map((f) => f.flashAssistBy ?? ''),
      ].filter(Boolean),
    ),
  ];
  const grenadeLabels: Record<string, string> = {
    'HE Grenade': 'HE',
    Molotov: 'MOLOTOV',
    Incendiary: 'INC',
  };
  const grenades = [
    ...new Set([
      ...(summary?.grenades ?? []).map((g) => `${g.player} (${g.kind.toUpperCase()})`),
      ...feed
        .filter((f) => grenadeLabels[f.weapon])
        .map((f) => `${ace.player} (${grenadeLabels[f.weapon]})`),
    ]),
  ];
  return {
    player: ace.player ?? '',
    team,
    rival,
    opponents: summary?.opponents || matchup,
    team1,
    team2,
    matchup,
    event: ace.event ?? '',
    map: ace.map ?? '',
    round: ace.round ?? 0,
    kills,
    label: killLabel(kills),
    headshots,
    mainWeapon,
    feed,
    assists,
    flashAssists,
    grenades,
    score: ace.score || undefined,
    scoreBefore: ace.scoreBefore || undefined,
    scoreAfter: ace.scoreAfter || undefined,
    detectedAt: ace.detectedAt ?? '',
    clipStartMs,
    clipDurationSec: clipDurationFromSidecar(ace),
  };
}

function clipDurationFromSidecar(ace: AceEvent): number | undefined {
  const raw = (ace as unknown as { clipDurationSec?: unknown }).clipDurationSec;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function sanitizeTitle(raw: string): string {
  let s = raw ?? '';
  s = s.replace(/\r\n?|\n/g, ' ');
  s = s.replace(URL_RE, ' ');
  s = s.replace(/[«»""''`]/g, '');
  s = s.replace(/#\S+/g, ' ');
  let kept = 0;
  s = s.replace(EMOJI_RE, (m) => {
    const base = m.replace(/\uFE0F/g, '');
    if (kept === 0 && ALLOWED_EMOJI.includes(base)) {
      kept = 1;
      return base;
    }
    return ' ';
  });
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[\s\-—–|:;,]+$/u, '');
  if (s.length > TITLE_MAX) {
    const cut = s.slice(0, TITLE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[\s\-—–|:;,]+$/u, '');
  }
  return s;
}

export function sanitizeDescription(raw: string): string {
  let s = raw ?? '';
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(URL_RE, ' ');
  s = s.replace(EMOJI_RE, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.trim();
  if (s.length > DESCRIPTION_MAX) s = s.slice(0, DESCRIPTION_MAX).trim();
  return s;
}

function factualClaims(text: string, ctx: MetadataContext): MetadataValidation[] {
  const out: MetadataValidation[] = [];
  const clean = text.replace(/#[^\s#]+/g, ' ');
  if (/\bclutch\b/i.test(clean)) out.push({ ok: false, reason: 'afirma clutch' });
  if (/\b1\s*[xv]\s*[2-5]\b/i.test(clean)) out.push({ ok: false, reason: 'afirma 1vX' });
  if (
    /\b(vit[oó]ri[ao]|venceu|vence|derrota|perdeu|perde|comback|virada|gg)\b/i.test(clean)
  ) {
    out.push({ ok: false, reason: 'spoiler de resultado' });
  }
  if (/\bace\b/i.test(clean) && ctx.kills < 5) {
    out.push({ ok: false, reason: `afirma ace com ${ctx.kills} kills` });
  }
  if (/\bquintuple\b/i.test(clean) && ctx.kills < 5) {
    out.push({ ok: false, reason: `afirma quintuple com ${ctx.kills} kills` });
  }
  for (const m of clean.matchAll(
    /(\d+)[ \t]*(?:k(?:ills?|ill)?|elimina(?:ç|c)(?:õ|o)es?|abates?|mortes?)/gi,
  )) {
    const n = Number(m[1]);
    if (n !== ctx.kills) {
      out.push({ ok: false, reason: `contagem de kills contraditória (${n} vs ${ctx.kills})` });
    }
  }
  for (const m of clean.matchAll(/(\d+)[ \t]*(?:hs|head\s?shots?|cabe[cç]adas?)\b/gi)) {
    const n = Number(m[1]);
    if (n !== ctx.headshots) {
      out.push({ ok: false, reason: `contagem de headshots contraditória (${n} vs ${ctx.headshots})` });
    }
  }
  const scores = [ctx.score, ctx.scoreBefore, ctx.scoreAfter].filter(Boolean) as string[];
  if (scores.length > 0) {
    const known = new Set<string>();
    for (const s of scores) {
      known.add(s.replace(/\s/g, ''));
      const parts = s.split('-');
      if (parts.length === 2) known.add(`${parts[1]}-${parts[0]}`);
    }
    for (const m of clean.matchAll(/\b(\d{1,2})[ \t]*-[ \t]*(\d{1,2})\b/g)) {
      const value = `${m[1]}-${m[2]}`;
      if (!known.has(value)) {
        out.push({ ok: false, reason: `placar divergente (${value})` });
      }
    }
  }
  return out;
}

const RIVAL_VERBS =
  'contra|destrói|destruiu|destroi|deletou|dominou|dominando|humilhou|eliminou|eliminando|abateu|abatido|derrubou|derrubando|passou por';
const RIVAL_ARTICLES = '(o\\s+|a\\s+|os\\s+|as\\s+|do\\s+|da\\s+|pelo\\s+|pela\\s+)?';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesUnknownRival(text: string, ctx: MetadataContext): boolean {
  if (ctx.rival) return false;
  const normalized = normalizeText(text);
  for (const team of [ctx.team1, ctx.team2]) {
    if (!team) continue;
    const name = normalizeText(team);
    if (!name) continue;
    const re = new RegExp(
      `\\b(${RIVAL_VERBS})\\s+${RIVAL_ARTICLES}${escapeRegExp(name)}\\b`,
      'i',
    );
    if (re.test(normalized)) return true;
  }
  return false;
}

function anchorMatches(text: string, anchor: string, allowPartial: boolean): boolean {
  const t = normalizeText(text);
  const a = normalizeText(anchor);
  if (!a) return false;
  if (t.includes(a)) return true;
  if (!allowPartial) return false;
  const words = a.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return t.includes(words.slice(0, 2).join(' '));
}

export function validateTitle(title: string, ctx: MetadataContext): MetadataValidation {
  if (!title.trim()) return { ok: false, reason: 'título vazio' };
  if (title.length > TITLE_MAX) return { ok: false, reason: 'acima de 100 caracteres' };
  if (/[\r\n]/.test(title)) return { ok: false, reason: 'quebra de linha' };
  if (URL_TEST_RE.test(title)) return { ok: false, reason: 'contém URL' };
  if (title.includes('#')) return { ok: false, reason: 'contém hashtag' };
  const emojis = title.match(EMOJI_RE) ?? [];
  if (emojis.length > 1) return { ok: false, reason: 'mais de um emoji' };
  if (
    emojis.length === 1 &&
    !ALLOWED_EMOJI.includes(emojis[0].replace(/\uFE0F/g, ''))
  ) {
    return { ok: false, reason: 'emoji não permitido' };
  }
  const claim = factualClaims(title, ctx).find((c) => !c.ok);
  if (claim) return claim;
  if (namesUnknownRival(title, ctx)) {
    return { ok: false, reason: 'nomeia rival sem saber o lado do jogador' };
  }
  if (ctx.player && !normalizeText(title).includes(normalizeText(ctx.player))) {
    return { ok: false, reason: 'não cita o jogador' };
  }
  const eventOk = ctx.event ? anchorMatches(title, ctx.event, true) : false;
  const teamOk = [ctx.team, ctx.team1, ctx.team2].some(
    (t) => !!t && anchorMatches(title, t, false),
  );
  if (!eventOk && !teamOk) {
    return { ok: false, reason: 'não cita evento nem time' };
  }
  return { ok: true };
}

export function validateDescription(
  description: string,
  ctx: MetadataContext,
): MetadataValidation {
  if (!description.trim()) return { ok: false, reason: 'descrição vazia' };
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, reason: 'acima de 5000 caracteres' };
  }
  if (URL_TEST_RE.test(description)) return { ok: false, reason: 'contém URL' };
  const claim = factualClaims(description, ctx).find((c) => !c.ok);
  if (claim) return claim;
  if (namesUnknownRival(description, ctx)) {
    return { ok: false, reason: 'nomeia rival sem saber o lado do jogador' };
  }
  if (ctx.player && !normalizeText(description).includes(normalizeText(ctx.player))) {
    return { ok: false, reason: 'não cita o jogador' };
  }
  return { ok: true };
}

interface TitleTemplate {
  id: string;
  when?: (ctx: MetadataContext) => boolean;
  build: (ctx: MetadataContext) => string;
}

const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: 'kills-map-event',
    build: (c) => `${c.player} fez ${c.kills} kills no ${c.map} | ${c.event} R${c.round}`,
  },
  {
    id: 'label-weapon-matchup',
    when: (c) => !!c.mainWeapon && !!c.matchup,
    build: (c) => `${c.player}: ${c.label} com ${c.mainWeapon} — ${c.matchup} | ${c.event}`,
  },
  {
    id: 'dominated-map-matchup',
    when: (c) => !!c.matchup,
    build: (c) => `${c.player} dominou o ${c.map}: ${c.kills} kills — ${c.matchup}`,
  },
  {
    id: 'highlight',
    build: (c) => `${c.player} foi o destaque: ${c.kills} kills no round ${c.round} | ${c.event}`,
  },
  {
    id: 'streak',
    build: (c) => `${c.player} marcou ${c.kills} kills em sequência no ${c.map} | ${c.event}`,
  },
  {
    id: 'no-space',
    build: (c) => `${c.player} não deu espaço: ${c.kills} kills no ${c.map} | ${c.event}`,
  },
  {
    id: 'kills-label',
    build: (c) => `${c.player} ${c.kills} KILLS no ${c.map} — ${c.label}! ${c.event} R${c.round}`,
  },
  {
    id: 'cleaned-round',
    build: (c) => `${c.player} limpou o round ${c.round}: ${c.kills} kills no ${c.map} | ${c.event}`,
  },
  {
    id: 'headshots',
    when: (c) => c.headshots >= 2,
    build: (c) =>
      `${c.player} com ${c.kills} kills e ${c.headshots} headshots no ${c.map} | ${c.event}`,
  },
  {
    id: 'event-round',
    build: (c) => `${c.player} fez ${c.kills} kills em ${c.event} — ${c.map} R${c.round}`,
  },
  {
    id: 'map-event-round',
    build: (c) => `${c.player} marca ${c.kills} no ${c.map} — ${c.event} R${c.round}`,
  },
  {
    id: 'same-round',
    build: (c) => `${c.player} eliminou ${c.kills} inimigos no mesmo round | ${c.event}`,
  },
  {
    id: 'crushed-map',
    when: (c) => !!c.matchup,
    build: (c) => `${c.player} arrasou o ${c.map}: ${c.kills} kills — ${c.matchup}`,
  },
  {
    id: 'label-map',
    build: (c) => `${c.player} ${c.label} no ${c.map}: ${c.kills} kills | ${c.event}`,
  },
  {
    id: 'flash',
    when: (c) => c.flashAssists.length > 0,
    build: (c) => `${c.player} cegou e matou: ${c.kills} kills no ${c.map} | ${c.event}`,
  },
  {
    id: 'on-fire',
    build: (c) => `${c.player} on fire no ${c.map}: ${c.kills} kills em ${c.event}`,
  },
  {
    id: 'team-matchup',
    when: (c) => !!c.team && !!c.matchup,
    build: (c) =>
      `${c.player} (${c.team}): ${c.kills} kills — ${c.matchup} | ${c.map} R${c.round}`,
  },
  {
    id: 'wiped-rival',
    when: (c) => !!c.rival,
    build: (c) => `${c.player} deletou ${c.rival} no ${c.map} — ${c.kills} kills`,
  },
  {
    id: 'dominated-rival',
    when: (c) => !!c.rival,
    build: (c) => `${c.player} dominou ${c.rival} no ${c.map}: ${c.kills} kills`,
  },
  {
    id: 'passed-rival',
    when: (c) => !!c.rival,
    build: (c) => `${c.player} passou por ${c.rival} e fez ${c.kills} no ${c.map}`,
  },
];

function pickEmoji(ctx: MetadataContext, seed: number): string {
  const pool: string[] = [];
  if (ctx.kills >= 5) pool.push('💀', '🔥', '🚨');
  else pool.push('🔥', '💥');
  if (ctx.headshots >= 2) pool.push('🎯');
  if (ctx.flashAssists.length > 0) pool.push('⚡');
  return pool[seed % pool.length];
}

let templateRotation = 0;
let lastTemplateId: string | null = null;

export function resetTemplateRotation(): void {
  templateRotation = 0;
  lastTemplateId = null;
}

export function titleTemplateIds(): string[] {
  return TITLE_TEMPLATES.map((t) => t.id);
}

export function buildTemplateTitle(ctx: MetadataContext): string {
  const eligible = TITLE_TEMPLATES.filter((t) => !t.when || t.when(ctx));
  const pool = eligible.length > 0 ? eligible : TITLE_TEMPLATES;
  const seed = hashString(
    `${ctx.player}|${ctx.map}|${ctx.event}|${ctx.round}|${ctx.kills}|${ctx.team}`,
  );
  let index = (seed + templateRotation) % pool.length;
  if (pool[index].id === lastTemplateId) index = (index + 1) % pool.length;
  const emoji = pickEmoji(ctx, seed);
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const candidate = pool[(index + attempt) % pool.length];
    const title = sanitizeTitle(`${candidate.build(ctx)} ${emoji}`);
    if (validateTitle(title, ctx).ok) {
      templateRotation = (templateRotation + 1) % Math.max(pool.length, 1);
      lastTemplateId = candidate.id;
      return title;
    }
  }
  templateRotation = (templateRotation + 1) % Math.max(pool.length, 1);
  return sanitizeTitle(`${ctx.label}! ${ctx.player} — ${ctx.map} R${ctx.round} ${emoji}`);
}

const OPENINGS: Array<(ctx: MetadataContext) => string> = [
  (c) =>
    `${c.label} de ${c.player}${c.team ? ` (${c.team})` : ''} no round ${c.round} (${c.map}) — ${c.event}`,
  (c) => `${c.player} pegou o round ${c.round} no ${c.map} — ${c.event}`,
  (c) => `${c.label}! ${c.player} no round ${c.round} (${c.map}) — ${c.event}`,
  (c) => `Round ${c.round}, ${c.map}: ${c.player} marcou ${c.kills} — ${c.event}`,
];

const PARAGRAPHS: Array<(ctx: MetadataContext) => string> = [
  (c) =>
    `${c.player} marcou ${c.kills} eliminações${c.rival ? ` contra ${c.rival}` : ''} no ${c.map}, ` +
    `${c.headshots > 0 ? `com ${c.headshots} headshot${c.headshots > 1 ? 's' : ''} e ` : ''}` +
    `${c.mainWeapon ? `a ${c.mainWeapon} como arma principal` : 'sem trocar de arma'}.`,
  (c) =>
    `${c.kills} eliminações no mesmo round${c.rival ? ` contra ${c.rival}` : ''}: ` +
    `${c.player} não deu espaço no ${c.map}${c.headshots > 0 ? ` e acertou ${c.headshots} headshot${c.headshots > 1 ? 's' : ''}` : ''}.`,
  (c) =>
    `No ${c.map}, ${c.player} apareceu para fechar o round ${c.round}: ${c.kills} eliminações` +
    `${c.mainWeapon ? ` com a ${c.mainWeapon}` : ''}${c.headshots > 0 ? ` e ${c.headshots} headshot${c.headshots > 1 ? 's' : ''}` : ''}.`,
  (c) =>
    `O round ${c.round} no ${c.map} virou spectacle: ${c.player} somou ${c.kills} kills` +
    `${c.flashAssists.length > 0 ? `, com flash de ${c.flashAssists.join(', ')}` : ''}.`,
];

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function killDetails(row: MetadataFeedRow): string {
  const bits = [
    row.weapon,
    row.headshot ? 'HS' : '',
    row.noscope ? 'no-scope' : '',
    row.wallbang ? 'wallbang' : '',
    row.flashAssistBy ? `flash de ${row.flashAssistBy}` : '',
  ].filter(Boolean);
  return bits.length > 0 ? ` (${bits.join(', ')})` : '';
}

function feedLine(row: MetadataFeedRow): string {
  const stamp = row.timeSec != null ? `${formatTimestamp(row.timeSec)} ` : '';
  return `${stamp}matou ${row.victim}${killDetails(row)}`;
}

export function buildTemplateDescription(
  ctx: MetadataContext,
  opts: MetadataOptions = {},
): string {
  return composeDescription(buildOpening(ctx), ctx, opts);
}

export function buildOpening(ctx: MetadataContext): string {
  const seed = hashString(`${ctx.player}|${ctx.map}|${ctx.event}|${ctx.round}|${ctx.kills}`);
  const opening = OPENINGS[seed % OPENINGS.length](ctx);
  const paragraph = PARAGRAPHS[Math.floor(seed / 8) % PARAGRAPHS.length](ctx);
  return `${opening}\n\n${paragraph}`;
}

export function buildRunLine(ctx: MetadataContext, opening?: string): string {
  const parts = [`Round ${ctx.round}`, ctx.map, ctx.matchup];
  // Garante o evento no corpo mesmo quando a abertura da IA não cita.
  if (ctx.event && (!opening || !normalizeText(opening).includes(normalizeText(ctx.event)))) {
    parts.push(ctx.event);
  }
  if (ctx.score) parts.push(`Placar ${ctx.score}`);
  return parts.filter(Boolean).join(' | ');
}

export function buildStatsLine(ctx: MetadataContext): string {
  const parts: string[] = [];
  if (ctx.headshots > 0) parts.push(`${ctx.headshots} headshots`);
  if (ctx.mainWeapon) {
    const used = ctx.feed.filter((f) => f.weapon === ctx.mainWeapon).length;
    parts.push(`arma principal ${ctx.mainWeapon} (${used}/${ctx.kills})`);
  }
  if (ctx.flashAssists.length > 0) parts.push(`flash de ${ctx.flashAssists.join(', ')}`);
  if (ctx.grenades.length > 0) parts.push(`granadas ${ctx.grenades.join(', ')}`);
  if (ctx.assists.length > 0) parts.push(`assist de ${ctx.assists.join(', ')}`);
  if (ctx.clipDurationSec) parts.push(`duração ${formatTimestamp(ctx.clipDurationSec)}`);
  // Sozinho, "5 kills" só repetiria a abertura — a linha some.
  if (parts.length === 0) return '';
  return [`${ctx.kills} kills`, ...parts].join(' | ');
}

export function buildKillList(ctx: MetadataContext): string {
  if (ctx.feed.length === 0) return '';
  return ctx.feed.map((row) => feedLine(row)).join('\n');
}

export function composeDescription(
  opening: string,
  ctx: MetadataContext,
  opts: MetadataOptions = {},
): string {
  const blocks = [opening.trim()];
  const runLine = buildRunLine(ctx, opening);
  if (runLine) blocks.push(runLine);
  const kills = buildKillList(ctx);
  if (kills) blocks.push(kills);
  const stats = buildStatsLine(ctx);
  if (stats) blocks.push(stats);
  blocks.push(buildHashtags(ctx, opts.brand));
  const footer = buildFooter(ctx, opts);
  if (footer) blocks.push(footer);
  return sanitizeDescription(blocks.filter(Boolean).join('\n\n'));
}

export function buildHashtags(ctx: MetadataContext, brand?: string): string {
  const tags: string[] = ['#cs2', '#counterstrike'];
  const mapTag = slugify(ctx.map);
  if (mapTag) tags.push(`#${mapTag}`);
  const labelTag = slugify(ctx.kills >= 5 ? 'ace' : `${ctx.kills}k`);
  if (labelTag) tags.push(`#${labelTag}`);
  const playerTag = slugify(ctx.player);
  if (playerTag) tags.push(`#${playerTag}`);
  const teamTag = slugify(ctx.team);
  if (teamTag) tags.push(`#${teamTag}`);
  for (const team of [ctx.team1, ctx.team2]) {
    const tag = slugify(team);
    if (tag) tags.push(`#${tag}`);
  }
  const eventWord = ctx.event.split(/\s+/).find((w) => slugify(w).length >= 3);
  const eventTag = eventWord ? slugify(eventWord) : '';
  if (eventTag) tags.push(`#${eventTag}`);
  const brandTag = brand ? slugify(brand) : '';
  if (brandTag) tags.push(`#${brandTag}`);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }
  return unique.slice(0, 10).join(' ');
}

export function buildFooter(ctx: MetadataContext, opts: MetadataOptions = {}): string {
  const privacy = opts.privacy ?? 'private';
  const base =
    privacy === 'private'
      ? 'Corte automático para revisão. Publicado como privado.'
      : privacy === 'unlisted'
        ? 'Corte automático. Vídeo não listado: aparece só para quem tem o link.'
        : `Corte automático de ${ctx.player}. Assine o canal para não perder nenhum highlight.`;
  const cta = (opts.cta ?? '').trim();
  return cta ? `${base}\n${cta}` : base;
}

export function buildTags(ctx: MetadataContext, defaults: string[]): string[] {
  const base = defaults.map((t) => t.trim()).filter(Boolean);
  const extra = [
    ctx.player,
    ctx.map,
    ctx.event,
    ctx.team,
    ctx.kills >= 5 ? 'ace' : `${ctx.kills}k`,
  ].filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...base, ...extra]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
    if (unique.length >= TAGS_MAX) break;
  }
  const limited: string[] = [];
  let total = 0;
  for (const tag of unique) {
    if (total + tag.length > TAGS_CHARS_MAX) break;
    total += tag.length;
    limited.push(tag);
  }
  return limited;
}

const usedTitles = new Set<string>();

export function resetUsedTitles(): void {
  usedTitles.clear();
}

export function isUsedTitle(title: string): boolean {
  return usedTitles.has(normalizeText(title));
}

export function rememberTitle(title: string): void {
  usedTitles.add(normalizeText(title));
}

export function buildTemplateMetadata(
  ctx: MetadataContext,
  opts: MetadataOptions = {},
): VideoMetadata {
  const defaults = (opts.defaultTags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    title: buildTemplateTitle(ctx),
    description: buildTemplateDescription(ctx, opts),
    tags: buildTags(ctx, defaults),
    source: 'template',
  };
}

export async function buildVideoMetadata(
  ace: AceEvent,
  opts: MetadataOptions = {},
): Promise<VideoMetadata> {
  const ctx = buildMetadataContext(ace, opts.clipStartMs);
  const template = buildTemplateMetadata(ctx, opts);
  if (opts.mode !== 'ai' || !opts.ai) return template;
  let draft: MetadataDraft | null = null;
  try {
    draft = await opts.ai(ctx);
  } catch (e) {
    return { ...template, reason: `falha da IA: ${String(e).slice(0, 160)}` };
  }
  if (!draft) return { ...template, reason: 'IA sem resultado' };
  let title = '';
  let titleReason = '';
  const log = getLogger().child({ feature: 'metadata' });
  for (const raw of draft.titles ?? []) {
    const candidate = sanitizeTitle(raw);
    if (!candidate) continue;
    const check = validateTitle(candidate, ctx);
    if (!check.ok) {
      if (!titleReason) titleReason = check.reason ?? 'inválido';
      log.warn({ motivo: check.reason, titulo: candidate.slice(0, 120) }, 'título da IA rejeitado');
      continue;
    }
    if (isUsedTitle(candidate)) {
      if (!titleReason) titleReason = 'título repetido';
      continue;
    }
    title = candidate;
    break;
  }
  let description = '';
  const rawOpening = sanitizeDescription(draft.opening ?? draft.description ?? '');
  const openingCheck = validateDescription(rawOpening, ctx);
  if (openingCheck.ok && rawOpening.trim()) {
    const composed = composeDescription(rawOpening, ctx, opts);
    if (validateDescription(composed, ctx).ok) description = composed;
  } else if (rawOpening.trim()) {
    log.warn(
      { motivo: openingCheck.reason, abertura: rawOpening.slice(0, 160) },
      'abertura da IA rejeitada',
    );
  }
  if (!title && !description) {
    return { ...template, reason: titleReason || 'IA rejeitada' };
  }
  if (!title) title = template.title;
  if (!description) description = template.description;
  rememberTitle(title);
  return {
    title,
    description,
    tags: buildTags(
      ctx,
      (opts.defaultTags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
    source: 'ai',
    provider: draft.provider,
    reason: title ? undefined : titleReason || undefined,
  };
}
