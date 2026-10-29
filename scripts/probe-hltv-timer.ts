/**
 * Probe: o HLTV expõe o TEMPO do round (timer) no DOM da partida live?
 *
 * Por que importa: o timer no vídeo (OCR) seria o melhor sensor de
 * sincronização — dá o relógio do jogo a cada frame, sem depender de
 * latência estimada. Mas para comparar com o vídeo, o bot precisa do
 * MESMO relógio no lado do HLTV. Se o HLTV publicar o timer, dá para
 * casar os dois e calibrar a latência continuamente; se não publicar,
 * a única fonte de relógio do jogo continua sendo o placar (que só
 * muda a cada kill/fim de round).
 *
 * Uso:
 *   npx tsx scripts/probe-hltv-timer.ts
 *   npx tsx scripts/probe-hltv-timer.ts <urlDaPartida>
 *
 * O probe só LÊ a página (mesmo perfil/clearance do bot) e imprime o
 * que encontrou. Não muda nada no bot.
 */
import { getBrowser, fetchMatchListing } from '../src/monitor/hltvMonitor.js';
import { getConfig } from '../src/config.js';
import { closeBrowser } from '../src/monitor/hltvMonitor.js';

interface TimerProbe {
  url: string;
  ctScore: string | null;
  tScore: string | null;
  /** Elementos cujo class/id parece timer/relogio/clock. */
  timerLike: Array<{ sel: string; text: string; attrs: string }>;
  /** Texto do container .scoreboard (primeiros 400 chars). */
  scoreboardText: string | null;
  /** Todos os atributos data-* do container do scoreboard. */
  dataAttrs: string[];
  /** Qualquer texto que pareça mm:ss. */
  clockTexts: string[];
  /** Timer do ROUND no placar (o que o tracker usa). */
  roundTimerText: string | null;
  /** Detalhe dos elementos mm:ss: onde est�o no DOM. */
  clockElements: Array<{
    text: string;
    sel: string;
    parent: string;
    inScoreboard: boolean;
    attrs: string;
  }>;
}

async function probePage(url: string): Promise<TimerProbe> {
  const ctx = await getBrowser();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(8000);
    return (await page.evaluate(() => {
      // SEM fun��es nomeadas dentro do evaluate: o tsx injeta o helper
      // __name, que n�o existe no browser (mesma regra do matchTracker).
      const timerLike: Array<{ sel: string; text: string; attrs: string }> = [];
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const ident = `${el.className || ''} ${el.id || ''}`.toLowerCase();
        if (!/(timer|clock|relogio|time)/.test(ident)) continue;
        const attrs = Array.from(el.attributes)
          .map((a) => `${a.name}="${a.value}"`)
          .join(' ')
          .slice(0, 200);
        timerLike.push({
          sel: el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(/\s+/).join('.')}` : ''),
          text: ((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          attrs,
        });
        if (timerLike.length >= 25) break;
      }
      const clockTexts: string[] = [];
      for (const el of all) {
        const t = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
        if (/^\d{1,2}:\d{2}$/.test(t) && clockTexts.length < 20) clockTexts.push(t);
      }
      const scoreboard = document.querySelector('.scoreboard');
      const dataAttrs = scoreboard
        ? Array.from(scoreboard.attributes)
            .filter((a) => a.name.startsWith('data-'))
            .map((a) => `${a.name}="${a.value}"`)
        : [];
      const ct = document.querySelector('.ctScore');
      const t = document.querySelector('.tScore');
      // Detalhe de cada mm:ss: onde ele est� no DOM (� o timer do round
      // ou um hor�rio qualquer da p�gina?).
      const clockElements: Array<{
        text: string;
        sel: string;
        parent: string;
        inScoreboard: boolean;
        attrs: string;
      }> = [];
      for (const el of all) {
        const text = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
        if (!/^\d{1,2}:\d{2}$/.test(text)) continue;
        if (clockElements.length >= 20) break;
        const cls = String(el.className || '');
        const parentCls = String((el.parentElement && el.parentElement.className) || '');
        clockElements.push({
          text,
          sel: el.tagName.toLowerCase() + (cls ? `.${cls.split(/\s+/).join('.')}` : ''),
          parent: parentCls,
          inScoreboard: !!(scoreboard && scoreboard.contains(el)),
          attrs: Array.from(el.attributes)
            .map((a) => `${a.name}="${a.value}"`)
            .join(' ')
            .slice(0, 160),
        });
      }
      // O timer do ROUND no placar (o que o tracker usa para saber o fim
      // real do round): .scoreboard .timeText
      const roundTimerEl =
        document.querySelector('.scoreboard .timeText') ||
        document.querySelector('.scoreboard [class*="timeText"]') ||
        document.querySelector('.timeText');
      const roundTimerText = ((roundTimerEl && roundTimerEl.textContent) || '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        url: '',
        ctScore: ((ct && ct.textContent) || '').trim(),
        tScore: ((t && t.textContent) || '').trim(),
        timerLike,
        scoreboardText:
          ((scoreboard && scoreboard.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null,
        dataAttrs,
        clockTexts,
        clockElements,
        roundTimerText: roundTimerText || null,
      };
    })) as TimerProbe;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const cfg = getConfig();
  let url = process.argv[2];
  if (!url) {
    console.log('procurando uma partida live no listing...');
    // Sem os filtros do bot (estrela/tier): o probe quer QUALQUER partida
    // live � o timer no DOM n�o depende do filtro.
    const listing = await fetchMatchListing(cfg.HLTV_MATCHES_URL, 0, false, {
      watchlist: { version: 1, enabled: false, defaults: { minKills: cfg.MIN_KILLS, clutch: false }, teams: [], players: [] },
      starredMinKills: cfg.MIN_KILLS,
      unstarredMinKills: cfg.MIN_KILLS_NO_STARS,
    });
    if (!listing.ok) {
      console.log(`listing indisponível (${listing.reason}): ${listing.detail ?? ''}`);
      return;
    }
    const live = listing.listing.live;
    if (live.length === 0) {
      console.log('nenhuma partida live no listing agora — rode durante uma partida');
      return;
    }
    url = live[0].matchPageUrl;
    console.log(`usando: ${url}`);
  }
  const probe = await probePage(url);
  console.log(JSON.stringify({ ...probe, url }, null, 2));
  const temTimer = probe.timerLike.length > 0 || probe.clockTexts.length > 0;
  console.log(`timer do round no placar: ${probe.roundTimerText ?? '(ausente)'}`);
  console.log(
    temTimer
      ? '\nRESULTADO: há indício de timer no DOM do HLTV (vale investigar como usar)'
      : '\nRESULTADO: nenhum timer/clock no DOM — o relógio do jogo continua vindo do placar',
  );
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser().catch(() => undefined);
  });

