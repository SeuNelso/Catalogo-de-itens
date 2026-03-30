/**
 * Stock nacional por armazém vem de `armazens_item.armazem` (texto da importação).
 * A correspondência é feita pela **descrição** do armazém de origem (`armazens.descricao`),
 * comparada com o texto guardado em cada linha de stock nacional.
 * (Espelho no servidor: `server/utils/stockNacionalMatch.js` — manter a mesma lógica.)
 *
 * @param {{ armazem: string, quantidade: number }[]} armazensRows
 * @param {{ descricao?: string }} armazem — armazém central escolhido (usa-se só `descricao`)
 * @returns {number | null} quantidade ou null se não houver correspondência
 */
export function quantidadeStockNacionalNoArmazem(armazensRows, armazem) {
  if (!armazem || !Array.isArray(armazensRows) || armazensRows.length === 0) return null;

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\u0300-\u036f/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const desc = norm(armazem.descricao);
  if (!desc) return null;

  const rowQty = (row) => {
    const q = Number(row.quantidade);
    return Number.isFinite(q) ? q : 0;
  };

  // 1) Igualdade exacta (texto da importação = descrição do armazém)
  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a) continue;
    if (a === desc) return rowQty(row);
  }

  // 2) Coluna do Excel pode incluir código ou prefixo — a descrição aparece no texto
  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a) continue;
    if (a.includes(desc)) return rowQty(row);
  }

  // 3) Descrição completa no cadastro contém o rótulo mais curto da importação (casos raros)
  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a || a.length < 3) continue;
    if (desc.includes(a)) return rowQty(row);
  }

  return null;
}
