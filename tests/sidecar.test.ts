import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClipSidecar,
  buildShortMarker,
  normalizeClipSidecar,
  normalizeShortMarker,
  omitNullFields,
  sidecarToAce,
  stringifyJsonWithoutNulls,
  updateClipSidecar,
  writeClipSidecar,
  writeShortMarker,
} from '../src/clipper/sidecar.js';
import type { AceEvent, KillEvent } from '../src/types.js';

const CLIP_START_MS = 1_700_000_000_000;

function v1Sidecar(): Record<string, unknown> {
  return {
    matchId: '2399851',
    event: 'IEM Rio 2026',
    team1: 'Legacy',
    team2: 'FURIA',
    map: 'unknown',
    round: 1,
    player: 'FalleN',
    clipStartMs: CLIP_START_MS,
    clipDurationSec: 32,
    clipFile: '2399851_Mirage_r1_FalleN.mp4',
    streamLatencyMs: 4200,
    startLatencyMs: 4200,
    latencySource: 'config',
    killVideoOffsetMs: 3000,
    summary: {
      round: 1,
      map: 'unknown',
      player: 'FalleN',
      team: '',
      opponents: 'Legacy vs FURIA',
      kills: [],
      victims: [],
      weapons: ['', '', '', ''],
      headshots: 0,
      assists: [],
      flashAssists: [],
      grenades: [],
      mainWeapon: '',
    },
    kills: [
      {
        killer: 'FalleN',
        victim: 's1mple',
        round: 1,
        map: 'Mirage',
        at: CLIP_START_MS + 5000,
        weapon: 'ak47',
        headshot: true,
      },
      {
        killer: 'FalleN',
        victim: 'ZywOo',
        round: 1,
        map: 'Mirage',
        at: CLIP_START_MS + 9000,
        weapon: '',
      },
    ],
  };
}

describe('sidecar v2: leitura do v1', () => {
  it('recupera o mapa da kill quando o summary veio como unknown', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.round.map).toBe('Mirage');
    expect(side.round.number).toBe(1);
  });

  it('não inventa time/oponente a partir do confronto', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.player.team).toBeNull();
    expect(side.player.opponent).toBeNull();
  });

  it('converte `at` em epoch ms e calcula a posição no vídeo', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.kills[0]?.atMs).toBe(CLIP_START_MS + 5000);
    // atMs + offset - clipStart = 8s dentro do clipe
    expect(side.kills[0]?.videoSec).toBeCloseTo(8, 3);
  });

  it('trata arma vazia como desconhecida (null), não string vazia', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.kills[0]?.weapon).toBe('ak47');
    expect(side.kills[1]?.weapon).toBeNull();
  });

  it('mantém headshot desconhecido como null nas stats', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.kills[1]?.headshot).toBeNull();
    expect(side.stats.headshots).toBe(1);
  });

  it('preserva a evidência aninhada do killfeed ao normalizar', () => {
    const side = normalizeClipSidecar({
      ...v1Sidecar(),
      sync: {
        mode: 'auto',
        applied: true,
        killfeed: {
          firstKillVideoMs: CLIP_START_MS + 1234,
          reason: 'confident',
          crop: '0.70:0.05:0.30:0.25',
          replayReads: 2,
        },
      },
    });
    expect(side.sync?.killfeed).toEqual({
      firstKillVideoMs: CLIP_START_MS + 1234,
      reason: 'confident',
      crop: '0.70:0.05:0.30:0.25',
      replayReads: 2,
    });
  });

  it('migra URL de VOD legado sem colocá-la em match.url', () => {
    const side = normalizeClipSidecar({
      ...v1Sidecar(),
      match: { url: 'https://www.youtube.com/watch?v=legacy' },
      vod: { url: 'https://www.youtube.com/watch?v=legacy' },
    });
    expect(side.match.url).toBe('https://www.hltv.org/matches/2399851');
    expect(side.vod?.url).toBe('https://www.youtube.com/watch?v=legacy');
  });

  it('lê a rejeição do OCR do v1 (ocrEndRejected)', () => {
    // O v1 gravava `ocrEndRejected`; o v2 usa `ocrRejected`. Sem a
    // ponte, o `diag:clip` perdia a rejeição e podia dar DISCARD errado.
    const side = normalizeClipSidecar({
      ...v1Sidecar(),
      ocrEndRejected: true,
      minEndMs: 1234,
    });
    expect(side.window?.end.ocrRejected).toBe(true);
  });

  it('normaliza a arma (backfill "m4a1_silencer" = live "m4a1silencer")', () => {
    const side = normalizeClipSidecar({
      ...v1Sidecar(),
      kills: [
        {
          killer: 'FalleN',
          victim: 's1mple',
          round: 1,
          map: 'Mirage',
          at: CLIP_START_MS + 5000,
          weapon: 'm4a1_silencer',
        },
      ],
    });
    expect(side.kills[0]?.weapon).toBe('m4a1silencer');
  });

  it('ausente de throughSmoke/wallbang/noscope fica null (nunca false)', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side.kills[0]?.throughSmoke).toBeNull();
    expect(side.kills[0]?.wallbang).toBeNull();
    expect(side.kills[0]?.noscope).toBeNull();
  });
});

describe('sidecar v2: escrita e round-trip', () => {
  const kills: KillEvent[] = [
    {
      killer: 'FalleN',
      victim: 's1mple',
      round: 1,
      map: 'Mirage',
      at: CLIP_START_MS + 5000,
      weapon: 'ak47',
      headshot: true,
    },
  ];
  const ace: AceEvent = {
    channelId: 'br',
    matchId: '2399851',
    map: 'Mirage',
    round: 1,
    player: 'FalleN',
    team1: 'Legacy',
    team2: 'FURIA',
    event: 'IEM Rio 2026',
    detectedAt: new Date(CLIP_START_MS).toISOString(),
    kills,
    clipStartMs: CLIP_START_MS,
    clipDurationSec: 32,
    summary: {
      round: 1,
      map: 'Mirage',
      player: 'FalleN',
      team: 'Legacy',
      opponents: 'FURIA',
      kills,
      victims: ['s1mple'],
      weapons: ['ak47'],
      headshots: 1,
      headshotsKnown: true,
      assists: [],
      flashAssists: [],
      grenades: [],
      mainWeapon: 'ak47',
    },
  };

  it('grava o schema v2 com time e oponente corretos', () => {
    const side = buildClipSidecar({
      ace,
      clip: {
        file: '2399851_Mirage_r1_FalleN.mp4',
        startMs: CLIP_START_MS,
        durationSec: 32,
        captureMode: 'muxed',
      },
      killVideoOffsetMs: 3000,
      team: 'Legacy',
      opponent: 'FURIA',
    });
    expect(side.schemaVersion).toBe(2);
    expect(side.kind).toBe('clip');
    expect(side.player.team).toBe('Legacy');
    expect(side.player.opponent).toBe('FURIA');
    expect(side.round.map).toBe('Mirage');
    expect(side.stats.killCount).toBe(1);
    expect(side.stats.mainWeapon).toBe('ak47');
  });

  it('sobrevive ao round-trip (v2 -> normalize -> v2)', () => {
    const side = buildClipSidecar({
      ace,
      clip: {
        file: '2399851_Mirage_r1_FalleN.mp4',
        thumbnailFile: '2399851_Mirage_r1_FalleN.jpg',
        startMs: CLIP_START_MS,
        durationSec: 32,
        captureMode: 'muxed',
        streamName: 'gaules',
      },
      killVideoOffsetMs: 3000,
      team: 'Legacy',
      opponent: 'FURIA',
    });
    const again = normalizeClipSidecar(JSON.parse(JSON.stringify(side)));
    expect(again.match.id).toBe('2399851');
    expect(again.player.name).toBe('FalleN');
    expect(again.player.team).toBe('Legacy');
    expect(again.player.opponent).toBe('FURIA');
    expect(again.round.map).toBe('Mirage');
    expect(again.clip.file).toBe('2399851_Mirage_r1_FalleN.mp4');
    expect(again.clip.thumbnailFile).toBe('2399851_Mirage_r1_FalleN.jpg');
    expect(again.clip.durationSec).toBe(32);
    expect(again.kills[0]?.videoSec).toBeCloseTo(8, 3);
    expect(again.stats.killCount).toBe(1);
  });

  it('preserva a kill estimada do OCR (appearEstimated) no round-trip', () => {
    // O script de VOD grava `appearEstimated`: sem copiar, a posição
    // estimada virava "medida" (timestamps da descrição e janela).
    const vodAce: AceEvent = {
      ...ace,
      kills: [
        {
          ...kills[0],
          appearEstimated: true,
          atVodSec: 12.5,
        },
      ],
    };
    const side = buildClipSidecar({
      ace: vodAce,
      clip: { file: 'vod.mp4', startMs: CLIP_START_MS, durationSec: 32, captureMode: 'vod' },
      vod: { url: null, startIso: null, atSec: 10, gameToVodDeltaSec: null, note: null },
    });
    expect(side.kills[0]?.estimated).toBe(true);
    const again = normalizeClipSidecar(JSON.parse(JSON.stringify(side)));
    expect(again.kills[0]?.estimated).toBe(true);
  });

  it('sidecarToAce devolve as kills com o relógio do placar', () => {
    const side = buildClipSidecar({
      ace,
      clip: { startMs: CLIP_START_MS, durationSec: 32 },
      killVideoOffsetMs: 3000,
      team: 'Legacy',
      opponent: 'FURIA',
    });
    const back = sidecarToAce(side);
    expect(back.player).toBe('FalleN');
    expect(back.kills[0]?.at).toBe(CLIP_START_MS + 5000);
    expect(back.summary?.team).toBe('Legacy');
    expect(back.summary?.opponents).toBe('FURIA');
    expect(back.summary?.headshots).toBe(1);
  });

  it('preserva URL da partida, origem do instante e vencedor do round', () => {
    const richAce: AceEvent = {
      ...ace,
      matchUrl: 'https://www.hltv.org/matches/2399851',
      scoreBefore: '6-6',
      scoreAfter: '6-7',
      // O vencedor vem de quem sabe (o VOD, pelo demo): o placar do
      // tracker é CT-T e não diz qual time estava no CT.
      roundWinner: 'FURIA',
      kills: [{ ...kills[0], atSource: 'placar' }],
    };
    const side = buildClipSidecar({
      ace: richAce,
      clip: { startMs: CLIP_START_MS, durationSec: 32 },
      killVideoOffsetMs: 3000,
    });
    expect(side.match.url).toBe('https://www.hltv.org/matches/2399851');
    expect(side.kills[0]?.atSource).toBe('placar');
    expect(side.round.winner).toBe('FURIA');
    const back = sidecarToAce(side);
    expect(back.matchUrl).toBe('https://www.hltv.org/matches/2399851');
    expect(back.kills[0]?.atSource).toBe('placar');
    expect(back.roundWinner).toBe('FURIA');
  });

  it('o placar do tracker é CT-T (e o vencedor NÃO é adivinhado)', () => {
    const side = buildClipSidecar({
      ace: {
        ...ace,
        scoreBefore: '6-6',
        scoreAfter: '6-7',
      },
      clip: { startMs: CLIP_START_MS, durationSec: 32 },
    });
    // A ordem do placar é a do tracker (CT-T): os times trocam de lado
    // no halftime, então o placar NÃO é team1-team2.
    expect(side.round.scoreOrder).toBe('ct-t');
    // Sem saber qual time estava no CT, o vencedor seria chute.
    expect(side.round.winner).toBeNull();
  });
});

describe('JSON dos artefatos: campos desconhecidos não viram null no disco', () => {
  it('remove null/undefined de objetos e preserva false, zero e string vazia', () => {
    const out = omitNullFields({
      known: false,
      zero: 0,
      empty: '',
      unknown: null,
      missing: undefined,
      nested: { value: null, kept: 'sim' },
    });
    expect(out).toEqual({
      known: false,
      zero: 0,
      empty: '',
      nested: { kept: 'sim' },
    });
  });

  it('preserva a posição de null dentro de arrays', () => {
    const out = omitNullFields({ weapons: ['ak47', null, 'm4'] });
    expect(out.weapons).toEqual(['ak47', null, 'm4']);
  });

  it('o JSON serializado não contém campos null', () => {
    const raw = stringifyJsonWithoutNulls({
      publication: { youtubeId: null, publishedAt: null, privacy: 'unlisted' },
      lastAttemptAt: null,
    });
    expect(raw).not.toContain(': null');
    expect(JSON.parse(raw)).toEqual({
      publication: { privacy: 'unlisted' },
    });
  });

  it('ausente e null explícito continuam iguais depois da leitura', () => {
    const withNull = normalizeShortMarker({
      schemaVersion: 2,
      kind: 'short',
      createdAt: new Date(CLIP_START_MS).toISOString(),
      source: {
        matchId: '1',
        map: 'Mirage',
        round: 1,
        player: 'x',
        clipStartMs: null,
        clipDurationSec: null,
      },
      short: { startSec: 0, kills: [] },
      metadata: null,
      publication: { youtubeId: null, publishedAt: null, privacy: null },
      attempts: 0,
      lastAttemptAt: null,
    });
    const withoutNull = normalizeShortMarker(
      JSON.parse(
        stringifyJsonWithoutNulls({
          schemaVersion: 2,
          kind: 'short',
          createdAt: new Date(CLIP_START_MS).toISOString(),
          source: {
            matchId: '1',
            map: 'Mirage',
            round: 1,
            player: 'x',
          },
          short: { startSec: 0, kills: [] },
          publication: {},
          attempts: 0,
        }),
      ),
    );
    expect(withoutNull).toEqual(withNull);
  });
});

describe('marker de Short: v1 -> v2', () => {
  it('separa o início do clipe-fonte do início do Short', () => {
    const marker = normalizeShortMarker({
      matchId: '2399851',
      map: 'Mirage',
      round: 1,
      player: 'FalleN',
      clipFile: 'short.mp4',
      sourceClip: '2399851_Mirage_r1_FalleN.mp4',
      clipStartMs: CLIP_START_MS + 4000,
      clipDurationSec: 32,
      sourceClipDurationSec: 32,
      shortWindow: {
        startSec: 4,
        endSec: 26,
        durSec: 22,
        includedKills: [0, 1],
        droppedKills: [],
      },
      captionInfo: { status: 'done' },
      youtubeId: 'u8uZfV8G7nI',
      publishedAt: new Date(CLIP_START_MS).toISOString(),
      attempts: 2,
      lastAttemptAt: new Date(CLIP_START_MS).toISOString(),
    });
    expect(marker).not.toBeNull();
    expect(marker?.kind).toBe('short');
    expect(marker?.source.clipFile).toBe('2399851_Mirage_r1_FalleN.mp4');
    expect(marker?.source.clipStartMs).toBe(CLIP_START_MS);
    expect(marker?.short.file).toBe('short.mp4');
    expect(marker?.short.startSec).toBe(4);
    expect(marker?.short.window?.includedKills).toEqual([0, 1]);
    expect(marker?.publication.youtubeId).toBe('u8uZfV8G7nI');
    expect(marker?.attempts).toBe(2);
    expect(marker?.short.captions).toEqual({ status: 'done' });
  });
});

describe('marker de Short: o spec do adesivo', () => {
  it('guarda o spec PEDIDO do adesivo (o `auto` resolve de novo)', () => {
    const marker = normalizeShortMarker({
      schemaVersion: 2,
      kind: 'short',
      createdAt: new Date(CLIP_START_MS).toISOString(),
      source: {
        matchId: '1',
        map: 'Dust2',
        round: 13,
        player: 'kyousuke',
      },
      short: {
        startSec: 0,
        kills: [],
        render: { overlayText: '5K DO KYOUSUKE', overlayHoldSec: 2 },
        overlaySpec: { text: 'auto', preset: 'gaules' },
      },
      metadata: null,
      publication: {},
      attempts: 0,
    });
    expect(marker?.short.overlaySpec).toEqual({ text: 'auto', preset: 'gaules' });
  });

  it('marker sem spec de adesivo fica null (não inventa)', () => {
    const marker = normalizeShortMarker({
      schemaVersion: 2,
      kind: 'short',
      createdAt: new Date(CLIP_START_MS).toISOString(),
      source: { matchId: '1', map: 'Dust2', round: 13, player: 'kyousuke' },
      short: { startSec: 0, kills: [] },
      metadata: null,
      publication: {},
      attempts: 0,
    });
    expect(marker?.short.overlaySpec).toBeNull();
  });
});

describe('sidecar v1 em disco: backup na 1ª migração', () => {
  it('guarda uma cópia .v1.bak antes de reescrever em v2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
    const file = path.join(dir, 'clip.json');
    // Sidecar v1 (flat, com campos que o v2 não modela).
    fs.writeFileSync(
      file,
      JSON.stringify({ ...v1Sidecar(), roundKills: [{ killer: 'FalleN' }] }),
      'utf8',
    );
    const ok = updateClipSidecar(file, (side) => {
      side.publication = { youtubeId: 'abc', publishedAt: null, thumbnailAi: false };
    });
    expect(ok).toBe(true);
    const backup = `${file}.v1.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    const original = JSON.parse(fs.readFileSync(backup, 'utf8'));
    expect(original.roundKills).toEqual([{ killer: 'FalleN' }]);
    // O arquivo migrado é v2.
    const migrated = normalizeClipSidecar(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(migrated?.schemaVersion).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('não sobrescreve um backup já existente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
    const file = path.join(dir, 'clip.json');
    fs.writeFileSync(file, JSON.stringify(v1Sidecar()), 'utf8');
    fs.writeFileSync(`${file}.v1.bak`, '{"original":true}', 'utf8');
    updateClipSidecar(file, () => undefined);
    expect(fs.readFileSync(`${file}.v1.bak`, 'utf8')).toBe('{"original":true}');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a escrita é atômica (nenhum .tmp sobrando) e o backup sai do v1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
    const file = path.join(dir, 'clip.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...v1Sidecar(), roundKills: [{ killer: 'FalleN' }] }),
      'utf8',
    );
    const side = normalizeClipSidecar(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(side).not.toBeNull();
    writeClipSidecar(file, side!);
    // O `.tmp` foi renomeado: não sobrou arquivo pela metade.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // O v1 original está guardado no backup.
    expect(fs.existsSync(`${file}.v1.bak`)).toBe(true);
    const original = JSON.parse(fs.readFileSync(`${file}.v1.bak`, 'utf8'));
    expect(original.roundKills).toEqual([{ killer: 'FalleN' }]);
    // E o arquivo gravado é o v2.
    const written = normalizeClipSidecar(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(written?.schemaVersion).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('o marker do Short também é escrito de forma atômica', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
    const file = path.join(dir, 'short.json');
    writeShortMarker(file, {
      schemaVersion: 2,
      kind: 'short',
      channelId: 'br',
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      source: {
        clipFile: 'clip.mp4',
        sidecarFile: 'clip.json',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        clipStartMs: CLIP_START_MS,
        clipDurationSec: 30,
      },
      short: {
        file: 'short.mp4',
        width: 1080,
        height: 1920,
        startSec: 0,
        durationSec: 30,
        window: null,
        kills: [],
        render: null,
        captions: { applied: false },
        overlaySpec: null,
      },
      metadata: { title: '', description: '', tags: [], source: 'template', privacy: 'private' },
      publication: { youtubeId: null, publishedAt: null, privacy: null },
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.short.file).toBe('short.mp4');
    expect(written.source.matchId).toBe('2399851');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('sidecar: as stats vêm das KILLS (o resumo do round é obsoleto)', () => {
  function aceWithKills(): AceEvent {
    const kills: KillEvent[] = [
      {
        killer: 'FalleN',
        victim: 's1mple',
        round: 1,
        map: 'Mirage',
        at: CLIP_START_MS + 5000,
        weapon: 'ak47',
        headshot: true,
      },
      {
        killer: 'FalleN',
        victim: 'ZywOo',
        round: 1,
        map: 'Mirage',
        at: CLIP_START_MS + 9000,
        weapon: 'awp',
      },
    ];
    return {
      channelId: 'br',
      matchId: '2399851',
      map: 'Mirage',
      round: 1,
      player: 'FalleN',
      team1: 'Legacy',
      team2: 'FURIA',
      event: 'IEM Rio 2026',
      detectedAt: new Date(CLIP_START_MS).toISOString(),
      kills,
      // O resumo foi calculado NO FECHAMENTO do round: não sabe da arma.
      summary: {
        round: 1,
        map: 'Mirage',
        player: 'FalleN',
        team: 'FURIA',
        opponents: 'Legacy',
        kills,
        victims: [],
        weapons: [],
        headshots: 0,
        assists: [],
        flashAssists: [],
        grenades: [],
        mainWeapon: '',
      },
    };
  }

  it('deriva armas, vítimas e headshots das kills', () => {
    const side = buildClipSidecar({
      ace: aceWithKills(),
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    expect(side.stats.weapons).toEqual(['ak47', 'awp']);
    expect(side.stats.victims).toEqual(['s1mple', 'ZywOo']);
    // O headshot veio da kill (1 de 2) — não do `summary.headshots` (0).
    expect(side.stats.headshots).toBe(1);
    expect(side.stats.mainWeapon).toBe('ak47');
  });

  it('o round-trip pela normalização mantém as stats derivadas', () => {
    const side = buildClipSidecar({
      ace: aceWithKills(),
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    const again = normalizeClipSidecar(JSON.parse(stringifyJsonWithoutNulls(side)));
    expect(again?.stats.weapons).toEqual(['ak47', 'awp']);
    expect(again?.stats.victims).toEqual(['s1mple', 'ZywOo']);
    expect(again?.stats.headshots).toBe(1);
  });
});

describe('sidecar: posição da kill no clipe vindo do VOD', () => {
  it('VOD sem epoch: videoSec = atVodSec − vod.atSec', () => {
    const side = buildClipSidecar({
      ace: {
        channelId: 'br',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        team1: 'Legacy',
        team2: 'FURIA',
        event: 'IEM Rio 2026',
        detectedAt: new Date(CLIP_START_MS).toISOString(),
        kills: [
          {
            killer: 'FalleN',
            victim: 's1mple',
            round: 1,
            map: 'Mirage',
            atVodSec: 135.5,
          },
        ],
      },
      clip: { file: 'clip.mp4', startMs: null, durationSec: 30 },
      vod: {
        url: 'https://youtu.be/x',
        startIso: null,
        atSec: 120,
        gameToVodDeltaSec: null,
        note: null,
      },
    });
    expect(side.kills[0].atVodSec).toBe(135.5);
    expect(side.kills[0].videoSec).toBeCloseTo(15.5, 5);
  });

  it('sem `vod.atSec` a posição continua desconhecida (não inventa)', () => {
    const side = buildClipSidecar({
      ace: {
        channelId: 'br',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        team1: 'Legacy',
        team2: 'FURIA',
        event: 'IEM Rio 2026',
        detectedAt: new Date(CLIP_START_MS).toISOString(),
        kills: [
          {
            killer: 'FalleN',
            victim: 's1mple',
            round: 1,
            map: 'Mirage',
            atVodSec: 135.5,
          },
        ],
      },
      clip: { file: 'clip.mp4', startMs: null, durationSec: 30 },
      vod: { url: null, startIso: null, atSec: null, gameToVodDeltaSec: null, note: null },
    });
    expect(side.kills[0].atVodSec).toBe(135.5);
    expect(side.kills[0].videoSec).toBeNull();
  });
});

describe('sidecar: confiança da âncora (diagnóstico da janela)', () => {
  const anchor = { joinedMidRound: true, resetThisRound: false, settleKills: 2 };

  it('o ace escreve a confiança no sidecar', () => {
    const side = buildClipSidecar({
      ace: {
        channelId: 'br',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        team1: 'Legacy',
        team2: 'FURIA',
        event: 'IEM Rio 2026',
        detectedAt: new Date(CLIP_START_MS).toISOString(),
        kills: [],
        anchorConfidence: anchor,
      },
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    expect(side.anchorConfidence).toEqual(anchor);
  });

  it('sobrevive ao round-trip (v2 -> normalize -> v2 -> ace)', () => {
    const side = buildClipSidecar({
      ace: {
        channelId: 'br',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        team1: 'Legacy',
        team2: 'FURIA',
        event: 'IEM Rio 2026',
        detectedAt: new Date(CLIP_START_MS).toISOString(),
        kills: [],
        anchorConfidence: anchor,
      },
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    const again = normalizeClipSidecar(JSON.parse(stringifyJsonWithoutNulls(side)));
    expect(again?.anchorConfidence).toEqual(anchor);
    expect(sidecarToAce(again!).anchorConfidence).toEqual(anchor);
  });

  it('ausente no sidecar v1 fica null (não inventa confiança)', () => {
    const side = normalizeClipSidecar(v1Sidecar());
    expect(side?.anchorConfidence).toBeNull();
  });
});

describe('marker de Short: belowMin no round-trip', () => {
  it('preserva belowMin:false no marker v2', () => {
    const marker = normalizeShortMarker({
      schemaVersion: 2,
      kind: 'short',
      short: {
        startSec: 0,
        kills: [],
        window: {
          startSec: 0,
          endSec: 60,
          durSec: 60,
          includedKills: [],
          droppedKills: [],
          belowMin: false,
          minSec: 60,
        },
      },
    });
    expect(marker?.short.window?.belowMin).toBe(false);
  });

  it('preserva belowMin:false no marker v1', () => {
    const marker = normalizeShortMarker({
      shortWindow: {
        startSec: 0,
        endSec: 60,
        durSec: 60,
        includedKills: [],
        droppedKills: [],
        belowMin: false,
        minSec: 60,
      },
    });
    expect(marker?.short.window?.belowMin).toBe(false);
  });

  it('ausência de belowMin continua ausente (marker legado)', () => {
    const marker = normalizeShortMarker({
      schemaVersion: 2,
      kind: 'short',
      short: {
        startSec: 0,
        kills: [],
        window: {
          startSec: 0,
          endSec: 60,
          durSec: 60,
          includedKills: [],
          droppedKills: [],
        },
      },
    });
    expect(marker?.short.window).not.toHaveProperty('belowMin');
  });
});

describe('sidecar e marker: canal', () => {
  const ace: AceEvent = {
    channelId: 'br',
    matchId: '2399851',
    map: 'Mirage',
    round: 1,
    player: 'FalleN',
    team1: 'Legacy',
    team2: 'FURIA',
    event: 'IEM Rio 2026',
    detectedAt: new Date(CLIP_START_MS).toISOString(),
    kills: [],
  };

  it('sidecar antigo sem channelId é do canal default (br)', () => {
    expect(normalizeClipSidecar(v1Sidecar()).channelId).toBe('br');
  });

  it('normaliza o channelId gravado (trim + minúsculo)', () => {
    expect(normalizeClipSidecar({ ...v1Sidecar(), channelId: ' EN ' }).channelId).toBe('en');
  });

  it('channelId inválido é erro (não vira br: o clipe EN iria para o BR)', () => {
    expect(() => normalizeClipSidecar({ ...v1Sidecar(), channelId: '???' })).toThrow(
      /channelId inválido/,
    );
  });

  it('buildClipSidecar grava o canal e sobrevive ao round-trip', () => {
    const side = buildClipSidecar({
      ace: { ...ace, channelId: 'en' },
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    expect(side.channelId).toBe('en');
    const again = normalizeClipSidecar(JSON.parse(JSON.stringify(side)));
    expect(again.channelId).toBe('en');
  });

  it('buildClipSidecar sem canal grava br (writer antigo)', () => {
    const side = buildClipSidecar({
      ace,
      clip: { file: 'clip.mp4', startMs: CLIP_START_MS, durationSec: 30 },
    });
    expect(side.channelId).toBe('br');
  });

  it('buildShortMarker grava o canal e o normalize o mantém', () => {
    const marker = buildShortMarker({
      channelId: 'en',
      source: {
        clipFile: 'clip.mp4',
        sidecarFile: 'clip.json',
        matchId: '2399851',
        map: 'Mirage',
        round: 1,
        player: 'FalleN',
        clipStartMs: CLIP_START_MS,
        clipDurationSec: 30,
      },
      short: {
        file: 'short.mp4',
        width: 1080,
        height: 1920,
        startSec: 0,
        durationSec: 30,
        window: {
          startSec: 0,
          endSec: 8,
          durSec: 8,
          includedKills: [],
          droppedKills: [],
          belowMin: true,
          minSec: 60,
        },
        kills: [],
        render: null,
        captions: null,
        overlaySpec: null,
      },
      metadata: null,
      publication: { youtubeId: null, publishedAt: null, privacy: null },
      attempts: 0,
      lastAttemptAt: null,
    });
    expect(marker.channelId).toBe('en');
    expect(marker.short.window).toMatchObject({ belowMin: true, minSec: 60 });
    const again = normalizeShortMarker(JSON.parse(JSON.stringify(marker)));
    expect(again?.channelId).toBe('en');
    expect(again?.short.window).toMatchObject({ belowMin: true, minSec: 60 });
  });

  it('buildShortMarker sem canal grava br; marker antigo lê br', () => {
    const marker = buildShortMarker({
      channelId: 'br',
      source: {
        clipFile: null,
        sidecarFile: null,
        matchId: '1',
        map: 'Dust2',
        round: 1,
        player: 'x',
        clipStartMs: null,
        clipDurationSec: null,
      },
      short: {
        file: null,
        width: null,
        height: null,
        startSec: 0,
        durationSec: null,
        window: null,
        kills: [],
        render: null,
        captions: null,
        overlaySpec: null,
      },
      metadata: null,
      publication: { youtubeId: null, publishedAt: null, privacy: null },
      attempts: 0,
      lastAttemptAt: null,
    });
    expect(marker.channelId).toBe('br');
    expect(
      normalizeShortMarker({ matchId: '1', map: 'Dust2', round: 1, player: 'x' })?.channelId,
    ).toBe('br');
  });
});
