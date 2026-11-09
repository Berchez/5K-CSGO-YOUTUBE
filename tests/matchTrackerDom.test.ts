import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  isGenericTeamLabel,
  readMatchSnapshot,
  resolvePlayerTeam,
} from '../src/detector/matchTracker.js';

/**
 * Fixture do placar do HLTV (página de match).
 *
 * O placar LIVE (`table.team`) é injetado client-side e às vezes traz só
 * um rótulo genérico no cabeçalho ("Players") — sem o nome do time. A
 * tabela de stats da página (`table.totalstats`) é a que amarra o
 * jogador ao time (`tr.header-row` com `a.teamName`).
 */

let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (e) {
    browser = null; // sem browser do Playwright: os testes de DOM são pulados
    if (process.env.CI) {
      throw new Error(
        `Chromium do Playwright indisponível na CI (${String(e).slice(0, 200)}) — rode npm run playwright:install`,
      );
    }
  }
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

/** Placar live: o cabeçalho é o texto que o HLTV põe no lugar do time. */
function liveWidget(
  header: string,
  players: Array<{ name: string; kills: number; deaths: number }>,
): string {
  const rows = players
    .map(
      (p) => `
      <tr>
        <td class="identityColumns">${p.name}</td>
        <td class="statCell killCell">${p.kills}</td>
        <td class="statCell deathCell">${p.deaths}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="team">
      <thead>
        <tr><th class="identityColumns">${header}</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Tabela de stats da página (a que amarra jogador → time). */
function statsTable(blocks: Array<{ team: string; players: string[] }>): string {
  const body = blocks
    .map(
      (block) => `
      <tr class="header-row">
        <td class="players"><a class="teamName team" href="/team/1/x">${block.team}</a></td>
      </tr>
      ${block.players
        .map(
          (name) => `
        <tr>
          <td class="players"><a href="/player/1/${name.toLowerCase()}">${name}</a></td>
        </tr>`,
        )
        .join('')}`,
    )
    .join('');
  return `<table class="table totalstats">${body}</table>`;
}

async function snapshot(html: string) {
  if (!browser) throw new Error('playwright indisponível');
  const page: Page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await readMatchSnapshot(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

describe('placar: o time do jogador (DOM real do HLTV)', () => {
  it('cabeçalho com o nome do time: o time vem do placar', async (ctx) => {
    if (!browser) return ctx.skip();
    const snap = await snapshot(
      liveWidget('FURIA', [{ name: 'yuriz', kills: 5, deaths: 2 }]),
    );
    expect(snap?.players[0]).toMatchObject({ name: 'yuriz', kills: 5, team: 'FURIA' });
  });

  it('cabeçalho genérico ("Players"): o time vem da tabela de stats', async (ctx) => {
    if (!browser) return ctx.skip();
    const snap = await snapshot(
      liveWidget('Players', [{ name: 'yuriz', kills: 5, deaths: 2 }]) +
        statsTable([
          { team: 'FORZE Reload', players: ['yuriz', 'kn1ght'] },
          { team: 'Imperial', players: ['FalleN'] },
        ]),
    );
    expect(snap?.players[0]).toMatchObject({ name: 'yuriz', team: 'FORZE Reload' });
  });

  it('sem nome do time em lugar nenhum: o jogador fica SEM time (fail-closed)', async (ctx) => {
    if (!browser) return ctx.skip();
    const snap = await snapshot(
      liveWidget('Players', [{ name: 'yuriz', kills: 5, deaths: 2 }]),
    );
    expect(snap?.players[0].team).toBeUndefined();
  });

  it('as duas tabelas do placar (CT/T) não se misturam', async (ctx) => {
    if (!browser) return ctx.skip();
    const snap = await snapshot(
      liveWidget('FURIA', [{ name: 'yuriz', kills: 5, deaths: 2 }]) +
        liveWidget('Imperial', [{ name: 'FalleN', kills: 3, deaths: 1 }]),
    );
    expect(snap?.players.map((p) => [p.name, p.team])).toEqual([
      ['yuriz', 'FURIA'],
      ['FalleN', 'Imperial'],
    ]);
  });
});

describe('rótulo genérico de time (puro)', () => {
  it('"Players"/"Team"/vazio são genéricos', () => {
    expect(isGenericTeamLabel('Players')).toBe(true);
    expect(isGenericTeamLabel('players')).toBe(true);
    expect(isGenericTeamLabel('Team')).toBe(true);
    expect(isGenericTeamLabel('')).toBe(true);
    expect(isGenericTeamLabel(null)).toBe(true);
    expect(isGenericTeamLabel(undefined)).toBe(true);
  });

  it('um nome de time de verdade não é genérico', () => {
    expect(isGenericTeamLabel('FURIA')).toBe(false);
    expect(isGenericTeamLabel('Team Vitality')).toBe(false);
  });

  it('resolvePlayerTeam: cabeçalho válido > tabela de stats > desconhecido', () => {
    const blocks = [{ team: 'FORZE Reload', players: ['yuriz'] }];
    expect(resolvePlayerTeam('FURIA', 'yuriz', blocks)).toBe('FURIA');
    expect(resolvePlayerTeam('Players', 'yuriz', blocks)).toBe('FORZE Reload');
    expect(resolvePlayerTeam('Players', 'ninguem', blocks)).toBeUndefined();
    expect(resolvePlayerTeam(null, 'yuriz', [])).toBeUndefined();
  });
});
