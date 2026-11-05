import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyAudioError, transcribeWav } from '../src/transcription/transcribe.js';

const temporarios: string[] = [];

afterEach(() => {
  for (const file of temporarios.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort
    }
  }
});

describe('transcrição: o áudio vazio tem CLASSE de erro (não string)', () => {
  it('WAV sem samples lança EmptyAudioError', async () => {
    const file = path.join(os.tmpdir(), `5k-empty-audio-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.alloc(44));
    temporarios.push(file);
    await expect(transcribeWav(file, { provider: 'gemini' })).rejects.toBeInstanceOf(
      EmptyAudioError,
    );
  });
});
