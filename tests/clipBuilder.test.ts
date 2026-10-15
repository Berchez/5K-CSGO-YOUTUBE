import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDurationCap, buildClip, computeAceEndMs, computeAudioCompensation, computeTrimEndSec, computeTrimStartSec, contiguousTail, correlateOffset, measureAvOffset, newestSegmentEndMs, pickSegments, probeConcatSpan, resolveFfmpegBin, resolveFfprobeBin, sanitizeSegments, verifySegmentAv } from '../src/clipper/clipBuilder.js';

// Bin vendored em .tools/ ou PATH — não assume Windows. Sem ffmpeg
// executável os e2es pulam (CI Linux sem os bins não falha).
const FF = resolveFfmpegBin();
const ffmpegOk = (() => {
  try {
    execFileSync(FF, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Cria N arquivos com mtimes espaçados de stepSec (mais novo por último)
function makeSegments(dir: string, n: number, stepMs: number, newestMs: number): string[] {
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `seg_${String(i).padStart(3, '0')}.mp4`);
    fs.writeFileSync(f, 'x'.repeat(1000));
    const mtime = new Date(newestMs - (n - 1 - i) * stepMs);
    fs.utimesSync(f, mtime, mtime);
    files.push(f);
  }
  return files;
}

describe('pickSegments', () => {
  it('sem aceStartMs: últimos N por pre+post', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const segs = makeSegments(dir, 18, 10_000, Date.now());
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
      });
      expect(picked).toHaveLength(9); // ceil(75/10)+1
      expect(picked[picked.length - 1]).toBe(segs[segs.length - 1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('com aceStartMs: corta 10s antes do 1º kill', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 18, 10_000, now);
      // 1º kill aconteceu no instante do segmento 12 (0-indexed)
      const firstKillMs = now - (18 - 1 - 12) * 10_000;
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        contextSec: 10,
        aceStartMs: firstKillMs,
      });
      // cutFrom = seg12 - 10s = fim do seg11 → pega do seg11 em diante (7 segs)
      expect(picked[0]).toBe(segs[11]);
      expect(picked).toHaveLength(7);
      expect(picked[picked.length - 1]).toBe(segs[17]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ace mais velho que o buffer: usa tudo + avisa no tamanho', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const segs = makeSegments(dir, 5, 10_000, Date.now());
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        aceStartMs: Date.now() - 3_600_000,
      });
      expect(picked).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lista vazia retorna vazio', () => {
    expect(
      pickSegments([], { segmentTimeSec: 10, preRollSec: 60, postRollSec: 15 }),
    ).toEqual([]);
  });

  it('com aceEndMs: descarta o que começa depois do fim (trim corta o resto)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 18, 10_000, now);
      const firstKillMs = now - (18 - 1 - 12) * 10_000; // instante do seg12
      const endMs = now - 31_000; // dentro do seg14 (span now-40s..now-30s)
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        contextSec: 10,
        aceStartMs: firstKillMs,
        aceEndMs: endMs,
      });
      // início: do seg11 em diante; fim: seg15 começa em now-20s > end+1s
      expect(picked[0]).toBe(segs[11]);
      expect(picked[picked.length - 1]).toBe(segs[14]);
      expect(picked).toHaveLength(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aceEndMs antes do buffer: fallback usa tudo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 5, 10_000, now);
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        aceStartMs: now - 60_000,
        aceEndMs: now - 120_000, // mais velho que o segmento mais antigo
      });
      expect(picked).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem aceStartMs mas com aceEndMs: corta a cauda pelo fim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 18, 10_000, now);
      const picked = pickSegments(segs, {
        segmentTimeSec: 10,
        preRollSec: 60,
        postRollSec: 15,
        aceEndMs: now - 50_000,
      });
      // últimos 9 (60+15s) cortados pelo fim: seg com start < now-49s
      expect(picked[picked.length - 1]).toBe(segs[13]);
      expect(picked).not.toContain(segs[17]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeTrimEndSec', () => {
  it('sem âncora retorna null (cauda atual)', () => {
    expect(computeTrimEndSec(0, 10, 10, undefined, 5)).toBeNull();
  });

  it('fim além da cauda retorna null', () => {
    // concat de 100s, trimStart 5s → len 95s; fim em 200s não corta nada
    expect(computeTrimEndSec(0, 10, 10, 200_000, 5)).toBeNull();
  });

  it('fim antes do começo retorna null (nunca clipe de 1s errado)', () => {
    expect(computeTrimEndSec(100_000, 10, 10, 50_000, 0)).toBeNull();
  });

  it('fim no meio: offset na timeline menos o trim do começo', () => {
    // clipe começa em 0, fim em 65s, trimStart 5s → 60s de duração
    expect(computeTrimEndSec(0, 10, 10, 65_000, 5)).toBe(60);
  });

  it('span medido substitui n×slot (segmento que nunca cortou)', () => {
    // 1 arquivo cobrindo 412s reais: legado diria len 10s; medido diz 412s
    expect(computeTrimEndSec(0, 1, 10, 65_000, 5, 412)).toBe(60);
    // fim além do span medido retorna null (cauda atual)
    expect(computeTrimEndSec(0, 1, 10, 500_000, 5, 412)).toBeNull();
  });
});

describe('computeAceEndMs (âncora de fim: 5s antes da próxima ação)', () => {
  it('detecção − lag do placar + afterClose', () => {
    // round fechou em T; placar mostrou em T+15s (lag 15, estimado 10)
    const T = 1_000_000_000;
    expect(computeAceEndMs(T + 15_000, 10_000, 8)).toBe(T + 13_000);
  });
  it('caso Alisson: fim ~58s após o início desejado, não 412s', () => {
    // startedAt real do sidecar 2399205_Dust2_r20_Alisson.json
    const aceStartMs = Date.parse('2026-10-15T01:12:10.009Z');
    const detectionMs = Date.parse('2026-10-15T01:13:00.114Z');
    const endMs = computeAceEndMs(detectionMs, 10_000, 8);
    // fim ≈ 48s após a 1ª kill (round de ~40s + 8s) — dentro do round
    expect(endMs - aceStartMs).toBe(48_105);
  });
});

describe('applyDurationCap (teto como alarme)', () => {
  it('dentro do cap: sem clamp', () => {
    expect(applyDurationCap(10, 60, 100, 105)).toEqual({ trimEndSec: 60, clamped: false });
    expect(applyDurationCap(10, null, 100, 105)).toEqual({ trimEndSec: null, clamped: false });
  });
  it('estouro: força o corte e sinaliza', () => {
    // caso Alisson sem span: concat inteiro (null) de 412s → corta em 115s
    expect(applyDurationCap(10, null, 412, 105)).toEqual({ trimEndSec: 115, clamped: true });
    expect(applyDurationCap(10, 500, 412, 105)).toEqual({ trimEndSec: 115, clamped: true });
  });
});

describe('computeTrimStartSec (span medido)', () => {
  it('caso Alisson: 1 arquivo de 412s ancora certo com span medido', () => {
    const D = Date.parse('2026-10-15T01:13:00.114Z'); // detecção
    const aceStartMs = Date.parse('2026-10-15T01:12:10.009Z');
    const fileMtimeMs = D + 30_000; // snapshot ~30s após detecção
    const spanSec = 412;
    const realStartMs = fileMtimeMs - spanSec * 1000;
    // desejado = 1ª kill − 10s ctx → ~322s dentro do arquivo
    const trim = computeTrimStartSec(fileMtimeMs, 10, aceStartMs, 10, realStartMs);
    expect(trim).toBeCloseTo(322, 0);
    const endMs = computeAceEndMs(D, 10_000, 8);
    const trimEnd = computeTrimEndSec(realStartMs, 1, 10, endMs, trim, spanSec);
    // janela ≈ 58s (fim − início), nunca os 412s do arquivo
    expect(trimEnd).toBeCloseTo(58, 0);
    const capped = applyDurationCap(trim, trimEnd, spanSec, 105);
    expect(capped.clamped).toBe(false);
  });
  it('mesmo caso SEM span (legado): fallback null (arquivo inteiro)', () => {
    const D = Date.parse('2026-10-15T01:13:00.114Z');
    const aceStartMs = Date.parse('2026-10-15T01:12:10.009Z');
    const fileMtimeMs = D + 30_000;
    const trim = computeTrimStartSec(fileMtimeMs, 10, aceStartMs, 10);
    expect(trim).toBe(0);
    const endMs = computeAceEndMs(D, 10_000, 8);
    // fim (D−2s) antes do "início" assumido (mtime−10s = D+20s) → null
    expect(computeTrimEndSec(fileMtimeMs - 10_000, 1, 10, endMs, trim)).toBeNull();
  });
});

describe('newestSegmentEndMs', () => {
  it('retorna o maior mtime (fim do buffer)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newest-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 5, 10_000, now);
      expect(newestSegmentEndMs(segs)).toBe(now);
      expect(newestSegmentEndMs([])).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('contiguousTail', () => {
  function mkTimes(dir: string, spec: Array<{ name: string; atSec: number }>): string[] {
    const files: string[] = [];
    for (const s of spec) {
      const f = path.join(dir, s.name);
      fs.writeFileSync(f, 'x');
      const d = new Date(1_000_000 + s.atSec * 1000);
      fs.utimesSync(f, d, d);
      files.push(f);
    }
    return files;
  }

  it('REGRESSÃO r23: intercalação de fantasma (005 furando) vira cauda contígua', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    try {
      // sidecar real do 2399459_Ancient_r23_Reix: 005 antigo no meio dos novos
      const files = mkTimes(dir, [
        { name: 'seg_005.ts', atSec: 10 },
        { name: 'seg_016.ts', atSec: 120 },
        { name: 'seg_017.ts', atSec: 130 },
        { name: 'seg_000.ts', atSec: 140 },
        { name: 'seg_001.ts', atSec: 150 },
        { name: 'seg_002.ts', atSec: 160 },
        { name: 'seg_003.ts', atSec: 170 },
      ]);
      const r = contiguousTail(files, 25);
      expect(r.ok.map((f) => path.basename(f))).toEqual([
        'seg_016.ts', 'seg_017.ts', 'seg_000.ts', 'seg_001.ts', 'seg_002.ts', 'seg_003.ts',
      ]);
      expect(r.dropped.map((f) => path.basename(f))).toEqual(['seg_005.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buffer saudável (gaps ~10s) mantém tudo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail2-'));
    try {
      const files = mkTimes(dir, [
        { name: 'seg_a.ts', atSec: 0 },
        { name: 'seg_b.ts', atSec: 10 },
        { name: 'seg_c.ts', atSec: 20.5 },
        { name: 'seg_d.ts', atSec: 30 },
      ]);
      const r = contiguousTail(files, 25);
      expect(r.ok).toHaveLength(4);
      expect(r.dropped).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lista vazia/1 arquivo passa direto', () => {
    expect(contiguousTail([], 25).ok).toEqual([]);
    expect(contiguousTail(['x.ts'], 25).ok).toEqual(['x.ts']);
  });
});

describe('computeTrimStartSec', () => {
  const SEG_MS = 10_000;
  it('sem âncora não trimma', () => {
    expect(computeTrimStartSec(110_000, 10, undefined, 10)).toBe(0);
  });
  it('converte folga atômica em começo exato (âncora − contexto)', () => {
    // segmento 1: 100s→110s; kill ancorado em 115s, ctx 10s → desejado 105s
    expect(computeTrimStartSec(110_000, 10, 115_000, 10)).toBe(5);
    // kill em 118s → desejado 108s → trim 8s
    expect(computeTrimStartSec(110_000, 10, 118_000, 10)).toBe(8);
  });
  it('âncora antes do material: clamp em 0 (não corta conteúdo)', () => {
    expect(computeTrimStartSec(110_000, 10, 95_000, 10)).toBe(0);
  });
});

describe('computeAudioCompensation (compensação de skew)', () => {
  it('δ=0: sem pad, janela do vídeo', () => {
    const c = computeAudioCompensation(12.6, 55, 0, 120);
    expect(c.startSec).toBeCloseTo(12.6, 6);
    expect(c.endSec).toBeCloseTo(55, 6);
    expect(c.padSec).toBe(0);
    expect(c.clamped).toBe(false);
    expect(c.invalid).toBe(false);
  });
  it('áudio adiantado 5s: janela 5s mais cedo, mesma duração, sem pad', () => {
    const c = computeAudioCompensation(12.6, 55, 5, 120);
    expect(c.startSec).toBeCloseTo(7.6, 6);
    expect(c.endSec).toBeCloseTo(50, 6);
    expect(c.padSec).toBe(0);
    expect(c.outLenSec).toBeCloseTo(42.4, 6);
  });
  it('head fora do material (S<δ): começa em 0 + pad de silêncio', () => {
    const c = computeAudioCompensation(2, 50, 5, 120);
    expect(c.startSec).toBe(0);
    expect(c.padSec).toBeCloseTo(3, 6);
    expect(c.clamped).toBe(true);
    expect(c.outLenSec).toBeCloseTo(48, 6);
  });
  it('cauda além do material: tailShort com flag', () => {
    const c = computeAudioCompensation(12.6, 55, 5, 45);
    expect(c.endSec).toBeCloseTo(45, 6);
    expect(c.tailShort).toBe(true);
  });
  it('áudio atrasado: janela mais tarde', () => {
    const c = computeAudioCompensation(12.6, 55, -1.5, 120);
    expect(c.startSec).toBeCloseTo(14.1, 6);
    expect(c.endSec).toBeCloseTo(56.5, 6);
  });
  it('janela útil degenerada: invalid (não compensar)', () => {
    const c = computeAudioCompensation(0, 5, 8, 120);
    expect(c.invalid).toBe(true);
  });
});

describe('correlateOffset', () => {
  it('acha lag +2s com proeminência alta', () => {
    const hz = 10;
    const A = new Array(100).fill(0);
    const V = new Array(100).fill(0);
    A[20] = 10; // evento no áudio em t=2.0s...
    V[40] = 10; // ...e no vídeo em t=4.0s (áudio 2s adiantado)
    const { lagSec, prominence } = correlateOffset(A, V, hz, 10);
    expect(lagSec).toBeCloseTo(2.0, 6);
    expect(prominence).toBeGreaterThan(1.5);
  });
  it('sinais planos: sem medida (proeminência 0)', () => {
    const { prominence } = correlateOffset(new Array(50).fill(1), new Array(50).fill(1), 10, 5);
    expect(prominence).toBe(0);
  });
});

describe.skipIf(!ffmpegOk)('verifySegmentAv (diagnóstico de skew, sem decode)', () => {

  it('TS alinhado: sem issues', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avok-'));
    try {
      const f = path.join(dir, 'ok.ts');
      execFileSync(FF, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
        '-f', 'mpegts', f,
      ]);
      expect(await verifySegmentAv([f], 6)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('áudio 2s atrasado na abertura: acusa mismatch (caso do skew real)', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoff-'));
    try {
      const f = path.join(dir, 'off.ts');
      execFileSync(FF, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=30',
        '-itsoffset', '2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
        '-f', 'mpegts', f,
      ]);
      const issues = await verifySegmentAv([f], 6);
      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe('mismatch');
      expect(Math.abs(issues[0].startDeltaSec)).toBeGreaterThan(1.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!ffmpegOk)('probeConcatSpan (span real p/ ancorar trim)', () => {
  function makeTs(dir: string, name: string, offsetSec: number, durSec = 2): string {
    const f = path.join(dir, name);
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=duration=${durSec}:size=320x180:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durSec}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-output_ts_offset', String(offsetSec),
      '-f', 'mpegts', f,
    ]);
    return f;
  }

  it('arquivos contíguos: span ≈ soma, reliable', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'span-'));
    try {
      const a = makeTs(dir, 'a.ts', 3600);
      const b = makeTs(dir, 'b.ts', 3602);
      const span = await probeConcatSpan([a, b], resolveFfprobeBin(), 10);
      expect(span).not.toBeNull();
      expect(span!.spanSec).toBeGreaterThan(3);
      expect(span!.spanSec).toBeLessThan(6);
      expect(span!.reliable).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('salto de PTS entre arquivos: span absurdo, reliable=false', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spanjump-'));
    try {
      const a = makeTs(dir, 'a.ts', 3600);
      const b = makeTs(dir, 'b.ts', 3600 + 50000);
      const span = await probeConcatSpan([a, b], resolveFfprobeBin(), 10);
      expect(span).not.toBeNull();
      expect(span!.spanSec).toBeGreaterThan(40000);
      expect(span!.reliable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!ffmpegOk)('buildClip (passada única: emenda A/V realinhada)', () => {
  // ffmpeg pelo nome (isSegmentReadable/render): .tools no PATH
  process.env.PATH = `${path.resolve('.tools')}${path.delimiter}${process.env.PATH ?? ''}`;

  it(
    'produz mp4 com vídeo+áudio a partir de segmentos TS',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildclip-'));
      const clipsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
      try {
        // 4 segmentos TS de 2s (sanitize descarta o mais novo; 3 ficam).
        // -output_ts_offset 3600: PTS ABSOLUTOS (offset de 1h) como no
        // broadcast ao vivo — o render precisa re-ancorar sem estourar.
        const segs: string[] = [];
        for (let i = 0; i < 4; i++) {
          const f = path.join(dir, `seg_${String(i).padStart(3, '0')}.ts`);
          execFileSync(FF, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
            '-muxdelay', '0', '-output_ts_offset', '3600',
            '-f', 'mpegts', f,
          ]);
          segs.push(f);
        }
        const ace = {
          matchId: 'bb', map: 'Cache', round: 3, player: 'x',
          team1: 'A', team2: 'B', event: 'E',
          detectedAt: new Date().toISOString(),
          kills: [1, 2, 3].map((i) => ({ killer: 'x', victim: `v${i}`, round: 3, map: 'Cache' })),
        };
        const out = await buildClip(ace, segs, {
          bufferDir: dir,
          clipsDir,
          preRollSec: 60,
          postRollSec: 15,
          segmentTimeSec: 10,
          upscaleHeight: 0,
          // Este teste é do concat/trim — sync tem e2e próprio (e medir em
          // testsrc periódico dá pico espúrio).
          avSync: 'off',
        });
        expect(fs.existsSync(out.filePath)).toBe(true);
        // saída precisa ter vídeo E áudio (emenda realinhada)
        let err = '';
        try {
          execFileSync(FF, ['-hide_banner', '-i', out.filePath]);
        } catch (e) {
          err = String((e as { stderr?: string }).stderr ?? e);
        }
        expect(err).toMatch(/Stream #0:0[^\n]*: Video/);
        expect(err).toMatch(/Stream #0:1[^\n]*: Audio/);
        const dur = /Duration: \d+:\d+:(\d+\.\d+)/.exec(err);
        expect(dur).not.toBeNull();
        const sec = Number(dur![1]);
        // 3 segmentos usáveis × 2s = ~6s (sanitize derruba o mais novo)
        expect(sec).toBeGreaterThan(4.5);
        expect(sec).toBeLessThan(7.5);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(clipsDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe('sanitizeSegments', () => {
  it('descarta tudo quando nada é legível (ex: arquivos inexistentes)', async () => {
    const r = await sanitizeSegments(['/nao/existe/a.mp4', '/nao/existe/b.mp4', '/nao/existe/c.mp4']);
    expect(r.ok).toEqual([]);
    expect(r.dropped).toHaveLength(3);
  });
});

describe.skipIf(!ffmpegOk)('auto-sync A/V (flash+beep com offset conhecido)', () => {

  // Mídia sintética: flashes brancos em instantes IRREGULARES no vídeo +
  // beeps 880Hz 2s ANTES (áudio adiantado +2s). Irregular de propósito:
  // eventos periódicos correlacionam em qualquer lag (prominência ~1).
  // Flashes em 3, 6, 7.5, 11, 12.2s (300ms); beeps nos mesmos −2s.
  async function makeOffsetMedia(dir: string): Promise<string> {
    const f = path.join(dir, 'off.mp4');
    const flashAt = (t: number): string => `gte(t\\,${t})*lte(t\\,${t + 0.3})`;
    const beepAt = (t: number): string => `gte(t\\,${t})*lte(t\\,${t + 0.3})`;
    const flashTimes = [3, 6, 7.5, 11, 12.2];
    const beepTimes = flashTimes.map((t) => t - 2);
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=color=black:duration=14:size=320x180:rate=30',
      '-f', 'lavfi', '-i',
      `aevalsrc=sin(2*PI*880*t)*(${beepTimes.map(beepAt).join('+')}):s=44100:d=14`,
      '-map', '0:v', '-map', '1:a',
      '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flashTimes.map(flashAt).join('+')}'`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-f', 'mp4', f,
    ]);
    return f;
  }

  // Offset beep↔flash no ARQUIVO: picos de loudness vs picos de luminância.
  // Amostras crus NÃO emparelham por ordem (beep vira ~6 amostras M, flash
  // ~3 frames) — agrupa em EVENTOS (gap > 0.5s separa) e compara inícios.
  async function beepFlashOffset(file: string): Promise<number> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const eb = await execFileAsync(FF, [
      // framelog=info: quiet SUPRIME as linhas t:/M: (0 beeps → NaN)
      '-hide_banner', '-i', file, '-map', '0:a', '-af', 'ebur128=peak=true:framelog=info', '-f', 'null', '-',
    ]).then((r) => String(r.stderr ?? ''));
    const beepSamples: number[] = [];
    for (const line of eb.split('\n')) {
      const m = line.match(/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/);
      if (m && Number.parseFloat(m[2]) > -25) beepSamples.push(Number.parseFloat(m[1]));
    }
    const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncvf-'));
    try {
      execFileSync(FF, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
        '-vf', 'fps=10,scale=160:-1', path.join(fdir, 'fr_%04d.png'),
      ]);
      const sharp = (await import('sharp')).default;
      const flashSamples: number[] = [];
      const fr = fs.readdirSync(fdir).filter((x) => x.endsWith('.png')).sort();
      for (const [i, name] of fr.entries()) {
        const { data, info } = await sharp(path.join(fdir, name)).raw().toBuffer({ resolveWithObject: true });
        let sum = 0;
        const ch = info.channels;
        for (let p = 0; p < data.length; p += ch) sum += data[p];
        if (sum / (data.length / ch) > 200) flashSamples.push(i / 10);
      }
      const events = (times: number[]): number[] => {
        const out: number[] = [];
        for (const t of times) {
          if (out.length === 0 || t - out[out.length - 1] > 0.5) out.push(t);
        }
        return out;
      };
      const beeps = events(beepSamples);
      const flashes = events(flashSamples);
      if (beeps.length === 0 || flashes.length === 0) return Number.NaN;
      const pairs = Math.min(beeps.length, flashes.length);
      const diffs = beeps.slice(0, pairs).map((b, i) => b - flashes[i]);
      diffs.sort((a, b) => a - b);
      return diffs[Math.floor(diffs.length / 2)];
    } finally {
      fs.rmSync(fdir, { recursive: true, force: true });
    }
  }

  function aceVazio(map = 'Cache') {
    return {
      matchId: 'sync', map, round: 1, player: 'x',
      team1: 'A', team2: 'B', event: 'E',
      detectedAt: new Date().toISOString(),
      kills: [{ killer: 'x', victim: 'v', round: 1, map }],
    };
  }

  it(
    'mede δ≈+2s e entrega saída alinhada (<0.6s); sem compensação fica ~2s',
    async () => {
      if (!resolveFfprobeBin()) {
        console.warn('sem ffprobe, pulando');
        return;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
      const clipsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncclips-'));
      try {
        const src = await makeOffsetMedia(dir);
        const measured = await measureAvOffset([src], FF);
        expect(measured.measured).toBe(true);
        expect(measured.offsetSec).toBeGreaterThan(1.2);
        expect(measured.offsetSec).toBeLessThan(2.8);

        // Bases DIFERENTES (map distinto): mesmo path faria o build 'off'
        // SOBRESCREVER o 'com' antes da medição (bug real deste teste).
        const comClip = await buildClip(aceVazio('Cache'), [src], {
          bufferDir: dir, clipsDir, preRollSec: 60, postRollSec: 15,
          segmentTimeSec: 10, upscaleHeight: 0, avSync: 'auto',
        });
        const offClip = await buildClip(aceVazio('Mirage'), [src], {
          bufferDir: dir, clipsDir, preRollSec: 60, postRollSec: 15,
          segmentTimeSec: 10, upscaleHeight: 0, avSync: 'off',
        });
        const offCom = await beepFlashOffset(comClip.filePath);
        const offOff = await beepFlashOffset(offClip.filePath);
        expect(Number.isNaN(offCom)).toBe(false);
        expect(Math.abs(offCom)).toBeLessThan(0.6);
        // controle: sem compensação o skew original aparece
        expect(Math.abs(offOff)).toBeGreaterThan(1.2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(clipsDir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
