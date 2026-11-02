import { beforeEach, describe, expect, it } from 'vitest';
import type { AceEvent, KillEvent } from '../src/types.js';
import {
  buildHashtags,
  buildMetadataContext,
  buildShortTitle,
  buildTags,
  buildTemplateDescription,
  buildTemplateTitle,
  buildVideoMetadata,
  buildVideoMetadataSafe,
  composeDescription,
  DESCRIPTION_MAX_BYTES,
  joinDescription,
  resetTemplateRotation,
  resetUsedTitles,
  sanitizeDescription,
  sanitizeTitle,
  SHORTS_DESCRIPTION_MAX_BYTES,
  SHORTS_TITLE_MAX,
  shortenTitleForShorts,
  truncateUtf8,
  utf8Length,
  validateDescription,
  validateTitle,
} from '../src/uploader/videoMetadata.js';

function makeKills(count: number, weapon = 'ak47'): KillEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    killer: 'donk',
    victim: `vitor${i}`,
    round: 12,
    map: 'Mirage',
    weapon,
    headshot: i < 2,
    flashAssistBy: i === 0 ? 'flashy' : undefined,
  }));
}

function makeAce(overrides: Partial<AceEvent> = {}): AceEvent {
  const kills = overrides.kills ?? makeKills(5);
  return {
    matchId: '2399745',
    map: 'Mirage',
    round: 12,
    player: 'donk',
    team1: 'Spirit',
    team2: 'MOUZ',
    event: 'PGL Masters Bucharest',
    detectedAt: '2026-10-27T16:48:50.654Z',
    kills,
    score: '3-6',
    ...overrides,
  };
}

describe('contexto dos metadados', () => {
  it('extrai só os fatos do round', () => {
    const ctx = buildMetadataContext(makeAce());
    expect(ctx.kills).toBe(5);
    expect(ctx.label).toBe('ACE');
    expect(ctx.headshots).toBe(2);
    expect(ctx.mainWeapon).toBe('AK-47');
    expect(ctx.matchup).toBe('Spirit vs MOUZ');
    expect(ctx.feed).toHaveLength(5);
    expect(ctx.flashAssists).toEqual(['flashy']);
  });

  it('aceita sidecar sem summary (usa os kills do topo)', () => {
    const ctx = buildMetadataContext(makeAce({ summary: undefined }));
    expect(ctx.kills).toBe(5);
    expect(ctx.headshots).toBe(2);
  });

  it('sabe o rival quando o time do jogador é conhecido', () => {
    const ace = makeAce({
      summary: {
        round: 12,
        map: 'Mirage',
        player: 'donk',
        team: 'Spirit',
        opponents: 'MOUZ',
        kills: makeKills(5),
        victims: [],
        weapons: [],
        headshots: 2,
        assists: [],
        flashAssists: [],
        grenades: [],
        mainWeapon: 'ak47',
      },
    });
    const ctx = buildMetadataContext(ace);
    expect(ctx.rival).toBe('MOUZ');
    expect(ctx.team).toBe('Spirit');
  });
});

describe('título determinístico', () => {
  beforeEach(() => {
    resetTemplateRotation();
    resetUsedTitles();
  });

  it('respeita os limites e cita jogador + evento', () => {
    const ctx = buildMetadataContext(makeAce());
    const title = buildTemplateTitle(ctx);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toContain('donk');
    expect(title.toLowerCase()).toContain('pgl');
    expect(validateTitle(title, ctx).ok).toBe(true);
  });

  it('varia entre clipes do mesmo jogador', () => {
    const titles = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const ctx = buildMetadataContext(makeAce({ round: 12 + i }));
      titles.add(buildTemplateTitle(ctx));
    }
    expect(titles.size).toBeGreaterThanOrEqual(5);
  });

  it('nunca sai com 2 emojis nem com hashtag', () => {
    const ctx = buildMetadataContext(makeAce());
    const title = buildTemplateTitle(ctx);
    expect((title.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []).length).toBeLessThanOrEqual(1);
    expect(title).not.toContain('#');
  });
});

describe('descrição determinística', () => {
  it('conta o round, põe hashtags e respeita a privacidade', () => {
    const ctx = buildMetadataContext(makeAce());
    const desc = buildTemplateDescription(ctx, { privacy: 'unlisted', brand: '5K CS' });
    expect(desc).toContain('donk');
    expect(desc).toContain('#cs2');
    expect(desc).toContain('#5kcs');
    expect(desc).toContain('não listado');
    expect(desc).not.toContain('Publicado como privado');
    expect(desc.length).toBeLessThanOrEqual(5000);
    expect(validateDescription(desc, ctx).ok).toBe(true);
  });

  it('no modo privado mantém o aviso de publicação privada', () => {
    const ctx = buildMetadataContext(makeAce());
    const desc = buildTemplateDescription(ctx, { privacy: 'private' });
    expect(desc).toContain('Publicado como privado');
  });

  it('hashtags não duplicam e são curtas', () => {
    const ctx = buildMetadataContext(makeAce());
    const tags = buildHashtags(ctx, '5K CS').split(' ');
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBeLessThanOrEqual(10);
  });

  it('tem abertura, linha de contexto, lista de eliminações, stats, hashtags e rodapé', () => {
    const ctx = buildMetadataContext(makeAce());
    const desc = buildTemplateDescription(ctx, { privacy: 'unlisted' });
    expect(desc).toContain('PGL Masters Bucharest');
    expect(desc).toContain('Round 12 | Mirage | Spirit vs MOUZ | Placar 3-6');
    expect(desc).toContain('matou vitor0');
    expect(desc).toContain('5 kills');
    expect(desc).toContain('#mirage');
    expect(
      desc
        .trim()
        .endsWith(
          'Corte automático no Mirage. Vídeo não listado: aparece só para quem tem o link.',
        ),
    ).toBe(true);
  });

  it('marca o tempo de cada eliminação quando o clipe tem âncora', () => {
    const ace = makeAce({
      kills: [
        { killer: 'donk', victim: 'a', round: 12, map: 'Mirage', at: 1_000_000 },
        { killer: 'donk', victim: 'b', round: 12, map: 'Mirage', at: 1_065_000 },
      ],
    });
    const ctx = buildMetadataContext(ace, 1_000_000);
    const desc = buildTemplateDescription(ctx);
    expect(desc).toContain('0:00 matou a');
    expect(desc).toContain('1:05 matou b');
  });

  it('soma o offset placar→vídeo (o `at` é a observação no placar)', () => {
    // O `at` da kill é o momento em que o PLACAR do HLTV mostrou o kill;
    // no vídeo gravado ele aparece depois (latência da stream − atraso
    // do placar). O offset alinha o timestamp com o que está na tela.
    const ace = makeAce({
      kills: [
        { killer: 'donk', victim: 'a', round: 12, map: 'Mirage', at: 1_010_000 },
        { killer: 'donk', victim: 'b', round: 12, map: 'Mirage', at: 1_075_000 },
      ],
    });
    const ctx = buildMetadataContext(ace, 1_000_000, undefined, 20_000);
    const desc = buildTemplateDescription(ctx);
    expect(desc).toContain('0:30 matou a');
    expect(desc).toContain('1:35 matou b');
  });

  it('kill fora do clipe fica SEM timestamp (não inventa "0:00")', () => {
    // Kill antes do início do clipe: o horário seria mentira ("0:00 matou
    // X" para algo que está antes do vídeo). A linha sai sem timestamp.
    const ace = makeAce({
      kills: [{ killer: 'donk', victim: 'a', round: 12, map: 'Mirage', at: 900_000 }],
    });
    const ctx = buildMetadataContext(ace, 1_000_000, undefined, 10_000);
    expect(ctx.feed[0].timeSec).toBeUndefined();
    expect(buildTemplateDescription(ctx)).toContain('matou a');
    expect(buildTemplateDescription(ctx)).not.toContain('0:00 matou a');
  });

  it('kill depois do fim do clipe fica SEM timestamp', () => {
    const ace = makeAce({
      kills: [{ killer: 'donk', victim: 'a', round: 12, map: 'Mirage', at: 1_100_000 }],
    });
    const ctx = buildMetadataContext(ace, 1_000_000, 30, 0);
    expect(ctx.feed[0].timeSec).toBeUndefined();
  });

  it('sem âncora não inventa timestamp', () => {
    const ctx = buildMetadataContext(makeAce());
    const desc = buildTemplateDescription(ctx);
    expect(desc).not.toMatch(/\d:\d\d matou/);
  });
});

describe('guarda anti-alucinação', () => {
  const ctx = buildMetadataContext(makeAce());

  it('rejeita contagem de kills contraditória', () => {
    const check = validateTitle('donk fez 3 kills no Mirage | PGL Masters Bucharest', ctx);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('kills');
  });

  it('rejeita contagem de kills em português', () => {
    expect(validateTitle('donk fez 3 abates no Mirage | PGL Masters Bucharest', ctx).ok).toBe(
      false,
    );
    expect(validateTitle('donk fez 4 eliminações no Mirage | PGL Masters Bucharest', ctx).ok).toBe(
      false,
    );
    expect(validateDescription('donk marcou 5 abates no Mirage.', ctx).ok).toBe(true);
  });

  it('não confunde número/nick com contagem de kills', () => {
    // Regressão: o regex sem bordas casava "2026 Kyiv" (2026 + K) e
    // "Techno4K" (4 + K) como contagem de kills e derrubava o texto.
    expect(
      validateTitle('donk 5 kills no Mirage | PGL Masters Bucharest 2026 Kyiv', ctx).ok,
    ).toBe(true);
    expect(validateTitle('donk 5 kills no Mirage | Techno4K Spirit', ctx).ok).toBe(true);
    expect(validateDescription('donk fez 5 kills em 2026 Kyiv com o Spirit.', ctx).ok).toBe(true);
  });

  it('rejeita ace com menos de 5 kills', () => {
    const four = buildMetadataContext(makeAce({ kills: makeKills(4) }));
    const check = validateTitle('donk fez ACE no Mirage | PGL Masters Bucharest', four);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('ace');
  });

  it('rejeita clutch, 1vX e spoiler de resultado', () => {
    expect(validateTitle('donk clutch no Mirage | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk 1v3 no Mirage | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk venceu no Mirage | PGL Masters Bucharest', ctx).ok).toBe(false);
  });

  it('rejeita headshot e placar divergentes', () => {
    expect(validateTitle('donk com 4 headshots no Mirage | PGL Masters Bucharest', ctx).ok).toBe(
      false,
    );
    expect(validateTitle('donk fez 5 kills no Mirage 9-1 | PGL Masters Bucharest', ctx).ok).toBe(
      false,
    );
  });

  it('rejeita título sem o jogador ou sem evento/time', () => {
    expect(validateTitle('5 kills no Mirage | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk fez 5 kills no Mirage', ctx).ok).toBe(false);
  });

  it('rejeita URL, hashtag, quebra de linha e emoji fora da lista', () => {
    expect(validateTitle('donk 5 kills https://x.com | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk 5 kills #cs2 | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk 5 kills\nno Mirage | PGL Masters Bucharest', ctx).ok).toBe(false);
    expect(validateTitle('donk 5 kills no Mirage | PGL Masters Bucharest 🍕', ctx).ok).toBe(false);
  });

  it('rejeita rival quando não sabemos o lado do jogador', () => {
    expect(
      validateTitle('donk 5 kills contra MOUZ | PGL Masters Bucharest', ctx).ok,
    ).toBe(false);
    expect(
      validateTitle('donk destruiu MOUZ no Mirage | PGL Masters Bucharest', ctx).ok,
    ).toBe(false);
  });

  it('aceita rival quando o time do jogador é conhecido', () => {
    const known = buildMetadataContext(
      makeAce({
        summary: {
          round: 12,
          map: 'Mirage',
          player: 'donk',
          team: 'Spirit',
          opponents: 'MOUZ',
          kills: makeKills(5),
          victims: [],
          weapons: [],
          headshots: 2,
          assists: [],
          flashAssists: [],
          grenades: [],
          mainWeapon: 'ak47',
        },
      }),
    );
    expect(
      validateTitle('donk destruiu MOUZ no Mirage | PGL Masters Bucharest', known).ok,
    ).toBe(true);
  });

  it('aceita o título determinístico como válido', () => {
    expect(validateTitle('donk fez 5 kills no Mirage | PGL Masters Bucharest R12', ctx).ok).toBe(
      true,
    );
  });
});

describe('sanitização', () => {
  it('remove URL, hashtag, aspas e quebra de linha do título', () => {
    const title = sanitizeTitle('"donk" 5 kills\nno Mirage https://x.com #cs2');
    expect(title).not.toContain('https');
    expect(title).not.toContain('#');
    expect(title).not.toContain('"');
    expect(title).not.toContain('\n');
  });

  it('mantém no máximo 1 emoji da lista e corta em 100 caracteres', () => {
    const title = sanitizeTitle('donk 🔥 5 kills no Mirage 💥 | PGL Masters ' + 'x'.repeat(120));
    expect(title.length).toBeLessThanOrEqual(100);
    expect((title.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('remove emoji da descrição', () => {
    expect(sanitizeDescription('donk fez 5 kills 🔥 no Mirage')).not.toContain('🔥');
  });

  it('não deixa o variation selector (U+FE0F) no texto', () => {
    // O seletor de emoji não cobre o VS16: ele sobrevivia ao replace.
    expect(sanitizeTitle('donk 🔥 5 kills')).not.toContain('\uFE0F');
    expect(sanitizeDescription('donk fez 5 kills ❗️ no Mirage')).not.toContain('\uFE0F');
  });

  it('remove < e > (o YouTube rejeita título/descrição com eles)', () => {
    expect(sanitizeTitle('donk <Mirage> 5 kills')).not.toMatch(/[<>]/);
    expect(sanitizeDescription('donk <Mirage> 5 kills')).not.toMatch(/[<>]/);
  });

  it('corta a descrição no limite de BYTES do YouTube (acentos valem 2)', () => {
    const desc = sanitizeDescription('á'.repeat(3000));
    expect(utf8Length(desc)).toBeLessThanOrEqual(5000);
    expect(desc.length).toBeLessThan(3000);
  });

  it('truncateUtf8 corta na fronteira do caractere multibyte', () => {
    // 'á' = 2 bytes: cortar em 3 bytes não pode entregar metade do
    // caractere (o YouTube rejeita UTF-8 inválido).
    const cortado = truncateUtf8('ááá', 3);
    expect(utf8Length(cortado)).toBeLessThanOrEqual(3);
    expect(cortado).toBe('á');
    expect(cortado.includes('\uFFFD')).toBe(false);
  });

  it('truncateUtf8 em byte inteiro não perde caractere', () => {
    expect(truncateUtf8('abcde', 3)).toBe('abc');
    expect(truncateUtf8('abcde', 0)).toBe('');
  });
});

describe('buildVideoMetadata', () => {
  beforeEach(() => {
    resetTemplateRotation();
    resetUsedTitles();
  });

  it('usa o título da IA quando ele passa pela guarda', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk dominou o round 12 no Mirage com 5 kills.',
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('ai');
    expect(meta.provider).toBe('gemini');
    expect(meta.title).toContain('donk');
  });

  it('cai no determinístico quando a IA alucina', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk fez 3 kills e levou o clutch! | PGL Masters'],
        opening: 'donk fez 3 kills no Mirage.',
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('template');
    expect(meta.title).toContain('donk');
  });

  it('cai no determinístico quando a IA falha ou devolve lixo', async () => {
    const broken = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => {
        throw new Error('timeout');
      },
    });
    expect(broken.source).toBe('template');
    expect(broken.reason).toContain('timeout');
    const junk = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({ titles: [], opening: '' }),
    });
    expect(junk.source).toBe('template');
  });

  it('mantém o título da IA e troca só a descrição quando ela é inválida', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk fez 5 kills e venceu o round!',
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('ai');
    expect(meta.title).toContain('donk');
    expect(meta.description).not.toContain('venceu');
  });

  it('a descrição da IA recebe hashtags e rodapé', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      privacy: 'unlisted',
      brand: '5K CS',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk abriu o round no Mirage e ditou 5 eliminações seguidas.',
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('ai');
    expect(meta.description).toContain('donk abriu o round');
    expect(meta.description).toContain('#cs2');
    expect(meta.description).toContain('#5kcs');
    expect(meta.description).toContain('não listado');
  });

  it('descarta título da IA que nomeia rival desconhecido', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk 5 kills contra MOUZ | PGL Masters Bucharest'],
        opening: 'donk fez 5 kills no Mirage.',
        provider: 'gemini',
      }),
    });
    expect(meta.title).not.toContain('MOUZ');
    expect(meta.title).toContain('donk');
    expect(validateTitle(meta.title, buildMetadataContext(makeAce())).ok).toBe(true);
  });

  it('não repete o mesmo título em clipes seguidos', async () => {
    const ai = async () => ({
      titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥', 'donkdominou o Mirage | PGL Masters'],
      opening: 'donk fez 5 kills no Mirage.',
      provider: 'gemini',
    });
    const first = await buildVideoMetadata(makeAce(), { mode: 'ai', ai });
    const second = await buildVideoMetadata(makeAce({ round: 13 }), { mode: 'ai', ai });
    expect(first.title).not.toBe(second.title);
  });

  it('no modo template não chama a IA', async () => {
    let called = false;
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'template',
      ai: async () => {
        called = true;
        return { titles: ['x'], opening: 'y' };
      },
    });
    expect(called).toBe(false);
    expect(meta.source).toBe('template');
  });

  it('mantém a URL do CTA (o sanitize não pode comê-la)', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'template',
      cta: 'Inscreva-se: https://youtube.com/@canal',
    });
    expect(meta.description).toContain('https://youtube.com/@canal');
  });

  it('CTA com URL e número não derruba a descrição da IA', async () => {
    // O CTA é config do dono (pode ter link e número): a guarda anti-
    // alucinação olha o texto da IA, não o rodapé.
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      cta: 'Inscreva-se: https://youtube.com/@canal (10k inscritos)',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk dominou o round 12 no Mirage com 5 kills.',
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('ai');
    expect(meta.description).toContain('donk dominou o round');
    expect(meta.description).toContain('https://youtube.com/@canal');
    expect(meta.description).toContain('10k inscritos');
  });

  it('rodapé com < ou > não derruba a descrição (o YouTube rejeita)', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'template',
      cta: 'Siga o canal -> <5K CS>',
    });
    expect(meta.description).not.toContain('<');
    expect(meta.description).not.toContain('>');
    expect(meta.description).toContain('Siga o canal');
  });

  it('abertura truncada cai no determinístico (resposta da IA cortada)', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk dominou o round 12 no Mirage com 5 kills e',
        truncated: true,
        provider: 'gemini',
      }),
    });
    // O título da IA é aproveitado; a descrição vai para o template.
    expect(meta.source).toBe('ai');
    expect(meta.title).toContain('donk');
    expect(meta.description).not.toContain('dominou o round 12 no Mirage com 5 kills e');
    expect(meta.reason).toContain('abertura truncada');
  });

  it('abertura truncada que termina em frase é aceita', async () => {
    const meta = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      ai: async () => ({
        titles: ['donk 5 KILLS no Mirage — PGL Masters 🔥'],
        opening: 'donk dominou o round 12 no Mirage com 5 kills.',
        truncated: true,
        provider: 'gemini',
      }),
    });
    expect(meta.source).toBe('ai');
    expect(meta.description).toContain('donk dominou o round');
  });
});

describe('buildVideoMetadataSafe (falha na composição não impede o upload)', () => {
  it('devolve undefined (caminho legado) quando a composição estoura', async () => {
    // Exceção na composição (aqui: um getter que quebra no summary) —
    // antes ela derrubava o upload inteiro e o clipe ficava local.
    const broken = makeAce({
      summary: {
        get kills(): never {
          throw new Error('sidecar quebrado');
        },
      } as unknown as AceEvent['summary'],
    });
    const meta = await buildVideoMetadataSafe(broken, { mode: 'template' });
    expect(meta).toBeUndefined();
  });

  it('composição normal devolve os metadados', async () => {
    const meta = await buildVideoMetadataSafe(makeAce(), { mode: 'template' });
    expect(meta?.title).toContain('donk');
  });
});

describe('rodapé tem prioridade quando falta espaço', () => {
  it('o corpo cede e o CTA sobrevive', () => {
    const ctx = buildMetadataContext(makeAce());
    const desc = composeDescription('ABERTURA QUE NAO CABE EM LUGAR NENHUM', ctx, {
      cta: 'CTA'.repeat(2000),
    });
    expect(utf8Length(desc)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(desc).toContain('CTA');
    expect(desc).not.toContain('ABERTURA QUE NAO CABE');
  });
});

describe('tags', () => {
  it('inclui jogador, mapa e evento sem estourar os limites', () => {
    const ctx = buildMetadataContext(makeAce());
    const tags = buildTags(ctx, ['cs2', 'ace', '5k']);
    expect(tags).toContain('donk');
    expect(tags).toContain('Mirage');
    expect(tags).toContain('PGL Masters Bucharest');
    expect(tags.length).toBeLessThanOrEqual(30);
    expect(tags.join('').length).toBeLessThanOrEqual(500);
  });

  it('corta tag longa e respeita o total de 500 (com as vírgulas)', () => {
    const ctx = buildMetadataContext(
      makeAce({ event: 'ESL Pro League Season 21 - Group Stage' }),
    );
    const tags = buildTags(ctx, []);
    for (const tag of tags) expect(tag.length).toBeLessThanOrEqual(30);
    expect(tags.join(',').length).toBeLessThanOrEqual(500);
  });

  it('descarta tag padrão que contradiz a contagem de kills', () => {
    const ctx = buildMetadataContext(makeAce({ kills: makeKills(4) }));
    const tags = buildTags(ctx, ['cs2', 'ace', '5k', 'highlights']);
    expect(tags).not.toContain('ace');
    expect(tags).not.toContain('5k');
    expect(tags).toContain('cs2');
    expect(tags).toContain('highlights');
    expect(tags).toContain('4k');
  });

  it('no Shorts entra a tag "shorts"', () => {
    const ctx = buildMetadataContext(makeAce());
    const tags = buildTags(ctx, ['cs2'], { shorts: true });
    expect(tags).toContain('shorts');
  });
});

describe('formato Shorts (vertical 9:16)', () => {
  it('o título curto cabe em 70 chars e cita jogador + evento', () => {
    const ctx = buildMetadataContext(makeAce());
    const title = buildShortTitle(ctx);
    expect(title.length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    expect(validateTitle(title, ctx).ok).toBe(true);
  });

  it('o título curto usa o evento quando ele cabe em 70 chars', () => {
    const ctx = buildMetadataContext(
      makeAce({ event: 'ESL Pro League Season 21 - Group Stage' }),
    );
    const title = buildShortTitle(ctx);
    expect(title.length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    expect(title).toContain('donk');
    // O evento cabe (~67 chars): ele é a âncora escolhida.
    expect(title).toContain('ESL Pro League');
    expect(validateTitle(title, ctx).ok).toBe(true);
  });

  it('quando o evento não cabe, o título cai na âncora do time', () => {
    const ctx = buildMetadataContext(
      makeAce({
        event: 'Torneio com um nome de evento absurdamente comprido que jamais cabe em 70 caracteres',
        summary: {
          round: 12,
          map: 'Mirage',
          player: 'donk',
          team: 'Spirit',
          opponents: 'MOUZ',
          kills: makeKills(5),
          victims: makeKills(5).map((k) => k.victim),
          weapons: makeKills(5).map(() => 'ak47'),
          headshots: 2,
          assists: [],
          flashAssists: [],
          grenades: [],
          mainWeapon: 'AK-47',
        },
      }),
    );
    const title = buildShortTitle(ctx);
    expect(title.length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    expect(title).toContain('donk');
    expect(title).not.toContain('Torneio com um nome');
    // A âncora do time entra no lugar do evento.
    expect(title).toMatch(/Spirit|MOUZ/);
    expect(validateTitle(title, ctx).ok).toBe(true);
  });

  it('o título curto continua válido com nome e evento gigante', () => {
    const ctx = buildMetadataContext(
      makeAce({
        player: 'nome-de-jogador-muito-comprido-de-verdade',
        event: 'Torneio com um nome comprido demais para caber em um titulo curto',
      }),
    );
    const title = buildShortTitle(ctx);
    expect(title.length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    expect(validateTitle(title, ctx).ok).toBe(true);
  });

  it('o título da IA é encurtado para o limite do Short', () => {
    const ctx = buildMetadataContext(makeAce());
    const long = 'donk faz 5 kills no Mirage com uma mira absurda no PGL Masters Bucharest 💥';
    const short = shortenTitleForShorts(long, ctx);
    expect(short).not.toBeNull();
    expect((short ?? '').length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    expect(validateTitle(short ?? '', ctx).ok).toBe(true);
  });

  it('a descrição do Short tem #Shorts e cabe em 1000 bytes', () => {
    const ctx = buildMetadataContext(makeAce());
    const description = composeDescription('donk dominou o round com 5 eliminações.', ctx, {
      format: 'shorts',
      privacy: 'public',
      brand: '5K',
    });
    expect(description).toContain('#Shorts');
    expect(utf8Length(description)).toBeLessThanOrEqual(SHORTS_DESCRIPTION_MAX_BYTES);
    // No Short a lista de eliminações com timestamp não entra.
    expect(description).not.toContain('matou vitor');
  });

  it('#Shorts e o rodapé sobrevivem a um corpo enorme', () => {
    const ctx = buildMetadataContext(makeAce());
    const description = composeDescription('palavra '.repeat(400), ctx, {
      format: 'shorts',
      privacy: 'unlisted',
      brand: '5K',
      cta: 'Assine o canal: youtube.com/@5kcsgo',
    });
    expect(utf8Length(description)).toBeLessThanOrEqual(SHORTS_DESCRIPTION_MAX_BYTES);
    expect(description).toContain('#Shorts');
    expect(description).toContain('Assine o canal');
  });

  it('joinDescription: a hashtag fixada nunca é cortada pelo corpo enorme', () => {
    const out = joinDescription('palavra '.repeat(400), 'rodapé do dono', 1000, ['#Shorts']);
    expect(utf8Length(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain('#Shorts');
    expect(out).toContain('rodapé do dono');
    // A hashtag fica no FIM (é a prioridade depois do rodapé).
    expect(out.trim().endsWith('#Shorts')).toBe(true);
  });

  it('joinDescription: quando não cabe o rodapé inteiro, a hashtag sobrevive', () => {
    const out = joinDescription('corpo', 'x'.repeat(1200), 1000, ['#Shorts']);
    expect(utf8Length(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain('#Shorts');
  });

  it('joinDescription: sem hashtag fixada, o rodapé continua prioritário', () => {
    const out = joinDescription('palavra '.repeat(400), 'rodapé do dono', 1000);
    expect(utf8Length(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain('rodapé do dono');
  });

  it('o vídeo longo continua com a lista de eliminações', () => {
    const ctx = buildMetadataContext(makeAce());
    const description = composeDescription('donk dominou o round com 5 eliminações.', ctx, {
      format: 'standard',
      privacy: 'public',
    });
    expect(description).toContain('matou vitor');
    expect(description).not.toContain('#Shorts');
  });

  it('o título da IA longo não vira título de Short (cai no determinístico)', async () => {
    resetUsedTitles();
    const ctx = buildMetadataContext(makeAce());
    const metadata = await buildVideoMetadata(makeAce(), {
      mode: 'ai',
      format: 'shorts',
      ai: async () => ({
        titles: [
          'donk faz um ACE inacreditavel no Mirage contra o MOUZ no PGL Masters Bucharest 💥',
        ],
        opening: 'donk pegou 5 eliminações seguidas no Mirage.',
      }),
    });
    expect(metadata.title.length).toBeLessThanOrEqual(SHORTS_TITLE_MAX);
    // O título tem que ser VÁLIDO (citando jogador + âncora), não só curto.
    expect(validateTitle(metadata.title, ctx).ok).toBe(true);
    expect(metadata.title).toContain('donk');
    expect(metadata.description).toContain('#Shorts');
  });
});
