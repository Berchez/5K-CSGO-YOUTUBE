import { describe, expect, it } from 'vitest';
import {
  sqlDateTime,
  startOfDayInTimeZone,
  startOfDaySql,
  timeZoneOffsetMs,
} from '../src/timeZone.js';

describe('timeZone (dia de cota)', () => {
  it('acha o início do dia no Pacífico (a cota zera lá, não em UTC)', () => {
    // 2026-11-14T00:30Z = 13/11 16:30 em Los Angeles.
    const instant = new Date('2026-11-14T00:30:00.000Z');
    const start = startOfDayInTimeZone(instant, 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-11-13T08:00:00.000Z');
  });

  it('o dia UTC já virou, mas o dia do Pacífico ainda é o anterior', () => {
    const instant = new Date('2026-11-14T02:00:00.000Z');
    expect(startOfDaySql(instant, 'UTC')).toBe('2026-11-14 00:00:00');
    expect(startOfDaySql(instant, 'America/Los_Angeles')).toBe('2026-11-13 08:00:00');
  });

  it('meio-dia no Pacífico é o mesmo dia local', () => {
    const instant = new Date('2026-11-14T20:00:00.000Z');
    expect(startOfDaySql(instant, 'America/Los_Angeles')).toBe('2026-11-14 08:00:00');
  });

  it('o deslocamento do fuso muda com o horário de verão', () => {
    // Inverno ( PST = UTC-8) e verão ( PDT = UTC-7).
    expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/Los_Angeles')).toBe(
      -8 * 3600_000,
    );
    expect(timeZoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/Los_Angeles')).toBe(
      -7 * 3600_000,
    );
  });

  it('o deslocamento ignora a fração de segundo do instante', () => {
    // Sem truncar, o offset saía "menos os ms" (-8h - 678ms).
    expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00.678Z'), 'America/Los_Angeles')).toBe(
      -8 * 3600_000,
    );
  });

  it('formata a data no formato do SQLite (UTC, sem milissegundos)', () => {
    expect(sqlDateTime(new Date('2026-11-14T03:04:05.678Z'))).toBe('2026-11-14 03:04:05');
  });

  it('funciona com fuso à frente do UTC (Japão)', () => {
    const instant = new Date('2026-11-13T23:00:00.000Z');
    expect(startOfDaySql(instant, 'Asia/Tokyo')).toBe('2026-11-13 15:00:00');
  });
});
