/**
 * Worker ISOLADO do recorte do jogador (background removal).
 *
 * O @imgly/background-removal-node traz um sharp antigo (libvips 8.14) e
 * ele CRASHA o processo (access violation) se o sharp do repo (libvips
 * 8.16) já estiver carregado. Por isso o recorte roda aqui, num processo
 * separado: se o native explodir, o bot continua vivo e cai no retrato
 * emoldurado.
 *
 * Uso: node thumbCutoutWorker.js <entrada.jpg> <saida.png>
 *      (o .ts roda com --import tsx; o node puro só entende .ts a
 *      partir da 22.18)
 *
 * Este arquivo NÃO importa nada relativo (roda como .ts no tsx e .js no
 * dist) e usa o logger do console — é um one-off, não parte do bot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, output] = process.argv.slice(2);

/**
 * O worker só faz coisa quando é o programa principal: importado por
 * engano (ou por um teste) ele NÃO pode sair com código 2 no meio do
 * processo que o importou.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * O ONNX usa TODOS os cores por padrão: a máquina que grava a live
 * perde segmento quando a CPU satura (o ffmpeg do recorder já usa
 * `cpus-2`). O recorte é uma tarefa de fundo — ela roda com prioridade
 * baixa para não competir com a gravação.
 */
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // sem privilégio (ou sem suporte): o recorte segue no priorité normal
}

function mimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function main(): Promise<void> {
  if (!input || !output) {
    console.error('uso: thumbCutoutWorker <entrada> <saida.png>');
    process.exit(2);
  }
  // Specifier dinâmico: a dependência é OPCIONAL (pode não estar instalada).
  const spec = '@imgly/background-removal-node';
  const mod = (await import(spec)) as {
    removeBackground?: (
      image: Blob,
      config?: { output?: { format?: string; quality?: number; type?: string } },
    ) => Promise<Blob>;
  };
  if (typeof mod.removeBackground !== 'function') throw new Error('removeBackground ausente');
  const bytes = fs.readFileSync(input);
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeOf(input) });
  const result = await mod.removeBackground(blob, {
    output: { format: 'image/png', quality: 0.9, type: 'foreground' },
  });
  const out = Buffer.from(new Uint8Array(await result.arrayBuffer()));
  if (out.length < 1_000) throw new Error(`recorte vazio (${out.length}b)`);
  // Escrita ATÔMICA: um worker morto no meio deixaria um PNG pela
  // metade no cache — e o cache traria esse lixo para sempre.
  const tmp = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, output);
}

if (isMain()) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(String(e).slice(0, 300));
      process.exit(1);
    },
  );
}