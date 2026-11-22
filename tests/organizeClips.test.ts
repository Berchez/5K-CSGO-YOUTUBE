import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalPathKey,
  movedFilePath,
  rowsForClipPath,
} from '../scripts/organize-clips.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('organize-clips: seleção das linhas do banco', () => {
  it('usa a raiz configurada, não o nome da pasta', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organize-'));
    tempDirs.push(dir);
    const root = path.join(dir, 'clips-custom');
    const expected = path.join(root, '2399958.mp4');
    const rows = [
      { id: 1, filePath: expected, channelId: 'br' },
      { id: 2, filePath: path.join(dir, 'outro-clips', '2399958.mp4'), channelId: 'br' },
      { id: 3, filePath: expected, channelId: 'en' },
    ];

    expect(rowsForClipPath(rows, root, '2399958.mp4')).toEqual([rows[0]]);
  });

  it('não confunde caminhos equivalentes com outra raiz', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organize-'));
    tempDirs.push(dir);
    const root = path.join(dir, 'clips');
    const rows = [
      { id: 1, filePath: path.join(dir, 'other', 'same.mp4'), channelId: 'br' },
      { id: 2, filePath: path.join(root, 'same.mp4'), channelId: 'br' },
    ];

    expect(rowsForClipPath(rows, root, 'same.mp4').map((row) => row.id)).toEqual([2]);
  });

  it('preserva o caminho gravado ao acrescentar a pasta do clipe', () => {
    expect(movedFilePath('data/clips/2399958.mp4', '2399958')).toBe(
      'data/clips/2399958/2399958.mp4',
    );
  });

  it('normaliza o caminho para comparação no Windows', () => {
    const value = canonicalPathKey(path.join('data', 'clips', 'clip.mp4'));
    const upper = canonicalPathKey(path.join('DATA', 'CLIPS', 'clip.mp4'));
    if (process.platform === 'win32') expect(value).toBe(upper);
    else expect(value).not.toBe(upper);
  });
});
