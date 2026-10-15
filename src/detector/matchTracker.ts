import type { Page } from 'playwright';
import { waitForClearance } from '../monitor/hltvMonitor.js';
import { RoundTracker } from './aceDetector.js';
import type { AnchorConfidence, KillEvent } from '../types.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';

export interface ScoreboardPlayer {
  name: string;
  kills: number;
  /** Coluna D do scoreboard — alimenta as vítimas dos kills sintetizados. */
  deaths?: number;
}

export interface RoundSnapshot {
  players: ScoreboardPlayer[];
  ctScore: number;
  tScore: number;
  map: string;
  round: number;
}

/**
 * Lê scoreboard + placar da página do match.
 *
 * REGRAS do page.evaluate (causaram ReferenceError __name antes):
 * NENHUMA função nomeada aqui dentro — nem `const f = (...) =>`,
 * nem `function f...`. O tsx injeta o helper `__name`, inexistente no
 * browser. Só closures inline (.map/.filter/.some diretos).
 *
 * Não há killfeed no DOM (só tabela de stats) — a detecção usa diff da
 * coluna K por jogador (ver RoundTracker.syncBaseline). Vítimas/armas NÃO
 * vêm no placar: kills sintetizados carregam victim '' (honesto: "?" nos
 * textos) e `at` do momento observado.
 */
export async function readMatchSnapshot(page: Page): Promise<RoundSnapshot | null> {
    try {
    const snap = await page.evaluate(() => {
      // Página de desafio do Cloudflare: sem placar real. Retorna null para
      // o loop esperar e tentar de novo (placar 0-0 fantasma causaria
      // virada de round falsa e reset).
      if (/just a moment|um momento|attention required|security check|cloudflare|verifying/i.test(document.title)) {
        return null;
      }
      const ctEl = document.querySelector('.ctScore');
      const tEl = document.querySelector('.tScore');
      const ct = Number.parseInt(((ctEl && ctEl.textContent) || '0').trim(), 10) || 0;
      const t = Number.parseInt(((tEl && tEl.textContent) || '0').trim(), 10) || 0;

      const players: Array<{ name: string; kills: number; deaths: number }> = [];
      for (const tbl of Array.from(document.querySelectorAll('table.team'))) {
        for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
          if (tr.closest('thead')) continue;
          const nameEl = tr.querySelector('.identityColumns');
          const killEl = tr.querySelector('td.statCell.killCell');
          const deathEl = tr.querySelector('td.statCell.deathCell');
          const name = ((nameEl && nameEl.textContent) || '').trim().replace(/\s+/g, ' ');
          const kText = ((killEl && killEl.textContent) || '').trim();
          if (!name || !/^\d+$/.test(kText)) continue;
          const dText = ((deathEl && deathEl.textContent) || '').trim();
          players.push({
            name: name.slice(0, 40),
            kills: Number.parseInt(kText, 10),
            deaths: /^\d+$/.test(dText) ? Number.parseInt(dText, 10) : 0,
          });
        }
      }

      // Mapa atual: fundo do scoreboard (de_inferno.png) — mais confiável
      // que a lista de tabs [class*="mapname"].
      let map = 'map1';
      const bg = document.querySelector('.scoreboard [style*="scoreboardmaps"]');
      const bgStyle = (bg && bg.getAttribute('style')) || '';
      const bgMatch = bgStyle.match(/scoreboardmaps\/de_([a-z0-9]+)\.png/i);
      if (bgMatch) {
        const m = bgMatch[1].toLowerCase();
        map = m.charAt(0).toUpperCase() + m.slice(1);
      } else {
        const mapEl = document.querySelector('[class*="mapname"]');
        const mapText = ((mapEl && mapEl.textContent) || '').trim();
        if (mapText) map = mapText.slice(0, 30);
      }
      const round = ct + t + 1;
      return { players, ctScore: ct, tScore: t, map, round };
    });
    if (!snap) return null;
    return snap as RoundSnapshot;
  } catch {
    return null;
  }
}

export interface TrackerCallbacks {
  onAce: (ace: {
    player: string;
    map: string;
    round: number;
    kills: KillEvent[];
    /** ISO do 1º kill — ancora o início do clipe. */
    startedAt?: string;
    /** Confiança na âncora (1ª kill pode não ser a 1ª real). */
    anchorConfidence?: AnchorConfidence;
  }) => void;
  shouldStop: () => boolean;
}

export interface PollEvent {
  player: string;
  map: string;
  round: number;
  kills: KillEvent[];
  startedAt?: string;
  /** Confiança na âncora de início (1ª kill pode não ser a 1ª real). */
  anchorConfidence?: AnchorConfidence;
}

/** Máximo de kills possíveis num round (5 adversários). Acima = dado corrompido (gap). */
export const MAX_KILLS_PER_ROUND = 5;

/**
 * Decide se o tracker deve resetar sem emitir: ficou cego tempo demais
 * (>150s cobrem qualquer round incl. bomb) ou pulou round (>1 de salto =
 * rounds perdidos no apagão). Evita falsos multikills gigantes com kills
 * de vários rounds somados (ex: 22 kills "no round 1").
 */
export function shouldResetTracker(
  lastSeenRound: number,
  snapRound: number,
  lastGoodAt: number,
  now: number,
): boolean {
  if (lastSeenRound < 0) return false;
  if (now - lastGoodAt > 150_000) return true;
  if (snapRound > lastSeenRound + 1) return true;
  return false;
}

/**
 * Compensação do delay do placar live (~placar atualiza segundos depois
 * do kill): ancora o clipe esse tanto antes do 1º kill observado. O valor
 * vem de SCOREBOARD_DELAY_MS (config) — padrão 10s, calibrável.
 */
export function processPoll(
  tracker: RoundTracker,
  snap: RoundSnapshot,
  lastTotal: number,
  minKills: number,
  delayCompMs = 10_000,
): { event: PollEvent | null; dropped: string | null; roundClosed: { map: string; round: number; score: string } | null; lastTotal: number } {
  const total = snap.ctScore + snap.tScore;
  let event: PollEvent | null = null;
  let dropped: string | null = null;
  let roundClosed: { map: string; round: number; score: string } | null = null;
  // Estreia com placar > 0 = tracking começou no meio da partida (round já
  // em andamento): kills anteriores a este poll são invisíveis — a próxima
  // âncora deste round nasce suspeita.
  if (lastTotal < 0 && total > 0) {
    tracker.markJoinedBlind();
  }
  // Virada de round = placar mudou (ou OT: total >= 24 continua valendo).
  if (lastTotal >= 0 && total !== lastTotal) {
    // ANTES de fechar: a coluna K atrasa em relação ao placar de score —
    // diffs que chegam agora (janela de assentamento) pertencem ao round
    // que está fechando, não ao novo (freeze de 15s = sem kills no início
    // do round novo). Sincronizar DEPOIS do closeRound atribuía os kills
    // do round passado ao novo (falsos "3k" misturando rounds).
    tracker.syncBaseline(snap.players);
    const flags = tracker.anchorFlags();
    // Fecha o round: no máximo UM evento por round/jogador, sempre na
    // contagem máxima (3k→4k→5k não duplica). kills = SÓ os do autor.
    const { player, kills } = tracker.closeRound(minKills);
    if (player && kills.length >= minKills) {
      if (kills.length > MAX_KILLS_PER_ROUND) {
        dropped = `${player} com ${kills.length} kills (impossível — gap corrompeu a base)`;
      } else {
        const firstAt = kills[0]?.at;
        // Kills observadas na janela de assentamento (últimos 12s: settle
        // de 10s + folga): se a 1ª kill está entre elas, a sequência inteira
        // foi observada no apagar das luzes — relâmpago legítimo OU kill do
        // round novo carimbada no antigo. Nos dois casos, âncora suspeita.
        const closedAtMs = Date.now();
        const settleKills = kills.filter((k) => (k.at ?? 0) >= closedAtMs - 12_000).length;
        const anchorConfidence: AnchorConfidence = { ...flags, settleKills };
        // Round VERDADEIRO = o dos kills (snap.round já é o próximo placar).
        const trueRound = kills[0]?.round ?? snap.round;
        event = {
          player,
          map: snap.map,
          round: trueRound,
          kills,
          startedAt: firstAt ? new Date(firstAt - delayCompMs).toISOString() : undefined,
          anchorConfidence,
        };
      }
    } else {
      roundClosed = { map: snap.map, round: snap.round, score: `${snap.ctScore}-${snap.tScore}` };
    }
    // Contexto do round novo (baselines já ancoradas pelo sync acima —
    // diffs do round novo só contam a partir dos PRÓXIMOS polls).
    tracker.setContext(snap.map, snap.round);
  } else {
    // Diferenciais da coluna K viram kills sintetizados; os da coluna D
    // (deaths) alimentam as vítimas. Round corrente.
    tracker.syncBaseline(snap.players);
  }
  return { event, dropped, roundClosed, lastTotal: total };
}

/**
 * Polling por partida. Detecta virada de round via soma dos placares
 * (CS2 MR12: termina em 13, com OT — não mais 16).
 */
export async function trackMatch(
  matchPageUrl: string,
  matchId: string,
  cb: TrackerCallbacks,
  minKills = 3,
): Promise<void> {
  const log = getLogger().child({ matchId });
  const { newTrackedPage } = await import('../monitor/hltvMonitor.js');
  const page = await newTrackedPage();
  const tracker = new RoundTracker();
  const startedAt = Date.now();
  try {
    await page.goto(matchPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Se o Cloudflare segurar, espera liberando sem martelar navegações
    // (a mesma página é reusada o tracking inteiro — o placar live
    // atualiza sozinho via scorebot, sem reload). Desiste após ~6min sem
    // clearance: sem isso a aba fica presa (em branco) para sempre enquanto
    // a partida constar como live.
    let clearanceWaitedMs = 0;
    while (!cb.shouldStop()) {
      if (await waitForClearance(page, 20000)) break;
      clearanceWaitedMs += 35_000;
      if (clearanceWaitedMs > 6 * 60_000) {
        log.error('clearance nunca liberou, abortando tracking');
        return;
      }
      log.warn('aguardando clearance do Cloudflare p/ iniciar tracking');
      await page.waitForTimeout(15000);
    }
    let lastTotal = -1;
    let lastSeenRound = -1;
    let lastGoodAt = 0;
    log.info('iniciando tracking do match');

    while (!cb.shouldStop()) {
      // Rede de segurança: nenhuma partida dura 5h — tracking preso (página
      // morta, scorebot parado) fecha a aba em vez de vazar para sempre.
      if (Date.now() - startedAt > 5 * 3_600_000) {
        log.warn('tracking passou de 5h, encerrando por segurança');
        break;
      }
      let snap = await readMatchSnapshot(page);
      if (!snap) {
        await page.waitForTimeout(5000);
        continue;
      }
      // Placar virou? Espera a coluna K assentar (ela atrasa em relação ao
      // placar — sem isso o último kill do round cai no round seguinte ou
      // some, e um 5k vira "4k"). 10s é seguro: rounds duram ~100s+.
      const total = snap.ctScore + snap.tScore;
      if (lastTotal >= 0 && total !== lastTotal) {
        await page.waitForTimeout(10000);
        const fresh = await readMatchSnapshot(page);
        if (fresh) snap = fresh;
      }
      // Apagão longo ou rounds pulados: reancora sem emitir (evita falsos
      // multikills gigantes com kills de vários rounds somados).
      const nowMs = Date.now();
      if (shouldResetTracker(lastSeenRound, snap.round, lastGoodAt, nowMs)) {
        log.warn({ de: lastSeenRound, para: snap.round }, 'gap no tracking, reancorando baselines');
        tracker.reset();
      }
      lastSeenRound = snap.round;
      lastGoodAt = nowMs;
      const { event, dropped, roundClosed, lastTotal: next } = processPoll(
        tracker,
        snap,
        lastTotal,
        minKills,
        getConfig().SCOREBOARD_DELAY_MS,
      );
      lastTotal = next;
      if (event) {
        log.info(
          { player: event.player, kills: event.kills.length, map: event.map, round: event.round },
          'multikill detectado',
        );
        cb.onAce(event);
      } else if (dropped) {
        log.warn({ dropped, map: snap.map, round: snap.round }, 'multikill descartado');
      } else if (roundClosed) {
        log.info(roundClosed, 'round fechado sem multikill');
      }

      // Fim de mapa melhor-de: MR12 → 13 wins; OT vai além de 24 rounds
      if (snap.ctScore === 13 || snap.tScore === 13) {
        // Não para de imediato: pode ter OT ou próximo mapa — espera 60s
        await page.waitForTimeout(60000);
        const again = await readMatchSnapshot(page);
        if (!again || (again.ctScore === 13 || again.tScore === 13)) break;
      }
      await page.waitForTimeout(3000);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}
