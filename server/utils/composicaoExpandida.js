/**
 * Expansão de BOM até artigos folha: quantidades agregadas por componente base.
 * @param {import('pg').Pool} pool
 * @param {number} rootId
 * @param {number} quantidadePedida
 * @returns {Promise<{ linhas: Array<{ item_id: number, codigo: string, descricao: string, unidadearmazenamento: string | null, quantidade_necessaria: number }>, tem_composicao: boolean }>}
 */
async function expandirComposicaoAteFolhas(pool, rootId, quantidadePedida) {
  const fetchFilhos = async (principalId) => {
    const { rows } = await pool.query(
      `
      SELECT ic.item_componente_id AS id,
             ic.quantidade_componente,
             i.codigo,
             i.descricao,
             i.unidadearmazenamento
      FROM itens_compostos ic
      INNER JOIN itens i ON i.id = ic.item_componente_id
      WHERE ic.item_principal_id = $1
      ORDER BY i.codigo
      `,
      [principalId]
    );
    return rows;
  };

  const raizFilhos = await fetchFilhos(rootId);
  if (raizFilhos.length === 0) {
    return { linhas: [], tem_composicao: false };
  }

  /** @type {Map<number, { item_id: number, codigo: string, descricao: string, unidadearmazenamento: string | null, quantidade_necessaria: number }>} */
  const agregado = new Map();

  const expandir = async (itemId, fator, caminho) => {
    if (caminho.has(itemId)) {
      const err = new Error('Composição circular (ciclo na estrutura de artigos compostos).');
      err.code = 'COMPOSICAO_CICLO';
      throw err;
    }
    caminho.add(itemId);
    try {
      const filhos = await fetchFilhos(itemId);
      if (filhos.length === 0) {
        return;
      }
      for (const ch of filhos) {
        const qPorUnidadePai = parseFloat(ch.quantidade_componente);
        const qNecessaria = (Number.isFinite(qPorUnidadePai) ? qPorUnidadePai : 0) * fator;
        if (qNecessaria <= 0) continue;
        const netos = await fetchFilhos(ch.id);
        if (netos.length === 0) {
          const prev = agregado.get(ch.id);
          const acum = (prev?.quantidade_necessaria || 0) + qNecessaria;
          agregado.set(ch.id, {
            item_id: ch.id,
            codigo: ch.codigo,
            descricao: ch.descricao,
            unidadearmazenamento: ch.unidadearmazenamento,
            quantidade_necessaria: acum
          });
        } else {
          await expandir(ch.id, qNecessaria, caminho);
        }
      }
    } finally {
      caminho.delete(itemId);
    }
  };

  await expandir(rootId, quantidadePedida, new Set());

  const linhas = Array.from(agregado.values()).sort((a, b) =>
    String(a.codigo || '').localeCompare(String(b.codigo || ''), 'pt', { sensitivity: 'base' })
  );

  return { linhas, tem_composicao: true };
}

module.exports = { expandirComposicaoAteFolhas };
