/**
 * Defesa em profundidade contra SQL injection em fragmentos dinâmicos:
 * identificadores SQL (nomes de colunas, ORDER BY) nunca devem vir de input direto —
 * apenas de mapas estáticos (whitelist).
 */

/** Colunas permitidas para ordenação em GET /api/itens (prefixo i.) */
const ITENS_ORDER_BY_COLUMN = {
  codigo: 'i.codigo',
  nome: 'i.nome',
  quantidade: 'i.quantidade',
  familia: 'i.familia',
  subfamilia: 'i.subfamilia',
  categoria: 'i.categoria',
};

/**
 * @param {string} [sortOrder] query sortOrder
 * @returns {'ASC'|'DESC'}
 */
function sqlOrderDirection(sortOrder) {
  return String(sortOrder || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
}

/**
 * Cláusula ORDER BY para listagem de itens (com JOIN a itens_setores).
 * @param {string} [sortBy]
 * @param {string} [sortOrder]
 * @returns {string} fragmento SQL completo incluindo ORDER BY
 */
function buildItensListOrderByClause(sortBy, sortOrder) {
  const dir = sqlOrderDirection(sortOrder);
  if (sortBy === 'setor') {
    return `ORDER BY STRING_AGG(DISTINCT is2.setor, ', ') ${dir}`;
  }
  const col = ITENS_ORDER_BY_COLUMN[sortBy];
  if (col) {
    return `ORDER BY ${col} ${dir}`;
  }
  return `ORDER BY 
      (i.codigo ~ '^[0-9]') DESC,
      i.codigo ASC,
      i.ordem_importacao ASC, 
      i.data_cadastro DESC`;
}

module.exports = {
  buildItensListOrderByClause,
  sqlOrderDirection,
  ITENS_ORDER_BY_COLUMN,
};
