import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import type { AceEvent } from '../src/types.js';
import { buildVideoMetadata } from '../src/uploader/videoMetadata.js';
import { createMetadataAi } from '../src/uploader/metadataAi.js';
import { killVideoOffsetMs } from '../src/clipper/clipAnchors.js';
import { resolveStreamLatencyMs } from '../src/monitor/streamLatency.js';

interface Args {
  ai: boolean;
  json: boolean;
  count: number;
  player?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ai: false, json: false, count: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ai') args.ai = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--n') args.count = Number(argv[++i]) || args.count;
    else if (arg.startsWith('--n=')) args.count = Number(arg.slice(4)) || args.count;
    else if (arg === '--player') args.player = argv[++i];
    else if (arg.startsWith('--player=')) args.player = arg.slice(9);
  }
  return args;
}

function collectSidecars(clipsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name.endsWith('_muxed.json')) continue;
      out.push(full);
    }
  };
  walk(clipsDir);
  return out;
}

interface LoadedAce {
  ace: AceEvent;
  clipStartMs?: number;
  clipDurationSec?: number;
}

function loadAces(
  clipsDir: string,
  player: string | undefined,
  contextSec: number,
  latencyMs: number,
  byStream: Record<string, number>,
): LoadedAce[] {
  const files = collectSidecars(clipsDir);
  const withTime = files.map((file) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    return { file, mtime };
  });
  withTime.sort((a, b) => b.mtime - a.mtime);
  const out: LoadedAce[] = [];
  for (const { file } of withTime) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AceEvent;
      if (!raw.player || !raw.kills?.length) continue;
      if (player && raw.player.toLowerCase() !== player.toLowerCase()) continue;
      // Sidecar novo traz o início exato do clipe; o antigo é estimado
      // (1ª kill menos o contexto padrão, como o corte faz) — e a
      // estimativa precisa da MESMA conversão do bot: o `startedAt` está
      // no relógio do placar e o clipe vive na timeline do vídeo gravado
      // (latência da stream).
      const startedAtMs = raw.startedAt ? Date.parse(raw.startedAt) : undefined;
      // Latência do canal: o sidecar novo grava a latência USADA
      // (streamLatencyMs) e o stream; o antigo cai na global.
      const sidecarLatency =
        typeof (raw as { streamLatencyMs?: number }).streamLatencyMs === 'number'
          ? (raw as { streamLatencyMs?: number }).streamLatencyMs as number
          : resolveStreamLatencyMs(
              latencyMs,
              byStream,
              (raw as { streamName?: string }).streamName,
            );
      const clipStartMs =
        typeof raw.clipStartMs === 'number'
          ? raw.clipStartMs
          : startedAtMs != null
            ? startedAtMs + sidecarLatency - contextSec * 1000
            : undefined;
      out.push({ ace: raw, clipStartMs, clipDurationSec: raw.clipDurationSec });
    } catch {
      continue;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  // Latência da stream: a mesma conversão do bot (placar → vídeo).
  const latencyMs = cfg.CLIP_STREAM_LATENCY_MS;
  const aces = loadAces(
    cfg.CLIPS_DIR,
    args.player,
    cfg.CLIP_CONTEXT_SEC,
    latencyMs,
    cfg.CLIP_STREAM_LATENCY_BY_STREAM,
  ).slice(0, args.count);
  if (aces.length === 0) {
    console.log('Nenhum sidecar encontrado em ' + cfg.CLIPS_DIR);
    return;
  }
  const ai = args.ai
    ? createMetadataAi({
        order: cfg.YT_META_AI_ORDER,
        timeoutMs: cfg.YT_META_AI_TIMEOUT_MS,
        geminiApiKey: cfg.GEMINI_API_KEY || undefined,
        geminiModel: cfg.YT_META_GEMINI_MODEL,
        hfToken: cfg.HF_TOKEN || undefined,
        hfModel: cfg.YT_META_HF_MODEL,
      })
    : undefined;
  const results: Array<Record<string, unknown>> = [];
  for (const { ace, clipStartMs, clipDurationSec } of aces) {
    const meta = await buildVideoMetadata(ace, {
      mode: args.ai ? 'ai' : 'template',
      ai,
      brand: cfg.YT_BRAND,
      cta: cfg.YT_DESC_CTA,
      privacy: cfg.YT_PRIVACY,
      defaultTags: cfg.YT_DEFAULT_TAGS,
      clipStartMs,
      clipDurationSec,
      // O `at` da kill é o instante da observação no placar; no vídeo o
      // kill aparece (latência da stream − atraso do placar) depois. O
      // sidecar novo traz o offset usado na publicação.
      killTimeOffsetMs:
        typeof (ace as { killVideoOffsetMs?: number }).killVideoOffsetMs === 'number'
          ? (ace as { killVideoOffsetMs?: number }).killVideoOffsetMs as number
          : killVideoOffsetMs(latencyMs, cfg.SCOREBOARD_DELAY_MS),
    });
    results.push({
      jogador: ace.player,
      mapa: ace.map,
      round: ace.round,
      evento: ace.event,
      fonte: meta.source,
      provider: meta.provider,
      motivo: meta.reason,
      titulo: meta.title,
      tags: meta.tags,
      descricao: meta.description,
    });
    if (args.json) continue;
    console.log(
      `\n=== ${ace.player} — ${ace.map} R${ace.round} (${ace.event}) [${meta.source}${
        meta.provider ? ':' + meta.provider : ''
      }] ===`,
    );
    console.log(`TITULO: ${meta.title}`);
    console.log(`TAGS: ${meta.tags.join(', ')}`);
    console.log('---');
    console.log(meta.description);
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('FALHOU: ' + String((e as Error).message).slice(0, 400));
  process.exit(1);
});
