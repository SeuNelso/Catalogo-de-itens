const { STOCK_STATUS } = require('./loteStatus');
const { logStockMovimento } = require('./auditoria');
const { quantidadeStockNacionalNoArmazem } = require('../../utils/stockNacionalMatch');

const ITENS_NACIONAL_CACHE_TTL_MS = 20000;
const itensNacionalPorArmazemCache = new Map();

async function localizacaoExisteNoArmazem(db, { armazemId, localizacao }) {
  const armId = Number(armazemId || 0);
  const loc = String(localizacao || '').trim();
  if (!armId || !loc) return false;
  const q = await db.query(
    `SELECT 1
     FROM armazens_localizacoes
     WHERE armazem_id = $1
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM($2::text))
     LIMIT 1`,
    [armId, loc]
  );
  return q.rows.length > 0;
}

async function cadastroManualStock(client, body, usuarioId) {
  const itemIdBody = Number(body?.item_id || 0) || null;
  const artigoCodigo = String(body?.artigo_codigo || '').trim();
  const armazemId = Number(body?.armazem_id || 0) || null;
  const localizacao = String(body?.localizacao || '').trim();
  const modo = String(body?.modo || 'serial').trim().toLowerCase();
  const serialnumber = String(body?.serialnumber || '').trim().toUpperCase();
  const lote = String(body?.lote || '').trim().toUpperCase() || null;
  const caixaCodigo = String(body?.caixa_codigo || '').trim();
  const quantidadeLote = Number(body?.quantidade || 0);

  if (!armazemId) {
    const err = new Error('armazem_id é obrigatório.');
    err.status = 400;
    throw err;
  }
  if (!localizacao) {
    const err = new Error('localizacao é obrigatória.');
    err.status = 400;
    throw err;
  }
  if (!['serial', 'lote'].includes(modo)) {
    const err = new Error('modo inválido. Use serial ou lote.');
    err.status = 400;
    throw err;
  }
  if (modo === 'serial' && !serialnumber) {
    const err = new Error('serialnumber é obrigatório.');
    err.status = 400;
    throw err;
  }
  if (modo === 'lote' && !lote) {
    const err = new Error('lote é obrigatório.');
    err.status = 400;
    throw err;
  }
  if (modo === 'lote' && (!Number.isFinite(quantidadeLote) || quantidadeLote <= 0)) {
    const err = new Error('quantidade é obrigatória para lote e deve ser maior que zero.');
    err.status = 400;
    throw err;
  }
  if (!itemIdBody && !artigoCodigo) {
    const err = new Error('item_id ou artigo_codigo é obrigatório.');
    err.status = 400;
    throw err;
  }

  const locExists = await localizacaoExisteNoArmazem(client, { armazemId, localizacao });
  if (!locExists) {
    const err = new Error(`Localização "${localizacao}" não existe no armazém ${armazemId}.`);
    err.status = 400;
    throw err;
  }

  let itemId = itemIdBody;
  let itemCodigo = artigoCodigo;
  let itemDescricao = '';
  if (!itemId) {
    const itemQ = await client.query(
      'SELECT id, codigo, descricao FROM itens WHERE UPPER(TRIM(codigo::text)) = UPPER(TRIM($1::text)) LIMIT 1',
      [artigoCodigo]
    );
    if (!itemQ.rows.length) {
      const err = new Error('Artigo não encontrado.');
      err.status = 404;
      throw err;
    }
    itemId = Number(itemQ.rows[0].id);
    itemCodigo = String(itemQ.rows[0].codigo || artigoCodigo);
    itemDescricao = String(itemQ.rows[0].descricao || '');
  } else {
    const itemQ = await client.query('SELECT id, codigo, descricao FROM itens WHERE id = $1 LIMIT 1', [
      itemId,
    ]);
    if (!itemQ.rows.length) {
      const err = new Error('Item não encontrado.');
      err.status = 404;
      throw err;
    }
    itemCodigo = String(itemQ.rows[0].codigo || artigoCodigo);
    itemDescricao = String(itemQ.rows[0].descricao || '');
  }

  let responseRow;
  if (modo === 'serial') {
    const serialUpsert = await client.query(
      `INSERT INTO stock_serial (item_id, armazem_id, localizacao, serialnumber, lote, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (item_id, serialnumber)
       DO UPDATE SET
         armazem_id = EXCLUDED.armazem_id,
         localizacao = EXCLUDED.localizacao,
         lote = COALESCE(NULLIF(EXCLUDED.lote,''), stock_serial.lote),
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id, item_id, armazem_id, localizacao, serialnumber, lote, status`,
      [itemId, armazemId, localizacao, serialnumber, lote, STOCK_STATUS.DISPONIVEL]
    );

    let caixaId = null;
    if (caixaCodigo) {
      const caixaQ = await client.query(
        `INSERT INTO stock_caixas (codigo_caixa, item_id, armazem_id, localizacao, status, criado_por_usuario_id)
         VALUES ($1,$2,$3,$4,'fechada',$5)
         ON CONFLICT (codigo_caixa)
         DO UPDATE SET
           item_id = EXCLUDED.item_id,
           armazem_id = EXCLUDED.armazem_id,
           localizacao = EXCLUDED.localizacao,
           atualizado_em = CURRENT_TIMESTAMP
         RETURNING id`,
        [caixaCodigo, itemId, armazemId, localizacao, usuarioId || null]
      );
      caixaId = Number(caixaQ.rows[0]?.id || 0) || null;
      if (caixaId) {
        await client.query(
          `INSERT INTO stock_caixa_seriais (caixa_id, stock_serial_id)
           VALUES ($1,$2)
           ON CONFLICT (stock_serial_id) DO NOTHING`,
          [caixaId, serialUpsert.rows[0].id]
        );
      }
    }

    await logStockMovimento({
      db: client,
      tipo: 'cadastro_serial_manual',
      itemId,
      armazemId,
      localizacao,
      lote,
      serialnumber,
      quantidade: 1,
      caixaId,
      usuarioId: usuarioId || null,
      payload: { caixa: caixaCodigo || null, origem: 'cadastro-manual', modo },
    });

    responseRow = {
      id: serialUpsert.rows[0].id,
      tipo: 'serial',
      item_id: itemId,
      item_codigo: itemCodigo,
      item_descricao: itemDescricao,
      armazem_id: armazemId,
      localizacao,
      serialnumber,
      lote,
      quantidade: 1,
      status: serialUpsert.rows[0].status,
      caixa_codigo: caixaCodigo || null,
    };
  } else {
    const loteUpsert = await client.query(
      `INSERT INTO stock_lote (item_id, armazem_id, localizacao, lote, quantidade_disponivel)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (item_id, armazem_id, localizacao, lote)
       DO UPDATE SET
         quantidade_disponivel = stock_lote.quantidade_disponivel + EXCLUDED.quantidade_disponivel,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id, item_id, armazem_id, localizacao, lote, quantidade_disponivel`,
      [itemId, armazemId, localizacao, lote, quantidadeLote]
    );

    await logStockMovimento({
      db: client,
      tipo: 'cadastro_lote_manual',
      itemId,
      armazemId,
      localizacao,
      lote,
      quantidade: quantidadeLote,
      usuarioId: usuarioId || null,
      payload: { origem: 'cadastro-manual', modo },
    });

    responseRow = {
      id: loteUpsert.rows[0].id,
      tipo: 'lote',
      item_id: itemId,
      item_codigo: itemCodigo,
      item_descricao: itemDescricao,
      armazem_id: armazemId,
      localizacao,
      serialnumber: null,
      lote,
      quantidade: Number(loteUpsert.rows[0].quantidade_disponivel || quantidadeLote),
      status: 'disponivel',
      caixa_codigo: null,
    };
  }
  return responseRow;
}

async function listMeusArmazensStock(pool, user, { isAdminRole }) {
  if (isAdminRole && isAdminRole(user?.role)) {
    const all = await pool.query(
      `SELECT a.id, a.codigo, a.descricao, a.tipo,
              (
                SELECT al.localizacao
                FROM armazens_localizacoes al
                WHERE al.armazem_id = a.id
                  AND LOWER(COALESCE(al.tipo_localizacao, '')) = 'recebimento'
                ORDER BY al.id
                LIMIT 1
              ) AS localizacao_recebimento
       FROM armazens a
       WHERE a.ativo = true
         AND LOWER(TRIM(COALESCE(a.tipo, ''))) IN ('central', 'apeado', 'apeados')
       ORDER BY a.codigo ASC, a.descricao ASC`
    );
    return all.rows || [];
  }
  const ids = Array.isArray(user?.requisicoes_armazem_origem_ids)
    ? user.requisicoes_armazem_origem_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
    : [];
  if (!ids.length) return [];
  const rows = await pool.query(
    `SELECT a.id, a.codigo, a.descricao, a.tipo,
            (
              SELECT al.localizacao
              FROM armazens_localizacoes al
              WHERE al.armazem_id = a.id
                AND LOWER(COALESCE(al.tipo_localizacao, '')) = 'recebimento'
              ORDER BY al.id
              LIMIT 1
            ) AS localizacao_recebimento
     FROM armazens a
     WHERE a.id = ANY($1::int[])
       AND LOWER(TRIM(COALESCE(a.tipo, ''))) IN ('central', 'apeado', 'apeados')
     ORDER BY a.codigo ASC, a.descricao ASC`,
    [ids]
  );
  return rows.rows || [];
}

async function listItensNacionalPorArmazem(pool, { armazemId, q, limit, offset }) {
  const armazemRes = await pool.query(
    `SELECT id, codigo, descricao FROM armazens WHERE id = $1 LIMIT 1`,
    [armazemId]
  );
  if (!armazemRes.rows.length) {
    const err = new Error('Armazém não encontrado.');
    err.status = 404;
    throw err;
  }
  const armazemRef = armazemRes.rows[0];
  const cacheKey = `${armazemId}::${q}`;
  const cached = itensNacionalPorArmazemCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= ITENS_NACIONAL_CACHE_TTL_MS) {
    const totalCached = cached.rows.length;
    return {
      total: totalCached,
      limit,
      offset,
      rows: cached.rows.slice(offset, offset + limit),
      suggestions: cached.suggestions,
      cached: true,
    };
  }

  const armazemDescricao = String(armazemRef?.descricao || '').trim();
  if (!armazemDescricao) {
    return { total: 0, limit, offset, rows: [], suggestions: [] };
  }

  const aiRows = await pool.query(
    `SELECT ai.item_id, ai.armazem, ai.quantidade::float AS quantidade
     FROM armazens_item ai
     WHERE (
       UPPER(TRIM(ai.armazem)) = UPPER(TRIM($1::text))
       OR UPPER(TRIM(ai.armazem)) LIKE UPPER(TRIM($2::text))
       OR (
         LENGTH(TRIM(COALESCE(ai.armazem, ''))) >= 3
         AND UPPER(TRIM($3::text)) LIKE ('%' || UPPER(TRIM(ai.armazem)) || '%')
       )
     )
     ORDER BY ai.item_id`,
    [armazemDescricao, `%${armazemDescricao}%`, armazemDescricao]
  );
  const byItem = new Map();
  for (const row of aiRows.rows || []) {
    const itemId = Number(row.item_id);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push({ armazem: row.armazem, quantidade: row.quantidade });
  }
  const itemIds = [...byItem.keys()];
  if (!itemIds.length) {
    return { total: 0, limit, offset, rows: [], suggestions: [] };
  }

  const itensRes = await pool.query(
    `SELECT id, codigo, descricao
     FROM itens
     WHERE id = ANY($1::int[])
       AND ativo = true
       ${q ? `AND (LOWER(COALESCE(codigo, '')) LIKE $2 OR LOWER(COALESCE(descricao, '')) LIKE $2)` : ''}`,
    q ? [itemIds, `%${q}%`] : [itemIds]
  );

  let rows = (itensRes.rows || []).map((it) => {
    const armazensRows = byItem.get(Number(it.id)) || [];
    const qtd = quantidadeStockNacionalNoArmazem(armazensRows, armazemRef);
    return {
      item_id: Number(it.id),
      codigo: String(it.codigo || ''),
      descricao: String(it.descricao || ''),
      quantidade: Number.isFinite(Number(qtd)) ? Number(qtd) : 0,
    };
  });
  rows = rows.filter((r) => Number(r.quantidade) > 0);
  if (q) {
    rows = rows.filter((r) => {
      const codigo = String(r.codigo || '').toLowerCase();
      const descricao = String(r.descricao || '').toLowerCase();
      return codigo.includes(q) || descricao.includes(q);
    });
  }
  rows.sort((a, b) => {
    const c = String(a.codigo || '').localeCompare(String(b.codigo || ''));
    if (c !== 0) return c;
    return String(a.descricao || '').localeCompare(String(b.descricao || ''));
  });

  const total = rows.length;
  const suggestions = rows.slice(0, 10).map((r) => ({
    item_id: r.item_id,
    codigo: r.codigo,
    descricao: r.descricao,
  }));
  const paged = rows.slice(offset, offset + limit);
  itensNacionalPorArmazemCache.set(cacheKey, { ts: Date.now(), rows, suggestions });
  if (itensNacionalPorArmazemCache.size > 40) {
    const firstKey = itensNacionalPorArmazemCache.keys().next().value;
    if (firstKey) itensNacionalPorArmazemCache.delete(firstKey);
  }
  return { total, limit, offset, rows: paged, suggestions };
}

module.exports = {
  localizacaoExisteNoArmazem,
  cadastroManualStock,
  listMeusArmazensStock,
  listItensNacionalPorArmazem,
  ITENS_NACIONAL_CACHE_TTL_MS,
};
