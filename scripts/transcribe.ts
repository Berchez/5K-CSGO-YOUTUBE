/**
 * Transcreve um clipe e grava a legenda (SRT/VTT/TXT).
 *
 * Uso:
 *   npx tsx scripts/transcribe.ts data/clips/<pasta>/<pasta>.mp4
 *   npx tsx scripts/transcribe.ts <video> --provider whisper-cpp --model small --format srt
 *   npx tsx scripts/transcribe.ts --list
 *
 * Flags:
 *   --provider <id>    faster-whisper|whisper-cpp|vosk|gemini|openai|groq|
 *                      deepgram|assemblyai|elevenlabs
 *   --model <id>       modelo do provider (vazio = padrão)
 *   --language <code>  auto (padrão), pt, en...
 *   --no-vad           desliga o VAD (providers locais)
 *   --format <fmt>     srt (padrão)|vtt|txt
 *   --out <arquivo>    caminho da legenda (padrão: troca a extensão do vídeo)
 *   --list             mostra providers, modelos, custo e o que está pronto
 */
import { getConfig } from '../src/config.js';
import { PROVIDERS, estimateCostUsd, requireProviderInfo, isProviderId } from '../src/transcription/registry.js';
import { providerStatus, transcribeToFile } from '../src/transcription/transcribe.js';
import type { TranscriptFormat } from '../src/transcription/types.js';

interface Args {
  video: string;
  provider?: string;
  model?: string;
  language?: string;
  vad?: boolean;
  format?: TranscriptFormat;
  outPath?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { video: '', list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      args.list = true;
    } else if (arg === '--no-vad') {
      args.vad = false;
    } else if (arg === '--provider') {
      args.provider = argv[++i];
    } else if (arg === '--model') {
      args.model = argv[++i];
    } else if (arg === '--language') {
      args.language = argv[++i];
    } else if (arg === '--format') {
      args.format = argv[++i] as TranscriptFormat;
    } else if (arg === '--out') {
      args.outPath = argv[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`flag desconhecida: ${arg}`);
    } else if (!args.video) {
      args.video = arg;
    } else {
      throw new Error(`argumento extra: ${arg}`);
    }
  }
  if (args.format && !['srt', 'vtt', 'txt'].includes(args.format)) {
    throw new Error(`formato inválido: ${args.format} (use srt, vtt ou txt)`);
  }
  if (args.provider && !isProviderId(args.provider)) {
    throw new Error(`provider inválido: ${args.provider}`);
  }
  return args;
}

function printList(): void {
  const status = new Map(providerStatus().map((s) => [s.id, s]));
  for (const provider of PROVIDERS) {
    const state = status.get(provider.id);
    const mark = state?.ready ? 'PRONTO' : `REQUER SETUP — ${state?.reason ?? ''}`;
    console.log(`\n${provider.id} (${provider.kind}) — ${mark}`);
    console.log(`  ${provider.speedNote}`);
    for (const model of provider.models) {
      const speed =
        model.measuredWallSecPerAudioMin != null
          ? `${model.measuredWallSecPerAudioMin} s/min (medido)`
          : model.estimatedWallSecPerAudioMin != null
            ? `${model.estimatedWallSecPerAudioMin} s/min (estimado)`
            : 'velocidade não medida';
      const cost = model.costUsdPerHour === 0 ? 'grátis' : `US$ ${model.costUsdPerHour.toFixed(3)}/h`;
      console.log(
        `  - ${model.id}: ${cost}, ${speed}, ${model.timestamps ? 'com timestamps' : 'sem timestamps'}`,
      );
    }
    if (!state?.ready) console.log(`  setup: ${provider.notes}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }
  if (!args.video) {
    throw new Error(
      'informe o vídeo (ou use --list). Ex.: npx tsx scripts/transcribe.ts data/clips/<pasta>/<pasta>.mp4',
    );
  }
  const cfg = getConfig();
  const provider = args.provider ?? cfg.TRANSCRIPTION_PROVIDER;
  if (!isProviderId(provider)) throw new Error(`provider inválido: ${provider}`);
  const info = requireProviderInfo(provider);
  const status = providerStatus().find((item) => item.id === provider);
  if (status && !status.ready) {
    console.warn(`atenção: ${provider} — ${status.reason}`);
  }
  console.log(`transcrevendo ${args.video} com ${info.label}...`);
  const { result, outPath } = await transcribeToFile(args.video, {
    provider,
    model: args.model,
    language: args.language,
    vad: args.vad,
    format: args.format,
    outPath: args.outPath,
  });
  const cost = estimateCostUsd(result.provider, result.model, result.audioSec);
  console.log(
    [
      `provider: ${result.provider} (${result.model})`,
      `idioma: ${result.language ?? '?'} · duração: ${result.audioSec.toFixed(2)}s`,
      `tempo: ${(result.elapsedMs / 1000).toFixed(1)}s · segmentos: ${result.segments.length}`,
      `custo estimado: ${cost === 0 ? 'grátis' : `US$ ${cost.toFixed(4)}`}`,
      `legenda: ${outPath}`,
    ].join('\n'),
  );
  if (result.segments.length === 0) {
    console.warn('nenhuma fala detectada — a legenda saiu vazia.');
  }
}

main().catch((e: unknown) => {
  console.error(`erro: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
