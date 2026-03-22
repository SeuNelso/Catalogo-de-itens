/**
 * Cadastro em lote: itens_nao_cadastrados → itens + armazens_item (quantidades do stock nacional).
 */

/**
 * @param {object|Array|string|null|undefined} armazensRaw — JSON do import (objeto nome→qtd ou array {nome, quantidade})
 * @returns {{ totalQtd: number, pairs: Array<[string, number]> }}
 */
function parseArmazensStockNacional(armazensRaw) {
  let armazens = armazensRaw;
  if (armazens == null) {
    return { totalQtd: 0, pairs: [] };
  }
  if (typeof armazens === 'string') {
    try {
      armazens = JSON.parse(armazens);
    } catch {
      return { totalQtd: 0, pairs: [] };
    }
  }
  const pairs = [];
  let totalQtd = 0;

  if (Array.isArray(armazens)) {
    for (const a of armazens) {
      if (!a || typeof a !== 'object') continue;
      const nome = String(a.nome ?? a.armazem ?? a.name ?? '').trim();
      const q = Math.round(Number(a.quantidade ?? a.qtd ?? 0)) || 0;
      if (nome) {
        pairs.push([nome, q]);
        totalQtd += q;
      }
    }
  } else if (typeof armazens === 'object') {
    for (const [armNome, qtd] of Object.entries(armazens)) {
      const nome = String(armNome || '').trim();
      if (!nome) continue;
      const q = Math.round(Number(qtd)) || 0;
      pairs.push([nome, q]);
      totalQtd += q;
    }
  }

  return { totalQtd, pairs };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ codigo: string, descricao: string|null, armazens?: unknown }} row
 */
async function cadastrarUmItemNaoCadastrado(client, row) {
  const codigo = String(row.codigo || '').trim();
  const descricao = String(row.descricao || '').trim();
  if (!codigo) {
    throw new Error('Código vazio');
  }
  if (!descricao) {
    throw new Error(`Descrição obrigatória (${codigo})`);
  }

  const dup = await client.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
  if (dup.rows.length > 0) {
    throw new Error(`Código já cadastrado: ${codigo}`);
  }

  const { totalQtd, pairs } = parseArmazensStockNacional(row.armazens);

  const ins = await client.query(
    `INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, comprimento, largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, ativo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      descricao,
      descricao,
      'Sem categoria',
      codigo,
      null,
      totalQtd,
      null,
      null,
      '',
      '',
      null,
      null,
      null,
      '',
      '',
      '',
      '',
      '',
      true,
    ]
  );
  const itemId = ins.rows[0].id;

  for (const [armNome, qtd] of pairs) {
    await client.query(
      'INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ($1, $2, $3)',
      [itemId, armNome, qtd]
    );
  }

  await client.query('DELETE FROM itens_nao_cadastrados WHERE codigo = $1', [codigo]);
  return { itemId, codigo };
}

/**
 * @param {import('pg').Pool} pool
 */
async function cadastrarTodosItensNaoCadastrados(pool) {
  const listRes = await pool.query(`
    SELECT inc.id, inc.codigo, inc.descricao, inc.armazens
    FROM itens_nao_cadastrados inc
    WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.codigo = inc.codigo)
    ORDER BY inc.data_importacao DESC
  `);

  const rows = listRes.rows;
  const ok = [];
  const falhas = [];

  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await cadastrarUmItemNaoCadastrado(client, row);
      await client.query('COMMIT');
      ok.push(r);
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* sem transação activa */
      }
      falhas.push({
        codigo: row.codigo,
        erro: e.message || String(e),
      });
    } finally {
      client.release();
    }
  }

  return {
    message:
      falhas.length === 0
        ? `Cadastrados ${ok.length} item(ns).`
        : `Cadastrados ${ok.length} item(ns); ${falhas.length} falha(s).`,
    cadastrados: ok.length,
    totalProcessados: rows.length,
    sucesso: ok,
    falhas,
  };
}

module.exports = {
  parseArmazensStockNacional,
  cadastrarUmItemNaoCadastrado,
  cadastrarTodosItensNaoCadastrados,
};
