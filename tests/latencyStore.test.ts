import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLatencyState, saveLatencyState } from '../src/monitor/latencyStore.js';
import { StreamLatencyTracker } from '../src/monitor/streamLatency.js';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-store-'));
  file = path.join(dir, 'nested', 'stream-latency.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadLatencyState / saveLatencyState', () => {
  it('arquivo ausente devolve estado vazio sem problema', () => {
    const loaded = loadLatencyState(file);
    expect(loaded.problem).toBeNull();
    expect(loaded.state.channels()).toEqual([]);
  });

  it('salva e recarrega as amostras e o crop por canal', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 42_000, { measuredAtMs: 1_700_000_000_000 });
    tracker.setCrop('Gaules', '0.02:0.02:0.30:0.14');
    expect(saveLatencyState(file, tracker)).toBe(true);

    const loaded = loadLatencyState(file);
    expect(loaded.problem).toBeNull();
    expect(loaded.state.median('gaules')).toBe(42_000);
    expect(loaded.state.latest('gaules')?.measuredAtMs).toBe(1_700_000_000_000);
    expect(loaded.state.crop('Gaules')).toBe('0.02:0.02:0.30:0.14');
  });

  it('JSON corrompido não derruba o bot (estado vazio + problema)', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ isso nao é json');
    const loaded = loadLatencyState(file);
    expect(loaded.problem).toBe('JSON inválido');
    expect(loaded.state.channels()).toEqual([]);
  });

  it('versão incompatível é recusada (formato antigo)', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 999, streams: {} }));
    const loaded = loadLatencyState(file);
    expect(loaded.problem).toContain('999');
    expect(loaded.state.channels()).toEqual([]);
  });

  it('a escrita é atômica (não deixa arquivo temporário para trás)', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 10_000);
    saveLatencyState(file, tracker);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});
