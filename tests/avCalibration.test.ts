import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearCalibration,
  loadCalibrations,
  noteRestart,
  resolveSessionOffset,
  saveCalibration,
} from '../src/recorder/avCalibration.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avcal-')), 'cal.json');
}

describe('avCalibration store (round-trip em arquivo)', () => {
  it('ausente = {} ; salva, lê, limpa', () => {
    const f = tmpFile();
    expect(loadCalibrations(f)).toEqual({});
    saveCalibration('ESL TV', 2000, { file: f, by: 'fix20', at: 1_700_000_000_000 });
    const loaded = loadCalibrations(f);
    expect(loaded['ESL TV']).toMatchObject({ offsetMs: 2000, calibratedAt: 1_700_000_000_000, by: 'fix20' });
    expect(clearCalibration('ESL TV', f)).toBe(true);
    expect(loadCalibrations(f)).toEqual({});
    expect(clearCalibration('ESL TV', f)).toBe(false);
  });

  it('corrompido = {} (nunca joga)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avcal-'));
    const f = path.join(dir, 'cal.json');
    fs.writeFileSync(f, 'não é json {{{');
    expect(loadCalibrations(f)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('entradas inválidas são filtradas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avcal-'));
    const f = path.join(dir, 'cal.json');
    fs.writeFileSync(f, JSON.stringify({
      ok: { offsetMs: 1500, calibratedAt: 1_700_000_000_000 },
      alto: { offsetMs: 99999, calibratedAt: 1_700_000_000_000 },
      semdata: { offsetMs: 1000 },
      lixo: 42,
    }));
    const loaded = loadCalibrations(f);
    expect(Object.keys(loaded)).toEqual(['ok']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveSessionOffset (override > sessão válida > 0+flag)', () => {
  const NOW = 2_000_000_000;
  const cal = { offsetMs: 2000, calibratedAt: NOW - 60_000 };

  it('override manual vence tudo', () => {
    expect(resolveSessionOffset({
      staticMs: 1500, staticRule: 'match', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 120_000,
      discontinuities: [], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    })).toEqual({ ms: 1500, source: 'static', unverified: false, reason: 'override match' });
  });

  it('override + restart na janela: aplica mas sinaliza', () => {
    const r = resolveSessionOffset({
      staticMs: 1500, staticRule: 'stream', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 120_000,
      discontinuities: [NOW - 20_000], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    });
    expect(r).toEqual({ ms: 1500, source: 'static', unverified: true, reason: 'override stream + restart na janela' });
  });

  it('sessão calibrada sem restart: aplica', () => {
    expect(resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 120_000,
      discontinuities: [], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    })).toEqual({ ms: 2000, source: 'calibrated', unverified: false, reason: 'calibragem da sessão' });
  });

  it('restart na janela: zera + flag (fail-safe)', () => {
    const r = resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 120_000,
      discontinuities: [NOW - 20_000], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    });
    expect(r.ms).toBe(0);
    expect(r.unverified).toBe(true);
    expect(r.reason).toMatch(/restart na janela/);
  });

  it('restart ANTES da calibragem: ignorado', () => {
    const r = resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 300_000,
      discontinuities: [NOW - 200_000], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    });
    expect(r).toEqual({ ms: 2000, source: 'calibrated', unverified: false, reason: 'calibragem da sessão' });
  });

  it('recorder mais novo que a calibragem: nova sessão, recalibrar', () => {
    const r = resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 10_000,
      discontinuities: [], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    });
    expect(r.ms).toBe(0);
    expect(r.unverified).toBe(true);
    expect(r.reason).toBe('nova sessão, recalibrar');
  });

  it('sem calibragem: 0 silencioso (clipes bons nunca tocados)', () => {
    expect(resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: undefined,
      streamName: 'dfragtv', sessionStartMs: NOW - 120_000,
      discontinuities: [NOW - 20_000], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    })).toEqual({ ms: 0, source: 'none', unverified: false, reason: 'sem calibragem (default 0)' });
  });

  it('sem âncora p/ verificar janela: flag conservadora', () => {
    const r = resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 120_000,
      discontinuities: [],
    });
    expect(r.ms).toBe(0);
    expect(r.unverified).toBe(true);
  });

  it('restart após calibragem mas ANTES da janela: invalida igual', () => {
    // O caso que o "só na janela" deixava passar: restart às -50s muda o
    // offset; o clipe (-30s..-10s) usaria δ expirado.
    const r = resolveSessionOffset({
      staticMs: 0, staticRule: 'off', calibration: cal,
      streamName: 'ESL TV', sessionStartMs: NOW - 300_000,
      discontinuities: [NOW - 50_000], winStartMs: NOW - 30_000, winEndMs: NOW - 10_000,
    });
    expect(r.ms).toBe(0);
    expect(r.unverified).toBe(true);
    expect(r.reason).toMatch(/desde a calibragem/);
  });
});

describe('noteRestart (era compartilhada)', () => {
  it('carimba só com calibragem existente; ignora mais antigo', () => {
    const f = tmpFile();
    noteRestart('ESL TV', 1_700_000_000_000, f);
    expect(loadCalibrations(f)).toEqual({});
    saveCalibration('ESL TV', 2000, { file: f, at: 1_700_000_000_000 });
    noteRestart('ESL TV', 1_700_000_100_000, f);
    expect(loadCalibrations(f)['ESL TV'].lastRestartAt).toBe(1_700_000_100_000);
    noteRestart('ESL TV', 1_700_000_050_000, f);
    expect(loadCalibrations(f)['ESL TV'].lastRestartAt).toBe(1_700_000_100_000);
    expect(loadCalibrations(f)['ESL TV'].offsetMs).toBe(2000);
  });
});
