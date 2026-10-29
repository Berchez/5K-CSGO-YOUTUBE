/**
 * Probe: a playlist HLS da stream traz PROGRAM-DATE-TIME?
 *
 * Se a playlist tiver `#EXT-X-PROGRAM-DATE-TIME`, o instante de origem
 * de cada segmento é conhecido sem OCR — e a latência da stream pode
 * ser medida direto do metadata (o mtime local só diz QUANDO o
 * arquivo foi escrito aqui, não quando o conteúdo foi produzido).
 *
 * O Twitch normalmente não publica PDT; o YouTube costuma publicar.
 * Este probe resolve a URL do formato combinado (o mesmo do recorder)
 * e olha a playlist.
 *
 * Uso:
 *   npx tsx scripts/probe-hls-pdt.ts <urlDaStream>
 *   npx tsx scripts/probe-hls-pdt.ts            (usa a 1ª partida live do listing)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { fetchMatchListing, fetchMatchStreams } from '../src/monitor/hltvMonitor.js';
import { closeBrowser } from '../src/monitor/hltvMonitor.js';
import {
  describePlaylist,
  findTimelineShifts,
  parseHlsPlaylist,
} from '../src/recorder/hlsTimeline.js';

const execFileAsync = promisify(execFile);

function resolveBin(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const vendored = path.resolve('.tools', exe);
  if (fs.existsSync(vendored)) return vendored;
  return name;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  let streamUrl = process.argv[2];
  if (!streamUrl) {
    console.log('procurando uma partida live com stream...');
    const listing = await fetchMatchListing(cfg.HLTV_MATCHES_URL, cfg.MIN_STARS, cfg.TOP_TIER_ONLY, {
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
      console.log('nenhuma partida live agora — rode durante uma partida');
      return;
    }
    const streams = await fetchMatchStreams(live[0].matchPageUrl);
    if (!streams || streams.length === 0) {
      console.log('partida live sem stream disponível');
      return;
    }
    streamUrl = streams[0].url;
    console.log(`usando: ${streamUrl}`);
  }

  const ytdlp = resolveBin('yt-dlp');
  let hlsUrl = '';
  try {
    const { stdout } = await execFileAsync(
      ytdlp,
      ['--no-playlist', '--no-warnings', '-g', '-f', cfg.CAPTURE_FORMAT, streamUrl],
      { timeout: 60_000, windowsHide: true },
    );
    hlsUrl = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
  } catch (e) {
    console.log(`yt-dlp falhou: ${String(e).slice(0, 200)}`);
    return;
  }
  if (!hlsUrl) {
    console.log('yt-dlp não resolveu a URL do formato combinado');
    return;
  }
  console.log(`HLS: ${hlsUrl.slice(0, 120)}...`);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(hlsUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    const pdt = text.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
    const segments = (text.match(/#EXTINF/g) ?? []).length;
    const discontinuities = (text.match(/#EXT-X-DISCONTINUITY/g) ?? []).length;
    console.log(`segmentos: ${segments} | descontinuidades: ${discontinuities}`);
    if (pdt) {
      console.log(`PROGRAM-DATE-TIME: ${pdt[1].trim()}`);
      const primeira = Date.parse(pdt[1].trim());
      const ultima = [...text.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(.+)/g)].at(-1)?.[1]?.trim() ?? '';
      console.log(
        `intervalo de origem: ${new Date(primeira).toISOString()} .. ${ultima ? new Date(Date.parse(ultima)).toISOString() : '?'}`,
      );
      // O que o recorder vai fazer com essa playlist:
      const resumo = describePlaylist(text);
      const parsed = parseHlsPlaylist(text);
      const shifts = findTimelineShifts(parsed, cfg.SEGMENT_TIME_SEC);
      console.log(
        `resumo: ${resumo.segmentos} segmentos, ${resumo.comPdt} com PDT, ${resumo.descontinuidades} descontinuidades`,
      );
      console.log(
        shifts.length === 0
          ? 'saltos de atraso na timeline de origem: nenhum (rel�gio da origem acompanha o conte�do)'
          : `saltos de atraso na timeline de origem: ${shifts
              .map((shift) => `${shift.shiftSec}s em ${new Date(shift.atPdtMs).toISOString()}`)
              .join(', ')}`,
      );
      console.log('\nRESULTADO: a playlist traz PDT � d� para medir a lat�ncia sem OCR.');
    } else {
      console.log('\nRESULTADO: a playlist N�O traz PROGRAM-DATE-TIME (lat�ncia tem que vir do OCR).');
    }
  } catch (e) {
    console.log(`falha ao ler a playlist: ${String(e).slice(0, 200)}`);
  }
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser().catch(() => undefined);
  });

