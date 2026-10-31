import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDurationCap, buildClip, computeTrimEndSec, computeTrimStartSec, contiguousTail, detectActionResume, detectTruncatedStart, findMotionResume, makeClipThumbnail, newestSegmentEndMs, parseFreezeIntervals, patchSidecarThumbnail, pickSegments, probeConcatSpan, REPLAY_AWARE_MIN_OVERLAP_MS, resolveConcatTimeline, resolveFfmpegBin, resolveFfprobeBin, resolveReplayAwareEndMs, sanitizeSegments, verifySegmentAv } from '../src/clipper/clipBuilder.js';
import { computeAceEndMs } from '../src/clipper/clipAnchors.js';

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

describe('findMotionResume (retomada de ação no envelope de movimento)', () => {
  const HIGH = [20, 21, 19, 22, 20, 21];
  const LOW = [1, 0.8, 1.2, 0.9, 1.1, 1];

  it('alta→baixa→alta: acha a ÚLTIMA transição (ação, não o ace)', () => {
    const r = findMotionResume([...HIGH, ...LOW, ...HIGH], 1);
    expect(r.reason).toBe('ok');
    // conclusão da transição (janela quieta atrás + ativa à frente),
    // não o onset — precisão de ~1s, suficiente p/ margem de 2s do shadow
    expect(r.index).toBe(13);
    expect(r.quiet).toBeLessThan(2);
    expect(r.active).toBeGreaterThan(10);
  });

  it('tudo alto ou tudo baixo: null', () => {
    expect(findMotionResume([...HIGH, ...HIGH], 1).index).toBeNull();
    expect(findMotionResume([...LOW, ...LOW], 1).index).toBeNull();
  });

  it('spike isolado no meio do quieto não elege transição', () => {
    const mad = [...LOW, 50, ...LOW.slice(0, 5), ...HIGH];
    const r = findMotionResume(mad, 1);
    expect(r.reason).toBe('ok');
    expect(r.index).toBe(13);
  });

  it('série curta: null com motivo', () => {
    expect(findMotionResume([1, 2, 3], 1).reason).toBe('série curta');
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
  it('soma a latência da stream (o fim é instante de VÍDEO)', () => {
    // round fechou em T; o placar mostrou em T+15s (lag 15) e o vídeo
    // gravado só recebe esse material 25s depois (latência da stream).
    const T = 1_000_000_000;
    expect(computeAceEndMs(T + 15_000, 10_000, 8, 25_000)).toBe(T + 38_000);
  });
});

describe('applyDurationCap (teto como alarme)', () => {
  it('dentro do cap: sem clamp', () => {
    expect(applyDurationCap(10, 60, 100, 105)).toEqual({ trimEndSec: 60, clamped: false });
    expect(applyDurationCap(10, null, 100, 105)).toEqual({ trimEndSec: null, clamped: false });
  });
  it('estouro: força o corte e sinaliza', () => {
    // caso Alisson sem span: concat inteiro (null) de 412s → duração limitada a 105s
    expect(applyDurationCap(10, null, 412, 105)).toEqual({ trimEndSec: 105, clamped: true });
    expect(applyDurationCap(10, 500, 412, 105)).toEqual({ trimEndSec: 105, clamped: true });
    // fallback wall sem âncora válida: também dispara (duração física!)
    // trim 10s num concat de 400s sem fim → 390s > cap → limita duração a 105s
    expect(applyDurationCap(10, null, 400, 105)).toEqual({ trimEndSec: 105, clamped: true });
    // trimEndSec is a duration relative to trimStart, not a concat position.
    expect(applyDurationCap(26.994, 131.994, 200, 105)).toEqual({ trimEndSec: 105, clamped: true });
    // mas trim 348s no mesmo concat deixa só 52s → sem clamp (correto)
    expect(applyDurationCap(348, null, 400, 105)).toEqual({ trimEndSec: null, clamped: false });
  });
});

describe('resolveConcatTimeline (span medido → wall → legado)', () => {
  it('span confiável: measured', () => {
    expect(resolveConcatTimeline({
      firstMtimeMs: 900_000, lastMtimeMs: 930_000, fileCount: 3,
      segmentTimeSec: 10, spanSec: 30, spanReliable: true, wallSec: 30,
    })).toEqual({ startMs: 900_000, lenSec: 30, mode: 'measured' });
  });
  it('salto de PTS (r21: 18h em 1 arquivo, wall 400s): wall fallback', () => {
    const M = 2_000_000_000;
    expect(resolveConcatTimeline({
      firstMtimeMs: M, lastMtimeMs: M, fileCount: 1,
      segmentTimeSec: 10, spanSec: 66874.36, spanReliable: false, wallSec: 400,
    })).toEqual({ startMs: M - 400_000, lenSec: 400, mode: 'wall' });
  });
  it('sem medição: legacy n×slot', () => {
    expect(resolveConcatTimeline({
      firstMtimeMs: 900_000, lastMtimeMs: 920_000, fileCount: 3, segmentTimeSec: 10,
    })).toEqual({ startMs: 890_000, lenSec: 30, mode: 'legacy' });
  });
  it('wall absurdo: legacy (não confia em relógio quebrado)', () => {
    expect(resolveConcatTimeline({
      firstMtimeMs: 900_000, lastMtimeMs: 930_000, fileCount: 3,
      segmentTimeSec: 10, spanSec: 99999, spanReliable: false, wallSec: 99_999_999,
    }).mode).toBe('legacy');
  });
  it('caso r21 fim-a-fim (puro): salto de 18h com wall 400s ancora certo', () => {
    const aceStartMs = Date.parse('2026-10-15T02:32:21.277Z');
    const aceEndMs = Date.parse('2026-10-15T02:32:45.306Z');
    const M = aceEndMs + 18_000; // snapshot ~18s após o fim do round
    const t = resolveConcatTimeline({
      firstMtimeMs: M, lastMtimeMs: M, fileCount: 1,
      segmentTimeSec: 10, spanSec: 66874.36, spanReliable: false, wallSec: 400,
    });
    expect(t.mode).toBe('wall');
    // desejado = 1ª kill − 10s; início real = fim − 382s → trim ~348s
    const trim = computeTrimStartSec(M, 10, aceStartMs, 10, t.startMs);
    expect(trim).toBeCloseTo(347.97, 1);
    const trimEnd = computeTrimEndSec(t.startMs, 1, 10, aceEndMs, trim, t.lenSec);
    expect(trimEnd).toBeCloseTo(34.03, 1);
    // janela ≈ 34s: cap nem dispara
    expect(applyDurationCap(trim, trimEnd, t.lenSec, 105).clamped).toBe(false);
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

describe('detectTruncatedStart (âncora mais velha que o buffer)', () => {
  it('âncora dentro da cobertura: false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-'));
    try {
      const now = Date.now();
      // cobertura ≈ [now-30s, now]
      const segs = makeSegments(dir, 3, 10_000, now);
      // ace há 15s, ctx 10s → desejado now-25s (dentro) → false
      expect(detectTruncatedStart(segs, { segmentTimeSec: 10, contextSec: 10, aceStartMs: now - 15_000 })).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('âncora além da cobertura (R2): true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc2-'));
    try {
      const now = Date.now();
      const segs = makeSegments(dir, 3, 10_000, now);
      // ace há 100s, ctx 10s → desejado now-110s (fora) → true
      expect(detectTruncatedStart(segs, { segmentTimeSec: 10, contextSec: 10, aceStartMs: now - 100_000 })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem âncora ou sem arquivos: false', () => {
    expect(detectTruncatedStart([], { segmentTimeSec: 10, aceStartMs: 1_000_000 })).toBe(false);
    expect(detectTruncatedStart(['x-inexistente.ts'], { segmentTimeSec: 10 })).toBe(false);
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


describe('parseFreezeIntervals', () => {
  it('pairs freeze start/end metadata and closes a trailing freeze', () => {
    const log = [
      '[freezedetect] lavfi.freezedetect.freeze_start: 2',
      '[freezedetect] lavfi.freezedetect.freeze_duration: 1.2',
      '[freezedetect] lavfi.freezedetect.freeze_end: 3.2',
      '[freezedetect] lavfi.freezedetect.freeze_start: 8',
      '[freezedetect] lavfi.freezedetect.freeze_duration: 0.6',
    ].join('\n');
    expect(parseFreezeIntervals(log)).toEqual([
      { startSec: 2, endSec: 3.2, durationSec: 1.2 },
      { startSec: 8, endSec: 8.6, durationSec: 0.6 },
    ]);
  });

  it('ignores partial and non-finite metadata', () => {
    expect(parseFreezeIntervals('[freezedetect] lavfi.freezedetect.freeze_start: nan')).toEqual([]);
    expect(parseFreezeIntervals('no freeze metadata')).toEqual([]);
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

  it('salto de PTS ENTRE arquivos: duração é conteúdo (salto não conta), reliable', async () => {
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
      // conteúdo real: 2s + 2s — o salto ENTRE arquivos não é duração
      expect(span!.spanSec).toBeGreaterThan(3);
      expect(span!.spanSec).toBeLessThan(6);
      expect(span!.reliable).toBe(true);
      // forense: o span BRUTO mostra o salto
      expect(span!.rawSpanSec ?? 0).toBeGreaterThan(40000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('salto de PTS DENTRO do arquivo (caso r12): conteúdo exclui o salto', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spanintra-'));
    try {
      // duas eras no MESMO arquivo: 2s @3600 + 2s @50000 (cat de TS é
      // literalmente o que um restart de transcode produz no buffer)
      const a = makeTs(dir, 'x.ts', 3600);
      const b = makeTs(dir, 'y.ts', 50000);
      const f = path.join(dir, 'jump.ts');
      fs.writeFileSync(f, fs.readFileSync(a));
      fs.appendFileSync(f, fs.readFileSync(b));
      const span = await probeConcatSpan([f], resolveFfprobeBin(), 10);
      expect(span).not.toBeNull();
      expect(span!.spanSec).toBeGreaterThan(3);
      expect(span!.spanSec).toBeLessThan(6);
      expect(span!.reliable).toBe(true);
      expect(span!.rawSpanSec ?? 0).toBeGreaterThan(40000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!ffmpegOk)('trava de saída do render (nunca shippar vazio)', () => {
  it('trim além do conteúdo: aborta com erro e NÃO deixa stub', async () => {
    if (!resolveFfprobeBin()) {
      console.warn('sem ffprobe, pulando');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-'));
    const clipsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voidclips-'));
    try {
      const seg = path.join(dir, 'seg_000.ts');
      execFileSync(FF, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
        '-f', 'mpegts', seg,
      ]);
      const ace = {
        matchId: 'voidclip', map: 'Cache', round: 1, player: 'x',
        team1: 'A', team2: 'B', event: 'E',
        detectedAt: new Date().toISOString(),
        kills: [{ killer: 'x', victim: 'v', round: 1, map: 'Cache' }],
      };
      // REGRESSÃO 2399080 r8/r9: âncora ~50s além do conteúdo fazia o
      // ffmpeg "renderizar" vazio com sucesso (mp4 de 256B, ilegível).
      await expect(
        buildClip(ace, [seg], {
          bufferDir: dir, clipsDir, preRollSec: 60, postRollSec: 15,
          segmentTimeSec: 10, replayAware: 'off',
          aceStartMs: Date.now() + 50_000,
        }),
      ).rejects.toThrow();
      // nem stub nem pasta vazia sobraram
      const leftovers = fs.readdirSync(clipsDir);
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(clipsDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!ffmpegOk)('detectActionResume (shadow replay-aware)', () => {
  function makeMoving(dir: string, name: string, durSec = 4): string {
    const f = path.join(dir, name);
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=duration=${durSec}:size=320x180:rate=30`,
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-f', 'mpegts', f,
    ]);
    return f;
  }

  function makeStatic(dir: string, name: string, durSec = 4): string {
    const f = path.join(dir, name);
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=30:d=${durSec}`,
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-f', 'mpegts', f,
    ]);
    return f;
  }

  it('movimento→parado→movimento: acha a retomada (~8s)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    try {
      const files = [
        makeMoving(dir, 'a.ts'),
        makeStatic(dir, 'b.ts'),
        makeMoving(dir, 'c.ts'),
      ];
      const r = await detectActionResume(files, FF);
      expect(r.reason).toBe('ok');
      expect(r.actionStartSec).not.toBeNull();
      expect(r.actionStartSec!).toBeGreaterThan(5.5);
      expect(r.actionStartSec!).toBeLessThan(10.5);
      expect(r.activeMad).toBeGreaterThan(r.quietMad * 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('tudo parado: null (sem transição)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeflat-'));
    try {
      const files = [makeStatic(dir, 'a.ts'), makeStatic(dir, 'b.ts')];
      const r = await detectActionResume(files, FF);
      expect(r.actionStartSec).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('resolveReplayAwareEndMs (replay-aware aplicado)', () => {
  const T = 1_700_000_000_000;

  it('auto: fim fixo bem depois da retomada → corta 2s antes da ação', () => {
    expect(resolveReplayAwareEndMs(T + 100_000, T + 60_000, 'auto', T + 200_000)).toEqual({
      endMs: T + 58_000,
      trimmed: true,
    });
  });

  it('auto: fim dentro da folga não corta (evita cortar o win panel)', () => {
    const r = resolveReplayAwareEndMs(
      T + 60_000,
      T + 60_000,
      'auto',
      T + 200_000,
    );
    expect(r.trimmed).toBe(false);
    expect(r.endMs).toBe(T + 60_000);
    expect(REPLAY_AWARE_MIN_OVERLAP_MS).toBe(5_000);
  });

  it('on: aplica com qualquer sobreposição', () => {
    expect(resolveReplayAwareEndMs(T + 59_000, T + 60_000, 'on', T + 200_000)).toEqual({
      endMs: T + 58_000,
      trimmed: true,
    });
  });

  it('shadow/off nunca cortam', () => {
    expect(resolveReplayAwareEndMs(T + 100_000, T + 60_000, 'shadow', T + 200_000).trimmed).toBe(false);
    expect(resolveReplayAwareEndMs(T + 100_000, T + 60_000, 'off', T + 200_000).trimmed).toBe(false);
  });

  it('sem retomada detectada não corta', () => {
    expect(resolveReplayAwareEndMs(T + 100_000, null, 'auto', T + 200_000)).toEqual({
      endMs: T + 100_000,
      trimmed: false,
    });
  });

  it('sem fim fixo usa a cauda do concat como referência', () => {
    expect(resolveReplayAwareEndMs(null, T + 60_000, 'auto', T + 100_000)).toEqual({
      endMs: T + 58_000,
      trimmed: true,
    });
    expect(resolveReplayAwareEndMs(null, T + 60_000, 'auto', T + 50_000)).toEqual({
      endMs: null,
      trimmed: false,
    });
  });

  it('REGRESSÃO 2399756: retomada antes da última kill → o corte é descartado (piso)', () => {
    // O fim fixo T+100s passaria da retomada (T+60s → corte T+58s), mas a
    // última kill do ace está em T+70s: fechar em T+58s a perderia.
    expect(
      resolveReplayAwareEndMs(T + 100_000, T + 60_000, 'auto', T + 200_000, T + 78_000),
    ).toEqual({ endMs: T + 100_000, trimmed: false });
    // Piso antes da retomada: o corte segue valendo.
    expect(
      resolveReplayAwareEndMs(T + 100_000, T + 60_000, 'auto', T + 200_000, T + 50_000),
    ).toEqual({ endMs: T + 58_000, trimmed: true });
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
        });
        expect(fs.existsSync(out.filePath)).toBe(true);
        // layout: um diretório por clipe (mp4 + sidecar + thumb juntos)
        expect(out.filePath).toBe(path.join(clipsDir, 'bb_Cache_r3_x', 'bb_Cache_r3_x.mp4'));
        expect(out.sidecarPath).toBe(path.join(clipsDir, 'bb_Cache_r3_x', 'bb_Cache_r3_x.json'));
        // F4: a thumb NÃO nasce mais no render — ela roda depois do upload.
        expect(out.thumbnailPath).toBeUndefined();
        expect(fs.existsSync(out.sidecarPath)).toBe(true);
        const sidecar = JSON.parse(fs.readFileSync(out.sidecarPath, 'utf8')) as {
          captureMode?: string;
          freezeDetection?: { thresholdDb?: number; minDurationSec?: number; intervals?: unknown[] };
        };
        expect(sidecar.captureMode).toBe('muxed');
        expect(sidecar.freezeDetection).toMatchObject({
          thresholdDb: -50,
          minDurationSec: 0.5,
        });
        expect(Array.isArray(sidecar.freezeDetection?.intervals)).toBe(true);
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

describe.skipIf(!ffmpegOk)('sanitizeSegments (fonte congelada: o mais novo está fechado)', () => {
  function makeReal(dir: string, name: string): string {
    const f = path.join(dir, name);
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      f,
    ]);
    return f;
  }

  it('newestIsClosed: mantém o arquivo mais novo (ninguém está gravando)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-'));
    try {
      const files = [makeReal(dir, 'a.mp4'), makeReal(dir, 'b.mp4'), makeReal(dir, 'c.mp4')];
      const r = await sanitizeSegments(files, { newestIsClosed: true });
      expect(r.ok).toHaveLength(3);
      expect(r.dropped).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('padrão: descarta o mais novo (em gravação)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gravando-'));
    try {
      const files = [makeReal(dir, 'a.mp4'), makeReal(dir, 'b.mp4'), makeReal(dir, 'c.mp4')];
      const r = await sanitizeSegments(files);
      expect(r.ok).toHaveLength(2);
      expect(r.dropped).toContain(files[2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!ffmpegOk)('makeClipThumbnail (F4: thumb depois do upload)', () => {
  process.env.PATH = `${path.resolve('.tools')}${path.delimiter}${process.env.PATH ?? ''}`;

  it('gera a jpg ao lado do mp4 e anota no sidecar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbclip-'));
    try {
      const clipPath = path.join(dir, 'clipe.mp4');
      execFileSync(FF, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        clipPath,
      ]);
      const ace = {
        matchId: 'm1', map: 'Mirage', round: 3, player: 'x',
        team1: 'A', team2: 'B', event: 'E',
        detectedAt: new Date().toISOString(),
        kills: [1, 2, 3, 4, 5].map((i) => ({ killer: 'x', victim: `v${i}`, round: 3, map: 'Mirage' })),
      };
      const thumb = await makeClipThumbnail(ace, clipPath, {
        atSec: 2,
        thumb: { mode: 'composed' },
      });
      expect(thumb).toBe(path.join(dir, 'clipe.jpg'));
      expect(fs.statSync(thumb!).size).toBeGreaterThan(5_000);

      const sidecar = path.join(dir, 'clipe.json');
      fs.writeFileSync(sidecar, JSON.stringify({ clipFile: 'clipe.mp4' }, null, 2));
      patchSidecarThumbnail(sidecar, thumb);
      expect((JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { thumbnailFile?: string }).thumbnailFile).toBe('clipe.jpg');
      patchSidecarThumbnail(sidecar, null);
      expect((JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { thumbnailFile?: string | null }).thumbnailFile).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('sidecar inexistente não lança (best-effort)', () => {
    expect(() => patchSidecarThumbnail(path.join(os.tmpdir(), 'nao-existe-xyz.json'), null)).not.toThrow();
  });
});
