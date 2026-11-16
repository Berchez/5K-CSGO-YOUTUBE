/**
 * Backfill: completa (ou CORRIGE) as kills de um clipe já gravado com o
 * detalhe do killfeed do scorebot.
 *
 * POR QUE: o placar do DOM só conta K/D. O placar "vê" a vítima pela
 * coluna de mortes — e, quando OUTRO jogador mata no mesmo round, a
 * ordem das mortes não é a ordem das kills do autor: o placar acaba
 * pareando a vítima ERRADA (o caso real: kyousuke no Anubis r13 matou
 * HeavyGod, mas o sidecar dizia TeSeS — o HeavyGod tinha matado o TeSeS
 * um instante antes). Além disso, arma/headshot/assistência só existem
 * no killfeed.
 *
 * O script é um BACKFILL: ele lê o sidecar, busca o log do scorebot da
 * partida, casa mapa/round/jogador e reescreve `kills`, `stats` e o
 * bloco `killfeed` do sidecar.
 *
 * POR PADRÃO é DRY-RUN (mostra o que mudaria, sem escrever). Só grava
 * com `--apply`.
 *
 * Uso:
 *   npx tsx scripts/enrich-clip.ts --clip data/clips/2400205_Anubis_r13_kyousuke
 *   npx tsx scripts/enrich-clip.ts --clip <pasta> --apply
 *   npx tsx scripts/enrich-clip.ts --log C:/tmp/log-2400205.json --clip <pasta> --apply
 *
 * Flags:
 *   --clip <pasta>   processa só essa pasta de clipe (repetível)
 *   --last <n>       processa os n clipes mais recentes
 *   --all            processa todos os clipes com sidecar
 *   --apply          grava as mudanças (sem isso é dry-run)
 *   --log <arquivo>  usa um log do scorebot SALVO (sem rede)
 *   --match <id>     força o id da partida (a CLI manda sobre o sidecar)
 *   --match-url <u>  página da partida no HLTV (o scorebot é acessado
 *                    por ela: é a sessão que tem o clearance)
 *   --profile <dir>  perfil do Chrome do script (padrão: `HLTV_PROFILE`).
 *                    Use OUTRO diretório se o bot estiver rodando: o
 *                    Chromium não abre dois processos no mesmo perfil.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import {
  applyKillfeedToSidecar,
  readClipSidecar,
  readShortMarker,
  writeClipSidecar,
  writeShortMarker,
  type ClipSidecarV2,
} from '../src/clipper/sidecar.js';
import {
  enrichKillsWithFeed,
  selectFeedKills,
  type EnrichableKill,
} from '../src/detector/killfeedEnrich.js';
import {
  normalizeMapName,
  parseScorebotLog,
  type ScorebotKill,
} from '../src/detector/scorebotLog.js';

interface Args {
  clips: string[];
  last: number | null;
  all: boolean;
  apply: boolean;
  logFile: string | null;
  matchId: string | null;
  matchUrl: string | null;
  profile: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    clips: [],
    last: null,
    all: false,
    apply: false,
    logFile: null,
    matchId: null,
    matchUrl: null,
    profile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} precisa de um valor`);
      return value;
    };
    if (arg === '--clip') args.clips.push(next());
    else if (arg === '--last') args.last = Number(next());
    else if (arg === '--all') args.all = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--log') args.logFile = path.resolve(next());
    else if (arg === '--match') args.matchId = next();
    else if (arg === '--match-url') args.matchUrl = next();
    else if (arg === '--profile') args.profile = path.resolve(next());
    else throw new Error(`flag desconhecida: ${arg}`);
  }
  return args;
}

interface Candidate {
  dir: string;
  name: string;
  sidecarPath: string;
  side: ClipSidecarV2;
}

/** Lê o sidecar de uma pasta de clipe (v1 ou v2). */
function readCandidate(dir: string): Candidate | null {
  const name = path.basename(dir);
  const candidates = [
    path.join(dir, `${name}.json`),
    path.join(dir, `${name}_muxed.json`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const side = readClipSidecar(file);
    if (!side) continue;
    return { dir, name, sidecarPath: file, side };
  }
  return null;
}

/**
 * Instante do clipe (ms): `createdAt` do sidecar ou mtime do arquivo.
 *
 * Antes de 2000 = o sidecar NÃO tem data real (o normalizador usa
 * `new Date(0)`): a data de 1970 é "válida" e invertia a ordenação do
 * `--last N`.
 */
function candidateTime(candidate: Candidate): number {
  const created = candidate.side.createdAt ? Date.parse(String(candidate.side.createdAt)) : NaN;
  if (Number.isFinite(created) && created >= Date.UTC(2000, 0, 1)) return created;
  try {
    return fs.statSync(candidate.sidecarPath).mtimeMs;
  } catch {
    return 0;
  }
}

function discover(clipsDir: string, args: Args): Candidate[] {
  const dirs = args.clips.length
    ? args.clips.map((d) => path.resolve(d))
    : fs.existsSync(clipsDir)
      ? fs
          .readdirSync(clipsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => path.join(path.resolve(clipsDir), d.name))
      : [];
  const out: Candidate[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const found = readCandidate(dir);
    if (found) out.push(found);
  }
  out.sort((a, b) => candidateTime(b) - candidateTime(a));
  if (args.last != null && Number.isFinite(args.last) && args.last > 0) {
    return out.slice(0, Math.floor(args.last));
  }
  return out;
}

/** O log do scorebot de um arquivo local (sem rede). */
function loadLogFile(file: string): ScorebotKill[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Aceita o array cru (`items`) ou o embrulhado `{ items: [...] }`.
  const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.log ?? []);
  if (!Array.isArray(items)) throw new Error(`${file}: não achei a lista de eventos`);
  // O arquivo é o replay do scorebot: vem do mais novo para o mais
  // antigo (o parser inverte, como em produção).
  return parseScorebotLog(items, { reverse: true, replay: true });
}

/** As kills do sidecar no formato do enriquecimento. */
function sideKills(side: ClipSidecarV2): EnrichableKill[] {
  return side.kills.map((kill) => ({
    killer: kill.killer,
    victim: kill.victim,
    weapon: kill.weapon ?? null,
    headshot: kill.headshot ?? null,
    assistBy: kill.assistBy ?? null,
    flashAssistBy: kill.flashAssistBy ?? null,
    throughSmoke: kill.throughSmoke ?? null,
    wallbang: kill.wallbang ?? null,
    noscope: kill.noscope ?? null,
  }));
}

/**
 * Campos que o TÍTULO/descrição do Short descrevem: quando um deles
 * muda, o texto revisado pelo dono fica velho e precisa ser refeito.
 */
const META_FIELDS = new Set(['victim', 'weapon', 'headshot']);

/**
 * Invalida os METADADOS do marker do Short de um clipe.
 *
 * O título/descrição do Short são reaproveitados do dry-run (o dono viu
 * aquele texto). Depois do enrich, a vítima/headshot podem ter mudado:
 * o título antigo ("5K contra HeavyGod") passaria a mentir — o marker
 * perde só os metadados (o resto do vertical continua valendo).
 */
function invalidateShortMetadata(shortsDir: string, name: string): void {
  const markerPath = path.join(
    path.resolve(shortsDir),
    name,
    `${name}_short.json`,
  );
  if (!fs.existsSync(markerPath)) return;
  try {
    const marker = readShortMarker(markerPath);
    if (!marker || !marker.metadata) return;
    marker.metadata = null;
    writeShortMarker(markerPath, marker);
    console.log(`  ✓ metadados do Short invalidados: ${markerPath}`);
  } catch (e) {
    console.log(`  (não deu para invalidar o marker do Short: ${String(e).slice(0, 120)})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  if (!args.clips.length && args.last == null && !args.all) {
    throw new Error('informe --clip <pasta>, --last <n> ou --all');
  }
  const clipsDir = path.resolve(cfg.CLIPS_DIR);
  const candidates = discover(clipsDir, args);
  if (candidates.length === 0) {
    console.log('nenhum clipe com sidecar encontrado');
    return;
  }
  console.log(
    `${candidates.length} clipe(s) selecionado(s) — ${args.apply ? 'VAI GRAVAR' : 'dry-run (nada é gravado)'}`,
  );

  // O log local é o mesmo para todos os clipes.
  const localKills = args.logFile ? loadLogFile(args.logFile) : null;
  if (localKills) {
    console.log(`log local: ${args.logFile} (${localKills.length} kill(s))`);
  }

  // O replay da rede é buscado uma vez por partida.
  const networkCache = new Map<string, ScorebotKill[]>();
  let page: import('playwright').Page | null = null;
  let context: import('playwright').BrowserContext | null = null;
  const closeBrowser = async (): Promise<void> => {
    if (page) {
      try {
        await page.close();
      } catch {
        // best-effort
      }
      page = null;
    }
    if (context) {
      try {
        await context.close();
      } catch {
        // best-effort
      }
      context = null;
    }
  };

  const feedFor = async (matchId: string): Promise<ScorebotKill[] | null> => {
    if (localKills) return localKills;
    const cached = networkCache.get(matchId);
    if (cached) return cached;
    if (!page) {
      /**
       * Browser PRÓPRIO do script (não o do bot): o `newTrackedPage` do
       * monitor abre o MESMO perfil do pm2 — o Chromium não abre dois
       * processos no mesmo user-data-dir (lock) e o script morria.
       * Use `--profile <outro dir>` para não disputar o perfil do bot.
       */
      const { launchStealthContext } = await import('../src/clipper/stealthBrowser.js');
      const headless = cfg.HLTV_HEADLESS;
      context = await launchStealthContext({
        profileDir: args.profile ?? cfg.HLTV_PROFILE,
        headless,
        extraArgs: headless ? [] : ['--start-minimized'],
        minimize: !headless,
        ignoreDefaultArgs: ['--disable-popup-blocking'],
      });
      // Shim do `__name` (o tsx injeta o helper nas funções nomeadas e a
      // página não tem esse helper).
      await context.addInitScript({
        content: 'globalThis.__name = globalThis.__name || ((f) => f);',
      });
      page = await context.newPage();
      // O scorebot é acessado por dentro da página do HLTV (o Cloudflare
      // barra o Node direto). A página precisa do clearance: espera ele.
      const url = args.matchUrl ?? 'https://www.hltv.org/';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const { waitForClearance } = await import('../src/monitor/hltvMonitor.js');
      const cleared = await waitForClearance(page, 45_000);
      if (!cleared) {
        console.log('  (página do HLTV ainda bloqueada pelo Cloudflare)');
      }
    }
    const { fetchScorebotReplay } = await import('../src/detector/scorebotFeed.js');
    const kills = await fetchScorebotReplay(page, matchId);
    networkCache.set(matchId, kills);
    return kills;
  };

  let changed = 0;
  try {
    for (const candidate of candidates) {
      const side = candidate.side;
      const matchId = args.matchId ?? side.match.id;
      const map = normalizeMapName(side.round.map);
      const round = side.round.number;
      const player = side.player.name;
      console.log(`\n== ${candidate.name} ==`);
      console.log(`  partida ${matchId} | ${side.round.map} r${round} | ${player}`);

      let feed: ScorebotKill[] | null = null;
      try {
        feed = await feedFor(matchId);
      } catch (e) {
        console.log(`  (killfeed indisponível: ${String(e).slice(0, 160)})`);
        continue;
      }
      if (!feed) continue;

      const feedKills = selectFeedKills({ kills: feed, map, round, player });
      if (feedKills.length === 0) {
        console.log('  (nenhuma kill do scorebot para esse mapa/round/jogador)');
        continue;
      }
      console.log(`  killfeed: ${feedKills.length} kill(s) do scorebot`);

      const before = sideKills(side);
      const result = enrichKillsWithFeed(before, feedKills);
      if (result.changes.length === 0) {
        console.log('  (nada a corrigir — o sidecar já está completo)');
        continue;
      }
      for (const change of result.changes) {
        console.log(
          `  kill ${change.index + 1} (${change.killer}): ${change.field} ${change.from ?? '(vazio)'} → ${change.to ?? '(vazio)'}`,
        );
      }
      changed += 1;

      if (!args.apply) continue;

      const updated = applyKillfeedToSidecar(
        side,
        {
          kills: result.kills,
          paired: result.paired,
          feedKills: result.feedKills,
          eventIds: result.eventIds,
        },
        new Date().toISOString(),
      );
      try {
        // Escrita COM backup (v1 → v2) e atômica: o enrich converte
        // sidecars antigos e, sem a cópia `.v1.bak`, o v1 (com
        // `roundKills`, `vod.videoId`...) sumia para sempre.
        writeClipSidecar(candidate.sidecarPath, updated);
        console.log(`  ✓ sidecar atualizado: ${candidate.sidecarPath}`);
        // O título/descrição do Short só é invalidado quando o dado que
        // ELE DESCREVE mudou (vítima, arma ou headshot): uma mudança só
        // de assistência não invalida o texto revisado pelo dono.
        if (result.changes.some((c) => META_FIELDS.has(c.field))) {
          invalidateShortMetadata(cfg.SHORTS_DIR, candidate.name);
        }
      } catch (e) {
        console.log(`  ✗ falha ao gravar o sidecar: ${String(e).slice(0, 160)}`);
      }
    }
  } finally {
    await closeBrowser();
  }

  console.log(
    `\n${changed} clipe(s) com correção${args.apply ? ' gravada(s)' : ' (dry-run: grave com --apply)'}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
