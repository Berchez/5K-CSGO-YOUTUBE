import fs from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import type { AceEvent } from '../types.js';
import { killLabel, prettyWeapon } from '../detector/aceDetector.js';
import type { ReferenceImages } from './referenceImages.js';
import { getPlayerImage } from './thumbCutout.js';
import {
  fitThumbTextSize,
  loadThumbFont,
  measureThumbText,
  thumbTextPath,
  type ThumbFont,
} from './thumbText.js';

/**
 * Thumb COMPOSTA: montagem determinística com sharp.
 *
 * O fundo vem da IA (só cenário, sem gente/texto/logo) e o resto é
 * montado localmente: foto do jogador recortada, logos dos times, foto do
 * mapa, killfeed e todos os textos desenhados em PATH (fonte brush
 * versionada no repo). Sem IA de imagem para o texto — o texto é sempre
 * legível e nunca alucinado.
 *
 * O caminho do chatgpt (thumb 100% IA) NÃO entra aqui — ele é preservado
 * byte a byte (ver tests/thumbGolden.test.ts).
 */

export const COMPOSITE_W = 1280;
export const COMPOSITE_H = 720;

/** Cor de destaque do canal (mesma do prompt da IA). */
export const ACCENT_HEX = '#B6FF00';
const VICTIM_HEX = '#5AA9E6';
const WHITE_HEX = '#FFFFFF';

export interface CompositeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CompositeKillRow {
  killer: string;
  weapon: string;
  headshot: boolean;
  victim: string;
}

export interface CompositeLayout {
  width: number;
  height: number;
  /** Label grande: '3K' | '4K' | 'ACE'. */
  label: string;
  /** Label secundário: '5K' quando é ACE, senão vazio. */
  subLabel: string;
  playerName: string;
  event: string;
  playerTeam: string;
  /** O time do JOGADOR é conhecido (não foi assumido pelo card)? */
  playerTeamKnown: boolean;
  opponent: string;
  /** Lado esquerdo do rodapé (nome + de qual logo vem). */
  footerLeft: CompositeFooterSide;
  /** Lado direito do rodapé (nome + de qual logo vem). */
  footerRight: CompositeFooterSide;
  footer: string;
  kills: CompositeKillRow[];
  logoBox: CompositeBox;
  eventBox: CompositeBox;
  nameBox: CompositeBox;
  playerBox: CompositeBox;
  labelBox: CompositeBox;
  killfeedBox: CompositeBox;
  mapBox: CompositeBox;
  footerBox: CompositeBox;
}

/**
 * Lado do rodapé: o NOME e o LOGO são sempre do mesmo time.
 *
 * `logoSlot` diz de qual logo do card o lado usa (1 = `team1Logo`,
 * 2 = `team2Logo`) — sem isso o nome do adversário podia aparecer ao lado
 * do logo do time errado (o nome é o do time 1 com o logo do time 2).
 */
export interface CompositeFooterSide {
  name: string;
  logoSlot: 1 | 2;
}

const KILL_ROW_H = 54;

/**
 * Compara nomes de time sem depender da grafia (espaços, caixa).
 *
 * `summary.team` vem do card do HLTV e nem sempre é idêntico a
 * `team1`/`team2` (ex.: "NAVI" vs "Natus Vincere"): sem normalizar, o
 * time do jogador era considerado desconhecido e o adversário saía
 * errado.
 */
export function normalizeTeamName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Layout da thumb composta (PURO — sem I/O, testável).
 * Mesma divisão de zonas do layout do canal: logo+evento+nome à esquerda,
 * retrato no centro, label grande ao lado, killfeed+mapa à direita.
 */
export function compositeLayout(ace: AceEvent): CompositeLayout {
  const s = ace.summary;
  const kills = s?.kills ?? ace.kills;
  const n = kills.length;
  const label = killLabel(n);
  const subLabel = n >= 5 ? '5K' : '';
  const team1 = ace.team1;
  const team2 = ace.team2;
  const summaryTeam = String(s?.team ?? '').trim();
  const summaryKey = normalizeTeamName(summaryTeam);
  // O time do jogador só é "conhecido" quando bate com um dos times do
  // card: um nome diferente (grafia outra) NÃO prova que o jogador é do
  // time 2 — antes isso assumia team1 e errava metade das vezes.
  const playerTeamSlot: 1 | 2 | null =
    summaryKey && summaryKey === normalizeTeamName(team1)
      ? 1
      : summaryKey && summaryKey === normalizeTeamName(team2)
        ? 2
        : null;
  const team = playerTeamSlot === 1 ? team1 : playerTeamSlot === 2 ? team2 : team1;
  const opponent = playerTeamSlot === 2 ? team1 : team2;
  const footer = summaryTeam ? `${team} vs ${opponent}` : `${team1} vs ${team2}`;
  // No AO VIVO o time do jogador é desconhecido (`summary.team` vazio):
  // o `team1` do card do HLTV é o time do CARD, não necessariamente o
  // dele — assumircia metade das vezes e mostraria o logo errado.
  const playerTeamKnown = playerTeamSlot != null;
  // Rodapé: nome e logo do MESMO time em cada lado. O lado direito é o
  // adversário (quando conhecido) e o esquerdo é o time do jogador.
  const footerLeft: CompositeFooterSide =
    playerTeamSlot === 2
      ? { name: team2, logoSlot: 2 }
      : { name: team1, logoSlot: 1 };
  const footerRight: CompositeFooterSide =
    playerTeamSlot === 2
      ? { name: team1, logoSlot: 1 }
      : { name: team2, logoSlot: 2 };

  const rows: CompositeKillRow[] = kills.map((k) => ({
    killer: k.killer || ace.player,
    weapon: prettyWeapon(k.weapon ?? ''),
    headshot: !!k.headshot,
    victim: k.victim || '?',
  }));

  const killfeedTop = 14;
  const killfeedHeight = rows.length * KILL_ROW_H + 14;
  const mapTop = Math.min(killfeedTop + killfeedHeight + 18, COMPOSITE_H - 220);

  return {
    width: COMPOSITE_W,
    height: COMPOSITE_H,
    label,
    subLabel,
    playerName: ace.player,
    event: ace.event,
    playerTeam: team,
    playerTeamKnown,
    opponent,
    footerLeft,
    footerRight,
    footer,
    kills: rows,
    logoBox: { left: 28, top: 22, width: 168, height: 168 },
    eventBox: { left: 28, top: 196, width: 430, height: 42 },
    nameBox: { left: 20, top: 240, width: 420, height: 140 },
    playerBox: { left: 196, top: 0, width: 480, height: COMPOSITE_H },
    labelBox: { left: 600, top: 30, width: 290, height: 220 },
    killfeedBox: { left: 896, top: killfeedTop, width: 372, height: killfeedHeight },
    mapBox: { left: 880, top: mapTop, width: 392, height: Math.max(220, 660 - mapTop) },
    footerBox: { left: 24, top: 592, width: 620, height: 112 },
  };
}

function escapeXml(text: string): string {
  const amp = String.fromCharCode(38);
  return text
    .replace(/&/g, `${amp}amp;`)
    .replace(/</g, `${amp}lt;`)
    .replace(/>/g, `${amp}gt;`)
    .replace(/"/g, `${amp}quot;`);
}

/** Texto como path; se a fonte não existir, cai para <text> do sistema. */
function drawText(
  font: ThumbFont,
  text: string,
  x: number,
  baseline: number,
  size: number,
  fill: string,
  extra = '',
): string {
  if (!text) return '';
  const loaded = loadThumbFont(font);
  if (!loaded) {
    return `<text x="${x}" y="${baseline}" font-family="Arial Black, Arial, sans-serif" font-size="${size}" font-weight="900" fill="${fill}" ${extra}>${escapeXml(text)}</text>`;
  }
  return `<path d="${thumbTextPath(loaded, text, x, baseline, size)}" fill="${fill}" ${extra}/>`;
}

/** Largura do texto na fonte (0 se a fonte não existir). */
function textWidth(font: ThumbFont, text: string, size: number): number {
  const loaded = loadThumbFont(font);
  if (!loaded) return text.length * size * 0.55;
  return measureThumbText(loaded, text, size);
}

/** Tamanho da fonte que cabe na largura máxima. */
function fitSize(font: ThumbFont, text: string, maxWidth: number, desired: number, min: number): number {
  const loaded = loadThumbFont(font);
  if (!loaded) return desired;
  return fitThumbTextSize(loaded, text, maxWidth, desired, min);
}

/**
 * Linha do killfeed que CABE na caixa.
 *
 * Nome longo + arma + vítima saíam do canvas (o texto do killfeed era o
 * único sem ajuste de largura). Aqui a fonte encolhe até caber e, se ainda
 * não couber, o texto é cortado com reticências.
 */
export interface KillfeedRowFit {
  killer: string;
  weapon: string;
  victim: string;
  killerSize: number;
  weaponSize: number;
  victimSize: number;
  /** Largura total da linha (medida na fonte do repo). */
  width: number;
}

export function fitKillfeedRow(row: CompositeKillRow, budget: number): KillfeedRowFit {
  const GAP = 16;
  const iconW = row.headshot ? 26 : 0;
  let killerSize = 28;
  let weaponSize = 24;
  let victimSize = 28;
  let killer = row.killer ?? '';
  let weapon = row.weapon ?? '';
  let victim = row.victim ?? '';
  const width = (): number => {
    let total = textWidth('ui', killer, killerSize);
    if (weapon) total += GAP + textWidth('ui', weapon, weaponSize);
    if (row.headshot) total += GAP + iconW;
    total += GAP + textWidth('ui', victim, victimSize);
    return total;
  };
  // 1) encolhe as fontes (até um piso legível).
  for (let i = 0; i < 24 && width() > budget; i++) {
    const current = width();
    const ratio = current > 0 ? budget / current : 1;
    const nextKiller = Math.max(14, Math.floor(killerSize * ratio));
    const nextWeapon = Math.max(12, Math.floor(weaponSize * ratio));
    const nextVictim = Math.max(14, Math.floor(victimSize * ratio));
    if (nextKiller === killerSize && nextWeapon === weaponSize && nextVictim === victimSize) break;
    killerSize = nextKiller;
    weaponSize = nextWeapon;
    victimSize = nextVictim;
  }
  // 2) ainda não cabe: corta o texto mais longo (a reticências ocupa o
  // lugar do último caractere, senão o texto não encurtava).
  const cut = (text: string): string =>
    text.length <= 1 ? text : `${text.slice(0, text.length - 2)}…`;
  let guard = 0;
  while (width() > budget && guard < 200) {
    guard++;
    if (killer.length >= victim.length && killer.length > 1) {
      killer = cut(killer);
    } else if (victim.length > 1) {
      victim = cut(victim);
    } else if (weapon.length > 1) {
      weapon = cut(weapon);
    } else {
      break;
    }
  }
  return { killer, weapon, victim, killerSize, weaponSize, victimSize, width: width() };
}

/**
 * Camada SVG com TODOS os textos (em path), painéis e acentos.
 * `playerFramed` desenha a moldura do retrato quando não há cutout.
 */
export function compositeOverlaySvg(
  layout: CompositeLayout,
  opts: { hasMap: boolean; playerFramed: boolean } = { hasMap: true, playerFramed: false },
): Buffer {
  const parts: string[] = [];

  // Vinheta + escurecimento do rodapé (legibilidade do texto).
  parts.push(`<defs>
  <linearGradient id="fadeBottom" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.72"/>
  </linearGradient>
  <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.75">
    <stop offset="0.45" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.8"/>
  </radialGradient>
</defs>`);
  parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="url(#fadeBottom)"/>`);
  parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="url(#vignette)"/>`);

  // Diagonais de tinta (acento do canal).
  parts.push(
    `<polygon points="0,470 0,395 520,720 430,720" fill="${ACCENT_HEX}" opacity="0.16"/>`,
    `<polygon points="700,0 760,0 380,720 320,720" fill="${ACCENT_HEX}" opacity="0.1"/>`,
  );

  // Painel do mapa (borda de acento).
  if (opts.hasMap) {
    const m = layout.mapBox;
    parts.push(
      `<rect x="${m.left}" y="${m.top}" width="${m.width}" height="${m.height}" fill="none" stroke="${ACCENT_HEX}" stroke-width="4" opacity="0.9"/>`,
    );
  }

  // Moldura do retrato (fallback sem cutout).
  if (opts.playerFramed) {
    const p = layout.playerBox;
    parts.push(
      `<rect x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" fill="none" stroke="${ACCENT_HEX}" stroke-width="4" opacity="0.85"/>`,
    );
  }

  // Killfeed: painel + linhas.
  const kf = layout.killfeedBox;
  parts.push(
    `<rect x="${kf.left}" y="${kf.top}" width="${kf.width}" height="${kf.height}" rx="8" fill="#000000" opacity="0.62"/>`,
    `<rect x="${kf.left}" y="${kf.top}" width="6" height="${kf.height}" fill="${ACCENT_HEX}" opacity="0.95"/>`,
  );
  layout.kills.forEach((row, i) => {
    const baseline = kf.top + 14 + i * KILL_ROW_H + 30;
    const x0 = kf.left + 18;
    // A linha tem que caber na caixa do killfeed (o nome + a arma + a
    // vítima saíam do canvas quando o nome era longo).
    const fit = fitKillfeedRow(row, kf.width - 18 - 12);
    let x = x0;
    parts.push(drawText('ui', fit.killer, x, baseline, fit.killerSize, ACCENT_HEX));
    x += textWidth('ui', fit.killer, fit.killerSize) + 16;
    if (fit.weapon) {
      parts.push(
        drawText('ui', fit.weapon, x, baseline, fit.weaponSize, WHITE_HEX, 'opacity="0.9"'),
      );
      x += textWidth('ui', fit.weapon, fit.weaponSize) + 16;
    }
    if (row.headshot) {
      // Mira = headshot (o SVG não tem ícone de caveira da CS2).
      parts.push(
        `<g opacity="0.95"><circle cx="${x + 8}" cy="${baseline - 9}" r="8" fill="none" stroke="${WHITE_HEX}" stroke-width="2"/><line x1="${x}" y1="${baseline - 9}" x2="${x + 16}" y2="${baseline - 9}" stroke="${WHITE_HEX}" stroke-width="2"/><line x1="${x + 8}" y1="${baseline - 17}" x2="${x + 8}" y2="${baseline - 1}" stroke="${WHITE_HEX}" stroke-width="2"/></g>`,
      );
      x += 26;
    }
    parts.push(drawText('ui', fit.victim, x, baseline, fit.victimSize, VICTIM_HEX));
  });

  // Evento (topo esquerdo, abaixo do logo).
  const evSize = fitSize('ui', layout.event, layout.eventBox.width, 34, 20);
  parts.push(drawText('ui', layout.event, layout.eventBox.left, layout.eventBox.top + 30, evSize, WHITE_HEX));

  // Nome do jogador (brush, branco) — sombra + texto.
  const nameSize = fitSize('script', layout.playerName, layout.nameBox.width, 116, 52);
  const nameBase = layout.nameBox.top + nameSize;
  parts.push(
    drawText(
      'script',
      layout.playerName,
      layout.nameBox.left + 5,
      nameBase + 5,
      nameSize,
      '#000000',
      'opacity="0.55"',
    ),
    drawText('script', layout.playerName, layout.nameBox.left, nameBase, nameSize, WHITE_HEX),
  );

  // Label grande (4K/ACE) + "5K" embaixo quando é ACE.
  const labelSize = fitSize('display', layout.label, layout.labelBox.width, 180, 84);
  const labelBase = layout.labelBox.top + labelSize;
  parts.push(
    drawText(
      'display',
      layout.label,
      layout.labelBox.left + 4,
      labelBase + 5,
      labelSize,
      '#000000',
      'opacity="0.5"',
    ),
    drawText('display', layout.label, layout.labelBox.left, labelBase, labelSize, ACCENT_HEX),
  );
  const labelW = textWidth('display', layout.label, labelSize);
  parts.push(
    `<polygon points="${layout.labelBox.left - 6},${labelBase + 14} ${layout.labelBox.left + labelW + 8},${labelBase + 2} ${layout.labelBox.left + labelW + 2},${labelBase + 22} ${layout.labelBox.left - 12},${labelBase + 34}" fill="${ACCENT_HEX}" opacity="0.9"/>`,
  );
  if (layout.subLabel) {
    const subSize = fitSize('display', layout.subLabel, 180, 84, 48);
    parts.push(
      drawText('display', layout.subLabel, layout.labelBox.left + 8, labelBase + subSize + 18, subSize, WHITE_HEX),
    );
  }

  // Rodapé: VS + nome do adversário (os logos são imagens).
  // O NOME é o do time cujo LOGO está ao lado dele (nunca o do outro).
  const fb = layout.footerBox;
  const vsSize = 34;
  const vsX = fb.left + 70;
  const name2X = fb.left + 204;
  const name2Size = fitSize('ui', layout.footerRight.name, 380, 42, 24);
  parts.push(
    drawText('ui', 'VS', vsX, fb.top + 46, vsSize, WHITE_HEX),
    drawText('ui', layout.footerRight.name, name2X, fb.top + 46, name2Size, WHITE_HEX),
  );

  const svg = `<svg width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  return Buffer.from(svg);
}

/** Tamanho do conteúdo dentro da caixa (fit contain). */
function containSize(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { width: number; height: number } {
  const scale = Math.min(boxW / srcW, boxH / srcH);
  return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) };
}

/** Logo quadrado dentro da caixa (fit contain), centralizado. */
async function logoLayer(file: string, box: CompositeBox): Promise<{ input: Buffer; left: number; top: number } | null> {
  if (!fs.existsSync(file)) return null;
  try {
    const meta = await sharp(file).metadata();
    const srcW = meta.width ?? box.width;
    const srcH = meta.height ?? box.height;
    const size = containSize(srcW, srcH, box.width, box.height);
    const input = await sharp(file)
      .resize(size.width, size.height, { fit: 'fill' })
      .png()
      .toBuffer();
    return {
      input,
      left: box.left + Math.round((box.width - size.width) / 2),
      top: box.top + Math.round((box.height - size.height) / 2),
    };
  } catch {
    return null;
  }
}

export interface CompositeThumbnailOptions {
  ace: AceEvent;
  /** Fundo IA (ou frame real) — só o cenário entra na montagem. */
  background: Buffer;
  refs?: ReferenceImages;
  outPath: string;
  /** Pasta do cache dos recortes (default data/clips/refs/cutouts). */
  cutoutCacheDir?: string;
}

/**
 * Monta a thumb composta e grava em `outPath` (JPEG 1280x720).
 */
export async function buildCompositeThumbnail(opts: CompositeThumbnailOptions): Promise<string> {
  const layout = compositeLayout(opts.ace);
  const refs = opts.refs;
  const layers: OverlayOptions[] = [];

  // Mapa (foto do mapa) no canto direito inferior.
  let hasMap = false;
  if (refs?.mapImage && fs.existsSync(refs.mapImage)) {
    try {
      const input = await sharp(refs.mapImage)
        .resize(layout.mapBox.width, layout.mapBox.height, { fit: 'cover' })
        .modulate({ brightness: 0.92 })
        .jpeg({ quality: 88 })
        .toBuffer();
      layers.push({ input, top: layout.mapBox.top, left: layout.mapBox.left });
      hasMap = true;
    } catch {
      // sem mapa: o fundo IA fica no lugar
    }
  }

  // Retrato do jogador (recortado ou emoldurado).
  let playerFramed = false;
  const player = await getPlayerImage(refs?.player, {
    cacheDir: opts.cutoutCacheDir,
    framedWidth: layout.playerBox.width,
    framedHeight: layout.playerBox.height,
  });
  if (player) {
    try {
      if (player.kind === 'cutout') {
        // Corta a borda transparente e encaixa em pé, encostado na base.
        const trimmed = await sharp(player.buffer)
          .trim({ background: '#00000000', threshold: 2 })
          .toBuffer();
        const meta = await sharp(trimmed).metadata();
        const size = containSize(
          meta.width ?? layout.playerBox.width,
          meta.height ?? layout.playerBox.height,
          layout.playerBox.width,
          layout.playerBox.height,
        );
        const input = await sharp(trimmed)
          .resize(size.width, size.height, { fit: 'fill' })
          .png()
          .toBuffer();
        layers.push({
          input,
          top: layout.playerBox.top + layout.playerBox.height - size.height,
          left: layout.playerBox.left + Math.round((layout.playerBox.width - size.width) / 2),
        });
      } else {
        playerFramed = true;
        const input = await sharp(player.buffer)
          .resize(layout.playerBox.width, layout.playerBox.height, { fit: 'cover' })
          .png()
          .toBuffer();
        layers.push({ input, top: layout.playerBox.top, left: layout.playerBox.left });
      }
    } catch {
      // retrato não encaixou: segue sem ele
    }
  }

  // Logo do time do JOGADOR (topo esquerdo). Só entra quando o time do
  // jogador é conhecido: no ao vivo ele é desconhecido e o `team1` do
  // card é só o time do CARD (mostrar esse logo aqui era 50% errado).
  const playerLogoFile = layout.playerTeamKnown
    ? layout.footerLeft.logoSlot === 2
      ? refs?.team2Logo
      : refs?.team1Logo
    : undefined;
  const logo1 = playerLogoFile ? await logoLayer(playerLogoFile, layout.logoBox) : null;
  if (logo1) layers.push({ input: logo1.input, top: logo1.top, left: logo1.left });

  // Logos do rodapé: o logo de cada lado vem do mesmo time do nome.
  const footLogoSize = 58;
  const footBox1 = { left: layout.footerBox.left, top: layout.footerBox.top + 6, width: footLogoSize, height: footLogoSize };
  const footBox2 = { left: layout.footerBox.left + 130, top: layout.footerBox.top + 6, width: footLogoSize, height: footLogoSize };
  const logoFor = (slot: 1 | 2): string | undefined =>
    slot === 1 ? refs?.team1Logo : refs?.team2Logo;
  const foot1File = logoFor(layout.footerLeft.logoSlot);
  const foot2File = logoFor(layout.footerRight.logoSlot);
  const foot1 = foot1File ? await logoLayer(foot1File, footBox1) : null;
  const foot2 = foot2File ? await logoLayer(foot2File, footBox2) : null;
  if (foot1) layers.push({ input: foot1.input, top: foot1.top, left: foot1.left });
  if (foot2) layers.push({ input: foot2.input, top: foot2.top, left: foot2.left });

  const overlay = compositeOverlaySvg(layout, { hasMap, playerFramed });

  await sharp(opts.background)
    .resize(layout.width, layout.height, { fit: 'cover' })
    .modulate({ brightness: 0.82, saturation: 0.92 })
    .composite([...layers, { input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(opts.outPath);
  return opts.outPath;
}
