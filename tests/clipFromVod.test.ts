import { describe, expect, it } from 'vitest';
import { scoreTurnSec, type ScoreSample } from '../scripts/clip-from-vod.js';

function sample(sec: number, left: number | null, right: number | null): ScoreSample {
  return { sec, left, right, raw: `${left ?? '?'}|${right ?? '?'}` };
}

describe('placar: detecção de virada (scoreTurnSec)', () => {
  it('não inventa virada quando o placar fica parado', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6].map((i) => sample(i + 0.5, 3, 5));
    expect(scoreTurnSec(samples)).toBeNull();
  });

  it('não inventa virada com uma leitura errada isolada', () => {
    // 3->4 numa amostra só (volta para 3 logo em seguida): leitura ruim.
    const samples = [
      sample(0.5, 3, 5),
      sample(1.5, 3, 5),
      sample(2.5, 3, 5),
      sample(3.5, 4, 5),
      sample(4.5, 3, 5),
      sample(5.5, 3, 5),
      sample(6.5, 3, 5),
    ];
    expect(scoreTurnSec(samples)).toBeNull();
  });

  it('não inventa virada quando os dois lados mudam juntos', () => {
    const samples = [
      sample(0.5, 3, 5),
      sample(1.5, 3, 5),
      sample(2.5, 3, 5),
      sample(3.5, 4, 6),
      sample(4.5, 4, 6),
      sample(5.5, 4, 6),
      sample(6.5, 4, 6),
    ];
    expect(scoreTurnSec(samples)).toBeNull();
  });

  it('acha a virada do lado esquerdo com o placar antigo bem visto', () => {
    const samples = [
      sample(0.5, 3, 5),
      sample(1.5, 3, 5),
      sample(2.5, 3, 5),
      sample(3.5, 4, 5),
      sample(4.5, 4, 5),
      sample(5.5, 4, 5),
      sample(6.5, 4, 5),
    ];
    const turn = scoreTurnSec(samples);
    expect(turn).not.toBeNull();
    expect(turn?.sec).toBe(3.5);
    expect(turn?.from).toBe('3-5');
    expect(turn?.to).toBe('4-5');
  });

  it('acha a virada do lado direito invertendo o placar', () => {
    const samples = [
      sample(0.5, 3, 5),
      sample(1.5, 3, 5),
      sample(2.5, 3, 5),
      sample(3.5, 3, 6),
      sample(4.5, 3, 6),
      sample(5.5, 3, 6),
      sample(6.5, 3, 6),
    ];
    const turn = scoreTurnSec(samples);
    expect(turn).not.toBeNull();
    expect(turn?.sec).toBe(3.5);
    expect(turn?.from).toBe('3-5');
    expect(turn?.to).toBe('3-6');
  });

  it('ignora leituras vazias (null) na contagem do placar antigo', () => {
    const samples = [
      sample(0.5, 3, 5),
      sample(1.5, null, 5),
      sample(2.5, 3, 5),
      sample(3.5, null, 5),
      sample(4.5, 3, 5),
      sample(5.5, 4, 5),
      sample(6.5, 4, 5),
      sample(7.5, 4, 5),
    ];
    const turn = scoreTurnSec(samples);
    expect(turn).not.toBeNull();
    expect(turn?.from).toBe('3-5');
    expect(turn?.to).toBe('4-5');
  });
});
