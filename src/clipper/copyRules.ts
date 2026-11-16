/**
 * Regras de copy (texto de cara) do canal.
 *
 * As regras são do DONO e valem para adesivo, título, descrição e
 * legenda. Aqui mora só a parte pura: o texto entra, o texto corrigido
 * sai. Quem chama decide onde aplicar.
 */

/**
 * Mapas que a copy trata no FEMININO: "na Dust2", nunca "no Dust2".
 *
 * A lista é explícita de propósito: o português do dia a dia nem sempre
 * concorda com o nome do mapa ("no Inferno" é o natural), e uma regra
 * automática errada piora a frase. O dono escolhe o que entra aqui.
 * Dust2 e Mirage são femininos na copy do canal ("na Dust2", "na Mirage").
 *
 * "Dust 2" (com espaço) entra porque o VOD/OCR às vezes escreve assim.
 */
export const FEMININE_MAP_NAMES = ['dust2', 'dust ii', 'dust 2', 'mirage'] as const;

/** Mapa do nome canônico (sem acento/case) para o nome como aparece. */
const MAP_ALIASES: Record<string, string> = {
  dust2: 'Dust2',
  'dust ii': 'Dust II',
  'dust 2': 'Dust 2',
  mirage: 'Mirage',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Artigos (e contrações) que ficam ERRADOS antes de um mapa feminino.
 *
 * "Dust2" é feminino na copy do canal ("na Dust2"), então todo artigo
 * masculino que antecede o mapa precisa virar o feminino:
 * "no" → "na", "do" → "da", "o" → "a", "pelo" → "pela", "num" →
 * "numa" e "ao" → "à".
 */
const FEMININE_ARTICLES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'pelo', to: 'pela' },
  { from: 'num', to: 'numa' },
  { from: 'no', to: 'na' },
  { from: 'do', to: 'da' },
  { from: 'ao', to: 'à' },
  { from: 'o', to: 'a' },
];

/**
 * Mantém a caixa do artigo original na palavra substituta.
 *
 * "no" → "na", "No" → "Na", "NO" → "NA" (o mapa mantém a caixa que
 * estava: "NO DUST2" → "NA DUST2").
 *
 * Uma letra SOZINHA em caixa alta é início de frase ("No Dust2"), não
 * grito — daí o tratamento diferente de "NO".
 */
function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Corrige o artigo antes do mapa: "no Dust2" → "na Dust2".
 *
 * - "no mapa Dust2" continua "no mapa Dust2" (o artigo é do MAPA);
 * - "na Dust2" continua "na Dust2" (idempotente);
 * - "No Dust2" → "Na Dust2" (mantém a capitalização da frase);
 * - "NO DUST2" → "NA DUST2" (o mapa mantém a caixa que estava);
 * - "do/o/pelo/num/ao Dust2" → "da/a/pela/numa/à Dust2" (o mesmo mapa
 *   feminino com outro artigo).
 */
export function fixMapPrepositions(text: string): string {
  let out = String(text ?? '');
  const articlePattern = FEMININE_ARTICLES.map((a) => a.from).join('|');
  for (const [canonical, label] of Object.entries(MAP_ALIASES)) {
    const mapRe = escapeRegExp(canonical);
    const labelRe = escapeRegExp(label);
    // O artigo (e a contração) → a forma feminina, mas NÃO depois de
    // "mapa " (lá o artigo é do MAPA: "no mapa Dust2" está certo).
    out = out.replace(
      new RegExp(
        `\\b(${articlePattern})(\\s+)(?!(?:mapa\\s+))(${labelRe}|${mapRe})\\b`,
        'gi',
      ),
      (_full, article: string, space: string, map: string) => {
        const replacement =
          FEMININE_ARTICLES.find((a) => a.from === article.toLowerCase())?.to ??
          article;
        return `${matchCase(article, replacement)}${space}${map}`;
      },
    );
  }
  return out;
}

/**
 * O mapa com o artigo certo: "na Dust2", "no Inferno".
 *
 * POR QUE: o `fixMapPrepositions` só sabe corrigir "no Dust2" → "na
 * Dust2" (e afins). Um template que escreve "dominou o Dust2" escapava
 * da correção — e "o Dust2" está errado. Aqui mora a escolha do
 * artigo; quem escreve a frase usa esta função.
 */
export function mapWithArticle(map: string): string {
  const raw = String(map ?? '').trim();
  if (!raw) return raw;
  const canonical = raw.toLowerCase();
  const feminine = (FEMININE_MAP_NAMES as readonly string[]).includes(canonical);
  return feminine ? `na ${raw}` : `no ${raw}`;
}
