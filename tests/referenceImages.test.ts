import { describe, expect, it } from 'vitest';
import {
  parseHltvTeamLinks,
  parseOgImage,
  pickAllmodeFile,
  pickTitle,
  infoboxToAllmodeName,
  parseLogosSectionFiles,
  parseGalleryFiles,
  removeCornerBackground,
} from '../src/clipper/referenceImages.js';

describe('pickTitle', () => {
  it('prefere match exato', () => {
    expect(pickTitle('donk', ['Donk', 'Team Spirit'])).toBe('Donk');
  });

  it('resolve time com prefixo "Team"', () => {
    expect(pickTitle('Spirit', ['Donk', 'Team Spirit'], true)).toBe('Team Spirit');
  });

  it('team: "Team X" vence ANTES do exato "X" (páginas homônimas são outro time)', () => {
    // regressão real: busca "Spirit" trouxe a página "Spirit" (outro time)
    // e o logo errado foi baixado. Team-prefix tem prioridade.
    expect(pickTitle('Spirit', ['Spirit', 'Team Spirit'], true)).toBe('Team Spirit');
    expect(pickTitle('Spirit', ['Team Spirit', 'Team Spirit Academy'], true)).toBe('Team Spirit');
  });

  it('cai para prefixo e depois primeiro resultado', () => {
    expect(pickTitle('donk', ['Donk at IEM', 'Team Spirit'])).toBe('Donk at IEM');
    expect(pickTitle('zywoo', ['ZywOo', 'ZywOo 2024'])).toBe('ZywOo');
  });

  it('lista vazia retorna null', () => {
    expect(pickTitle('x', [])).toBeNull();
  });
});

describe('pickAllmodeFile', () => {
  const files = [
    'Team Spirit full allmode.png',
    'Team Spirit 2016 allmode.png',
    'Team Spirit Academy allmode.png',
    'Team Spirit 2022 full lightmode.png',
    'Chopper Team Spirit 2022.png',
  ];
  it('prefere o allmode exato/full do time (ícone quadrado do HLTV)', () => {
    expect(pickAllmodeFile(files, 'Team Spirit')).toBe('Team Spirit full allmode.png');
  });
  it('ignora academy e arquivos sem allmode', () => {
    const only = ['Team Spirit Academy allmode.png', 'Team Spirit 2022 full lightmode.png'];
    expect(pickAllmodeFile(only, 'Team Spirit')).toBe('Team Spirit Academy allmode.png');
  });
  it('com só allmodes de ano, pega o ano mais alto', () => {
    const years = ['Team Spirit 2016 allmode.png', 'Team Spirit 2021 allmode.png'];
    expect(pickAllmodeFile(years, 'Team Spirit')).toBe('Team Spirit 2021 allmode.png');
  });
  it('desambigua homônimos: Falcons Esports (CS) vence Atlanta/Bad News', () => {
    const files = [
      'Falcons Esports full allmode.png',
      'Bad News Falcons allmode.png',
      'Riyadh Falcons allmode.png',
      'Atlanta Falcons allmode.png',
      'Falcons Esports 2021 allmode.png',
    ];
    expect(pickAllmodeFile(files, 'Falcons')).toBe('Falcons Esports full allmode.png');
  });

  it('rejeita homônimo com prefixo estranho mesmo com score alto', () => {
    // sem "Falcons Esports" na lista, o "Green Hope High School Falcons"
    // (full, score 3) NÃO pode vencer o "Team Falcons 2022" — prefixo mata.
    const files = [
      'Green Hope High School Falcons full allmode.png',
      'Team Falcons 2022 allmode.png',
    ];
    expect(pickAllmodeFile(files, 'Falcons')).toBe('Team Falcons 2022 allmode.png');
  });

  it('simetria gaming/esports: ano desempatam (caso real Aurora)', () => {
    // regressão real: "Aurora esports allmode.png" (2022, era/org antiga)
    // vencia a logo vigente da Aurora Gaming porque só "esports" pontuava.
    expect(
      pickAllmodeFile(['Aurora esports 2022 allmode.png', 'Aurora Gaming 2024 allmode.png'], 'Aurora'),
    ).toBe('Aurora Gaming 2024 allmode.png');
    expect(
      pickAllmodeFile(['Aurora esports 2024 allmode.png', 'Aurora Gaming 2023 allmode.png'], 'Aurora'),
    ).toBe('Aurora esports 2024 allmode.png');
  });

  it('empate: nome mais curto vence (Aurora Gaming > Aurora esports)', () => {
    expect(
      pickAllmodeFile(['Aurora esports allmode.png', 'Aurora Gaming allmode.png'], 'Aurora'),
    ).toBe('Aurora Gaming allmode.png');
  });

  it('sem allmode retorna null', () => {
    expect(pickAllmodeFile(['Team Spirit 2022 full lightmode.png'], 'Team Spirit')).toBeNull();
  });
});

describe('infoboxToAllmodeName', () => {
  it('converte wordmark full light/darkmode no allmode da mesma era', () => {
    expect(infoboxToAllmodeName('Team Falcons 2022 full lightmode.png')).toBe(
      'Team Falcons 2022 allmode.png',
    );
    expect(infoboxToAllmodeName('Team Spirit 2022 full darkmode.png')).toBe(
      'Team Spirit 2022 allmode.png',
    );
  });

  it('sem sufixo de modo: inalterado (inclui allmode já pronto)', () => {
    expect(infoboxToAllmodeName('Team X allmode.png')).toBe('Team X allmode.png');
    // regressão real: infobox da Aurora Gaming já é allmode — usar direto,
    // sem derivação (antes caía no commons e pegava logo de 2022).
    expect(infoboxToAllmodeName('Aurora Gaming 2025 full allmode.png')).toBe(
      'Aurora Gaming 2025 full allmode.png',
    );
  });
});

describe('parseLogosSectionFiles', () => {
  it('extrai lightmodes em ordem (última = mais recente)', () => {
    const wikitext = `==Logos==
{{Gallery
|{{Json|lightmode=Team Spirit.png|darkmode=Team Spirit.png|caption=Original logo}}
|{{Json|lightmode=Team Spirit 2016.png|darkmode=Team Spirit 2016.png|caption=Second logo}}
|{{Json|lightmode=Team Spirit 2021 lightmode.png|darkmode=Team Spirit 2021 darkmode.png|caption=Third logo}}
}}
==References==`;
    const files = parseLogosSectionFiles(wikitext);
    expect(files).toEqual([
      'Team Spirit.png',
      'Team Spirit 2016.png',
      'Team Spirit 2021 lightmode.png',
    ]);
  });

  it('gallery sem Json: pega linhas arquivo|caption', () => {
    const wikitext = `==Logos==
<gallery mode="packed" heights="200px">
Falcons Esports 2020 allmode.png|Original logo
Falcons Esports 2021 allmode.png|2nd logo
</gallery>
==References==`;
    expect(parseLogosSectionFiles(wikitext)).toEqual([
      'Falcons Esports 2020 allmode.png',
      'Falcons Esports 2021 allmode.png',
    ]);
  });

  it('sem seção Logos retorna vazio', () => {
    expect(parseLogosSectionFiles('==Overview==\nNada aqui')).toEqual([]);
  });
});

describe('removeCornerBackground', () => {
  it('remove o fundo do canto preservando o interior do logo', async () => {
    const sharp = (await import('sharp')).default;
    // 8x8: fundo branco, quadrado vermelho 4x4 no centro
    const raw = Buffer.alloc(8 * 8 * 3, 255);
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) {
        const i = (y * 8 + x) * 3;
        raw[i] = 200;
        raw[i + 1] = 30;
        raw[i + 2] = 30;
      }
    }
    const png = await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } })
      .png()
      .toBuffer();
    const out = await removeCornerBackground(png);
    const { data, info } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    // canto: transparente
    expect(data[3]).toBe(0);
    // centro do logo: opaco e vermelho preservado
    const c = (4 * 8 + 4) * 4;
    expect(data[c + 3]).toBe(255);
    expect(data[c]).toBe(200);
  });
});

describe('parseGalleryFiles', () => {
  it('extrai fotos da seção Gallery (formato Arquivo|caption)', () => {
    const wikitext = `==Gear and Settings==
nada
==Gallery==
<gallery mode="packed-hover" heights="200px">
Donk at BLAST Open Spring 2025.jpg|donk at BLAST Open Spring 2025 with Team Spirit
Donk 2025 Team Spirit.jpeg|donk with Team Spirit in January 2025
Donk at ESL Pro League S20.jpg|donk at ESL Pro League Season 20
</gallery>
==References==`;
    const files = parseGalleryFiles(wikitext);
    expect(files).toEqual([
      'Donk at BLAST Open Spring 2025.jpg',
      'Donk 2025 Team Spirit.jpeg',
      'Donk at ESL Pro League S20.jpg',
    ]);
  });

  it('sem seção Gallery retorna vazio', () => {
    expect(parseGalleryFiles('==Overview==\nNada')).toEqual([]);
  });
});

describe('parseHltvTeamLinks', () => {
  it('extrai links únicos de /team/<id>/<slug>', () => {
    const html = `
      <a href="/team/7020/spirit">Spirit</a>
      <a href="/team/7020/spirit">Spirit dup</a>
      <a href="/team/11283/falcons">Falcons</a>
      <a href="/player/11893/zywoo">player não conta</a>
    `;
    const links = parseHltvTeamLinks(html);
    expect(links).toEqual([
      { id: '7020', slug: 'spirit' },
      { id: '11283', slug: 'falcons' },
    ]);
  });

  it('html sem times retorna vazio', () => {
    expect(parseHltvTeamLinks('<p>nada</p>')).toEqual([]);
  });
});

describe('parseOgImage', () => {
  it('extrai og:image content', () => {
    const html = `<meta property="og:image" content="https://img-cdn.hltv.org/teamlogo/abc.png?w=800&s=1">`;
    expect(parseOgImage(html)).toBe('https://img-cdn.hltv.org/teamlogo/abc.png?w=800&s=1');
  });

  it('sem og:image retorna null', () => {
    expect(parseOgImage('<meta property="og:title" content="x">')).toBeNull();
  });
});
