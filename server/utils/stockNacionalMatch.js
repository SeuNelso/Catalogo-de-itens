/**
 * Stock nacional (`armazens_item.armazem` texto da importação) ↔ armazém central (`armazens.descricao`).
 * Mesma lógica que `client/src/utils/stockNacionalArmazem.js` (manter alinhado).
 *
 * @param {{ armazem: string, quantidade: unknown }[]} armazensRows — linhas de um item
 * @param {{ descricao?: string }|null|undefined} armazem — usa-se só `descricao`
 * @returns {number|null}
 */
function quantidadeStockNacionalNoArmazem(armazensRows, armazem) {
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

  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a) continue;
    if (a === desc) return rowQty(row);
  }
  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a) continue;
    if (a.includes(desc)) return rowQty(row);
  }
  for (const row of armazensRows) {
    const a = norm(row.armazem);
    if (!a || a.length < 3) continue;
    if (desc.includes(a)) return rowQty(row);
  }

  return null;
}

module.exports = { quantidadeStockNacionalNoArmazem };
