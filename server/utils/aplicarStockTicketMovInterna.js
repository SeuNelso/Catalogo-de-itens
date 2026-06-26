'use strict';

const _columnExistsCache = new Map();

async function columnExists(client, tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_columnExistsCache.has(key)) return _columnExistsCache.get(key);
  const r = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  const ok = (r.rowCount || 0) > 0;
  _columnExistsCache.set(key, ok);
  return ok;
}

function invalidateColumnExistsCache(tableName, columnName) {
  if (tableName && columnName) {
    _columnExistsCache.delete(`${tableName}.${columnName}`);
    return;
  }
  _columnExistsCache.clear();
}

async function hasEstoqueAplicadoColumn(client) {
  return columnExists(client, 'armazem_movimentacao_interna', 'estoque_aplicado_em');
}

function isTipoControloSerial(tipoControlo) {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
}

/** Alinha `armazens_localizacao_item` ao nº de S/N disponíveis/reservados numa localização. */
async function syncAliQtyFromSerialCount(client, {
  localizacaoId,
  itemId,
  armazemId,
  locLabel,
}) {
  const locId = Number(localizacaoId);
  const iid = Number(itemId);
  const armId = Number(armazemId);
  const label = String(locLabel || '').trim();
  if (!Number.isFinite(locId) || locId <= 0 || !Number.isFinite(iid) || iid <= 0 || !Number.isFinite(armId) || armId <= 0 || !label) {
    return;
  }
  try {
    const cntQ = await client.query(
      `SELECT COUNT(*)::numeric AS n
       FROM stock_serial
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND status IN ('disponivel', 'reservado')`,
      [iid, armId, label]
    );
    const n = Number(cntQ.rows[0]?.n) || 0;
    if (n <= 0) {
      await client.query(
        'DELETE FROM armazens_localizacao_item WHERE localizacao_id = $1 AND item_id = $2',
        [locId, iid]
      );
      return;
    }
    await client.query(
      `INSERT INTO armazens_localizacao_item (localizacao_id, item_id, quantidade)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (localizacao_id, item_id) DO UPDATE SET
         quantidade = EXCLUDED.quantidade,
         updated_at = CURRENT_TIMESTAMP`,
      [locId, iid, n]
    );
  } catch (e) {
    if (e.code === '42P01') return;
    throw e;
  }
}

function makeBizError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.isStockMovInternaBiz = true;
  return err;
}

/** Planifica metragem por lote na origem (sem mover stock). */
async function planificarAlocacaoLotes(client, {
  itemId,
  armazemId,
  origemLocLabel,
  quantidade,
  lotesLinha,
  forUpdate = false,
}) {
  const lotesNorm = (lotesLinha || [])
    .map((l) => String(l || '').trim().toUpperCase())
    .filter(Boolean);
  const lotesFiltro = lotesNorm.length > 0 ? lotesNorm : null;
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const lotesOrigemQ = await client.query(
    `SELECT id, lote, quantidade_disponivel
     FROM stock_lote
     WHERE item_id = $1
       AND armazem_id = $2
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
       AND quantidade_disponivel > 0
       AND ($4::text[] IS NULL OR UPPER(TRIM(lote)) = ANY($4::text[]))
     ORDER BY quantidade_disponivel DESC, id ASC${lock}`,
    [itemId, armazemId, origemLocLabel, lotesFiltro]
  );
  const totalDisponivel = (lotesOrigemQ.rows || []).reduce(
    (sum, row) => sum + (Number(row.quantidade_disponivel) || 0),
    0
  );
  if (totalDisponivel < Number(quantidade)) {
    return { ok: false, linhasLoteTicket: [] };
  }
  let restante = Number(quantidade);
  const linhasLoteTicket = [];
  for (const loteRow of lotesOrigemQ.rows || []) {
    if (restante <= 0) break;
    const disponivel = Number(loteRow.quantidade_disponivel) || 0;
    if (disponivel <= 0) continue;
    const mover = Math.min(restante, disponivel);
    if (mover <= 0) continue;
    linhasLoteTicket.push({
      lote: String(loteRow.lote || '').trim(),
      quantidade: mover,
    });
    restante -= mover;
  }
  if (restante > 0) {
    return { ok: false, linhasLoteTicket: [] };
  }
  return { ok: true, linhasLoteTicket };
}

async function validarSerialsNaOrigem(client, {
  itemId,
  armazemId,
  origemLocId,
  serialsLinha,
  itemCodigo,
}) {
  const seriaisQ = await client.query(
    `SELECT id, serialnumber, status
     FROM stock_serial
     WHERE item_id = $1
       AND armazem_id = $2
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM((SELECT localizacao FROM armazens_localizacoes WHERE id = $3)::text))
       AND UPPER(TRIM(serialnumber)) = ANY($4::text[])
       AND status IN ('disponivel', 'reservado')`,
    [itemId, armazemId, origemLocId, serialsLinha.map((s) => String(s).trim().toUpperCase())]
  );
  if ((seriaisQ.rows || []).length !== serialsLinha.length) {
    throw makeBizError(
      400,
      `Um ou mais serial numbers selecionados para ${itemCodigo || itemId} não estão disponíveis na localização de origem.`,
      'SERIAIS_ORIGEM_INDISPONIVEIS'
    );
  }
  return seriaisQ.rows || [];
}

const RESERVA_SERIAIS_TICKET_INSERT_LOTE = 500;

async function reservarSerialsParaTicket(client, { ticketId, serialRows }) {
  const rows = (serialRows || []).filter(
    (r) => Number.isFinite(Number(r?.id)) && Number(r.id) > 0 && String(r?.serialnumber || '').trim()
  );
  const ids = rows.map((r) => Number(r.id));
  if (!ids.length) return;
  const upd = await client.query(
    `UPDATE stock_serial
     SET status = 'reservado',
         reservado_em = COALESCE(reservado_em, CURRENT_TIMESTAMP),
         atualizado_em = CURRENT_TIMESTAMP
     WHERE id = ANY($1::int[])
       AND status = 'disponivel'
     RETURNING id`,
    [ids]
  );
  if ((upd.rows || []).length !== ids.length) {
    throw makeBizError(
      400,
      'Não foi possível reservar todos os serial numbers na origem (podem estar reservados por outro ticket).',
      'SERIAIS_RESERVA_FALHOU'
    );
  }
  const tid = Number(ticketId);
  for (let i = 0; i < rows.length; i += RESERVA_SERIAIS_TICKET_INSERT_LOTE) {
    const chunk = rows.slice(i, i + RESERVA_SERIAIS_TICKET_INSERT_LOTE);
    const chunkIds = chunk.map((r) => Number(r.id));
    const chunkSns = chunk.map((r) => String(r.serialnumber || '').trim());
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO armazem_movimentacao_interna_seriais (ticket_id, stock_serial_id, serialnumber)
       SELECT $1, u.stock_serial_id, u.serialnumber
       FROM unnest($2::int[], $3::text[]) AS u(stock_serial_id, serialnumber)
       ON CONFLICT (ticket_id, serialnumber) DO NOTHING`,
      [tid, chunkIds, chunkSns]
    );
  }
}

async function inserirLotesParaTicket(client, { ticketId, linhasLoteTicket }) {
  const linhas = (linhasLoteTicket || []).filter(
    (ll) => String(ll?.lote || '').trim() && Number(ll?.quantidade) > 0
  );
  if (!linhas.length) return;
  const tid = Number(ticketId);
  const lotes = linhas.map((ll) => String(ll.lote || '').trim());
  const qtys = linhas.map((ll) => Number(ll.quantidade) || 0);
  await client.query(
    `INSERT INTO armazem_movimentacao_interna_lotes (ticket_id, lote, quantidade)
     SELECT $1, u.lote, u.qty::numeric
     FROM unnest($2::text[], $3::float8[]) AS u(lote, qty)`,
    [tid, lotes, qtys]
  );
}

async function libertarReservaSerialsTicket(client, ticketId) {
  const hasTableQ = await client.query(
    `SELECT to_regclass('public.armazem_movimentacao_interna_seriais') IS NOT NULL AS ok`
  );
  if (!hasTableQ.rows?.[0]?.ok) return;
  await client.query(
    `UPDATE stock_serial ss
     SET status = 'disponivel',
         reservado_em = NULL,
         atualizado_em = CURRENT_TIMESTAMP
     FROM armazem_movimentacao_interna_seriais amis
     WHERE amis.ticket_id = $1
       AND ss.id = amis.stock_serial_id
       AND ss.status = 'reservado'`,
    [ticketId]
  );
}

/**
 * Aplica transferência física origem → destino para uma linha/ticket.
 * Idempotente por ticket quando `estoque_aplicado_em` já está preenchido.
 */
async function aplicarStockLinhaMovInterna(client, {
  itemId,
  itemCodigo,
  tipoControlo,
  quantidade,
  serialsLinha = [],
  lotesLinha = [],
  linhasLoteTicketPre = null,
  armazemId,
  origemLocId,
  destinoLocId,
  origemLocLabel,
  destinoLocLabel,
  destinoArmazemEfetivoId,
  podeControlarStock,
  ticketId = null,
  hasTicketSerialTable = false,
}) {
  const q = Number(quantidade) || 0;
  let linhasLoteTicket = Array.isArray(linhasLoteTicketPre) ? linhasLoteTicketPre : [];

  if (isTipoControloSerial(tipoControlo)) {
    const qtdInt = Math.floor(q);
    let serialRows = [];
    if (ticketId && hasTicketSerialTable) {
      const linked = await client.query(
        `SELECT ss.id, ss.serialnumber, ss.status, ss.localizacao, ss.armazem_id
         FROM armazem_movimentacao_interna_seriais amis
         INNER JOIN stock_serial ss ON ss.id = amis.stock_serial_id
         WHERE amis.ticket_id = $1
         ORDER BY ss.serialnumber ASC`,
        [ticketId]
      );
      serialRows = linked.rows || [];
    }
    let serialsParaValidar = [...new Set(
      (serialsLinha || []).map((s) => String(s || '').trim()).filter(Boolean)
    )];
    if (serialsParaValidar.length < qtdInt) {
      const origemLabel = String(origemLocLabel || '').trim()
        || String(
          (
            await client.query(
              `SELECT localizacao FROM armazens_localizacoes WHERE id = $1`,
              [origemLocId]
            )
          ).rows?.[0]?.localizacao || ''
        ).trim();
      const autoQ = await client.query(
        `SELECT serialnumber
         FROM stock_serial
         WHERE item_id = $1
           AND armazem_id = $2
           AND status IN ('disponivel', 'reservado')
         ORDER BY
           CASE
             WHEN UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text)) THEN 0
             ELSE 1
           END,
           serialnumber ASC
         LIMIT $4`,
        [itemId, armazemId, origemLabel || origemLocLabel, qtdInt]
      );
      const seen = new Set(serialsParaValidar.map((s) => s.toUpperCase()));
      for (const row of autoQ.rows || []) {
        if (serialsParaValidar.length >= qtdInt) break;
        const sn = String(row.serialnumber || '').trim();
        const key = sn.toUpperCase();
        if (!sn || seen.has(key)) continue;
        seen.add(key);
        serialsParaValidar.push(sn);
      }
    }
    if (serialRows.length < qtdInt && serialsParaValidar.length > 0) {
      const origemSyncLabel = String(origemLocLabel || '').trim()
        || String(
          (
            await client.query(
              `SELECT localizacao FROM armazens_localizacoes WHERE id = $1`,
              [origemLocId]
            )
          ).rows?.[0]?.localizacao || ''
        ).trim();
      if (origemSyncLabel) {
        await client.query(
          `UPDATE stock_serial
           SET localizacao = $3,
               status = 'disponivel',
               reservado_em = NULL,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(serialnumber)) = ANY(
               SELECT UPPER(TRIM(u.x)) FROM unnest($4::text[]) AS u(x)
             )
             AND status IN ('disponivel', 'reservado')`,
          [
            itemId,
            armazemId,
            origemSyncLabel,
            serialsParaValidar.slice(0, qtdInt).map((s) => String(s).trim()),
          ]
        );
      }
    }
    if (serialRows.length < qtdInt) {
      serialRows = await validarSerialsNaOrigem(client, {
        itemId,
        armazemId,
        origemLocId,
        serialsLinha: serialsParaValidar.slice(0, qtdInt),
        itemCodigo,
      });
    }
    if (serialRows.length !== qtdInt) {
      throw makeBizError(
        400,
        `Seriais insuficientes na origem para ${itemCodigo || itemId}.`,
        'SERIAIS_ORIGEM_INSUFICIENTES'
      );
    }
    const movedSerial = await client.query(
      `UPDATE stock_serial
       SET localizacao = $5,
           armazem_id = $6,
           status = 'disponivel',
           reservado_em = NULL,
           requisicao_id = NULL,
           requisicao_item_id = NULL,
           atualizado_em = CURRENT_TIMESTAMP
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND UPPER(TRIM(serialnumber)) = ANY($4::text[])
         AND status IN ('disponivel', 'reservado')
       RETURNING id`,
      [
        itemId,
        armazemId,
        origemLocLabel,
        serialRows.map((s) => String(s.serialnumber || '').trim().toUpperCase()),
        destinoLocLabel,
        destinoArmazemEfetivoId,
      ]
    );
    if ((movedSerial.rows || []).length !== qtdInt) {
      throw makeBizError(
        400,
        `Não foi possível transferir todos os serial numbers de ${itemCodigo || itemId}.`,
        'SERIAIS_TRANSFERENCIA_FALHOU'
      );
    }
    await syncAliQtyFromSerialCount(client, {
      localizacaoId: origemLocId,
      itemId,
      armazemId,
      locLabel: origemLocLabel,
    });
    await syncAliQtyFromSerialCount(client, {
      localizacaoId: destinoLocId,
      itemId,
      armazemId: destinoArmazemEfetivoId,
      locLabel: destinoLocLabel,
    });
    return { linhasLoteTicket };
  } else if (String(tipoControlo || '').trim().toUpperCase() === 'LOTE') {
    if (!linhasLoteTicket.length) {
      const plan = await planificarAlocacaoLotes(client, {
        itemId,
        armazemId,
        origemLocLabel,
        quantidade: q,
        lotesLinha,
        forUpdate: true,
      });
      if (!plan.ok) {
        throw makeBizError(
          400,
          `Saldo insuficiente por lote para ${itemCodigo || itemId} na localização de origem.`,
          'LOTE_ORIGEM_INSUFICIENTE'
        );
      }
      linhasLoteTicket = plan.linhasLoteTicket;
    }
    for (const ll of linhasLoteTicket) {
      const loteCod = String(ll.lote || '').trim();
      const mover = Number(ll.quantidade) || 0;
      if (!loteCod || mover <= 0) continue;
      const loteRowQ = await client.query(
        `SELECT id, quantidade_disponivel
         FROM stock_lote
         WHERE item_id = $1
           AND armazem_id = $2
           AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
           AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))
           AND quantidade_disponivel >= $5::numeric
         FOR UPDATE`,
        [itemId, armazemId, origemLocLabel, loteCod, mover]
      );
      if (!loteRowQ.rows?.length) {
        throw makeBizError(
          400,
          `Lote ${loteCod} insuficiente na origem para ${itemCodigo || itemId}.`,
          'LOTE_TRANSFERENCIA_FALHOU'
        );
      }
      await client.query(
        `UPDATE stock_lote
         SET quantidade_disponivel = quantidade_disponivel - $2::numeric,
             atualizado_em = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [loteRowQ.rows[0].id, mover]
      );
      await client.query(
        `INSERT INTO stock_lote (item_id, armazem_id, localizacao, lote, quantidade_disponivel)
         VALUES ($1, $2, $3, $4, $5::numeric)
         ON CONFLICT (item_id, armazem_id, localizacao, lote)
         DO UPDATE SET
           quantidade_disponivel = stock_lote.quantidade_disponivel + EXCLUDED.quantidade_disponivel,
           atualizado_em = CURRENT_TIMESTAMP`,
        [itemId, destinoArmazemEfetivoId, destinoLocLabel, loteCod, mover]
      );
    }
    await client.query(
      `DELETE FROM stock_lote
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND quantidade_disponivel <= 0`,
      [itemId, armazemId, origemLocLabel]
    );
  }

  if (podeControlarStock) {
    const sub = await client.query(
      `UPDATE armazens_localizacao_item
       SET quantidade = quantidade - $1::numeric, updated_at = CURRENT_TIMESTAMP
       WHERE localizacao_id = $2 AND item_id = $3 AND quantidade >= $1::numeric
       RETURNING quantidade`,
      [q, origemLocId, itemId]
    );
    if (sub.rows.length === 0) {
      throw makeBizError(
        400,
        `Stock insuficiente na localização de origem para o artigo ${itemCodigo || itemId}.`,
        'STOCK_ORIGEM_INSUFICIENTE'
      );
    }
    const rest = Number(sub.rows[0].quantidade);
    if (rest <= 0) {
      await client.query(
        'DELETE FROM armazens_localizacao_item WHERE localizacao_id = $1 AND item_id = $2',
        [origemLocId, itemId]
      );
    }
    await client.query(
      `INSERT INTO armazens_localizacao_item (localizacao_id, item_id, quantidade)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (localizacao_id, item_id) DO UPDATE SET
         quantidade = armazens_localizacao_item.quantidade + EXCLUDED.quantidade,
         updated_at = CURRENT_TIMESTAMP`,
      [destinoLocId, itemId, q]
    );
  }

  return { linhasLoteTicket };
}

async function ticketEstoqueJaAplicado(client, ticketId) {
  if (!(await hasEstoqueAplicadoColumn(client))) return false;
  const r = await client.query(
    `SELECT estoque_aplicado_em FROM armazem_movimentacao_interna WHERE id = $1`,
    [ticketId]
  );
  return Boolean(r.rows?.[0]?.estoque_aplicado_em);
}

async function marcarTicketEstoqueAplicado(client, ticketId) {
  if (!(await hasEstoqueAplicadoColumn(client))) return;
  await client.query(
    `UPDATE armazem_movimentacao_interna
     SET estoque_aplicado_em = COALESCE(estoque_aplicado_em, CURRENT_TIMESTAMP)
     WHERE id = $1`,
    [ticketId]
  );
}

/** Tickets legados: stock já movido na criação antes de estoque_aplicado_em. */
async function stockJaTransferidoParaDestino(client, {
  itemId,
  tipoControlo,
  quantidade,
  serialsLinha = [],
  linhasLoteTicket = [],
  armazemId,
  origemLocId,
  destinoLocId,
  origemLocLabel,
  destinoLocLabel,
  destinoArmazemEfetivoId,
  podeControlarStock,
}) {
  const q = Number(quantidade) || 0;
  if (q <= 0) return false;

  if (isTipoControloSerial(tipoControlo)) {
    const qtdInt = Math.floor(q);
    if (!serialsLinha.length) return false;
    const destQ = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM stock_serial
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND UPPER(TRIM(serialnumber)) = ANY($4::text[])
         AND status IN ('disponivel', 'reservado')`,
      [
        itemId,
        destinoArmazemEfetivoId,
        destinoLocLabel,
        serialsLinha.map((s) => String(s).trim().toUpperCase()),
      ]
    );
    const origQ = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM stock_serial
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND UPPER(TRIM(serialnumber)) = ANY($4::text[])
         AND status IN ('disponivel', 'reservado')`,
      [
        itemId,
        armazemId,
        origemLocLabel,
        serialsLinha.map((s) => String(s).trim().toUpperCase()),
      ]
    );
    return Number(destQ.rows?.[0]?.n || 0) >= qtdInt && Number(origQ.rows?.[0]?.n || 0) < qtdInt;
  }

  if (String(tipoControlo || '').trim().toUpperCase() === 'LOTE') {
    const linhas = (linhasLoteTicket || []).filter((ll) => String(ll?.lote || '').trim() && Number(ll?.quantidade) > 0);
    if (!linhas.length) return false;
    for (const ll of linhas) {
      const loteCod = String(ll.lote || '').trim();
      const mover = Number(ll.quantidade) || 0;
      const destLoteQ = await client.query(
        `SELECT quantidade_disponivel::float AS quantidade_disponivel
         FROM stock_lote
         WHERE item_id = $1
           AND armazem_id = $2
           AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
           AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
        [itemId, destinoArmazemEfetivoId, destinoLocLabel, loteCod]
      );
      const origLoteQ = await client.query(
        `SELECT quantidade_disponivel::float AS quantidade_disponivel
         FROM stock_lote
         WHERE item_id = $1
           AND armazem_id = $2
           AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
           AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
        [itemId, armazemId, origemLocLabel, loteCod]
      );
      const destDisp = Number(destLoteQ.rows?.[0]?.quantidade_disponivel) || 0;
      const origDisp = Number(origLoteQ.rows?.[0]?.quantidade_disponivel) || 0;
      if (destDisp < mover || origDisp >= mover) return false;
    }
    if (podeControlarStock) {
      const destAliQ = await client.query(
        `SELECT quantidade::float AS quantidade
         FROM armazens_localizacao_item
         WHERE localizacao_id = $1 AND item_id = $2`,
        [destinoLocId, itemId]
      );
      const origAliQ = await client.query(
        `SELECT quantidade::float AS quantidade
         FROM armazens_localizacao_item
         WHERE localizacao_id = $1 AND item_id = $2`,
        [origemLocId, itemId]
      );
      const destAli = Number(destAliQ.rows?.[0]?.quantidade) || 0;
      const origAli = Number(origAliQ.rows?.[0]?.quantidade) || 0;
      if (destAli < q || origAli >= q) return false;
    }
    return true;
  }

  if (!podeControlarStock) return false;
  const destAliQ = await client.query(
    `SELECT quantidade::float AS quantidade
     FROM armazens_localizacao_item
     WHERE localizacao_id = $1 AND item_id = $2`,
    [destinoLocId, itemId]
  );
  const origAliQ = await client.query(
    `SELECT quantidade::float AS quantidade
     FROM armazens_localizacao_item
     WHERE localizacao_id = $1 AND item_id = $2`,
    [origemLocId, itemId]
  );
  const destAli = Number(destAliQ.rows?.[0]?.quantidade) || 0;
  const origAli = Number(origAliQ.rows?.[0]?.quantidade) || 0;
  return destAli >= q && origAli < q;
}

const LEGACY_STOCK_CODES = new Set([
  'STOCK_ORIGEM_INSUFICIENTE',
  'LOTE_ORIGEM_INSUFICIENTE',
  'LOTE_TRANSFERENCIA_FALHOU',
  'SERIAIS_TRANSFERENCIA_FALHOU',
  'SERIAIS_ORIGEM_INSUFICIENTES',
]);

/** Aplica stock pendente de um ticket (TRFL / TRA APEADO). Idempotente. */
async function aplicarStockTicketMovInternaSePendente(client, {
  ticketId,
  armazemId,
  origemLocId,
  destinoLocId,
  origemLocLabel,
  destinoLocLabel,
  destinoArmazemEfetivoId,
  itemId,
  itemCodigo,
  tipoControlo,
  quantidade,
  podeControlarStock,
  hasTicketSerialTable,
  hasTicketLotesTable,
}) {
  if (await ticketEstoqueJaAplicado(client, ticketId)) {
    return { applied: false };
  }

  let serialsLinha = [];
  let lotesLinha = [];
  let linhasLoteTicketPre = null;

  if (hasTicketSerialTable && isTipoControloSerial(tipoControlo)) {
    const sQ = await client.query(
      `SELECT serialnumber FROM armazem_movimentacao_interna_seriais WHERE ticket_id = $1`,
      [ticketId]
    );
    serialsLinha = (sQ.rows || []).map((r) => String(r.serialnumber || '').trim()).filter(Boolean);
  }

  if (hasTicketLotesTable && String(tipoControlo || '').trim().toUpperCase() === 'LOTE') {
    const lQ = await client.query(
      `SELECT lote, quantidade::float AS quantidade
       FROM armazem_movimentacao_interna_lotes
       WHERE ticket_id = $1
       ORDER BY lote ASC`,
      [ticketId]
    );
    if ((lQ.rows || []).length > 0) {
      linhasLoteTicketPre = (lQ.rows || []).map((r) => ({
        lote: String(r.lote || '').trim(),
        quantidade: Number(r.quantidade) || 0,
      }));
    }
  }

  try {
    await aplicarStockLinhaMovInterna(client, {
      itemId,
      itemCodigo,
      tipoControlo,
      quantidade,
      serialsLinha,
      lotesLinha,
      linhasLoteTicketPre,
      armazemId,
      origemLocId,
      destinoLocId,
      origemLocLabel,
      destinoLocLabel,
      destinoArmazemEfetivoId,
      podeControlarStock,
      ticketId,
      hasTicketSerialTable,
    });
  } catch (applyErr) {
    if (
      applyErr.isStockMovInternaBiz
      && LEGACY_STOCK_CODES.has(String(applyErr.code || ''))
      && await stockJaTransferidoParaDestino(client, {
        itemId,
        tipoControlo,
        quantidade,
        serialsLinha,
        linhasLoteTicket: linhasLoteTicketPre || [],
        armazemId,
        origemLocId,
        destinoLocId,
        origemLocLabel,
        destinoLocLabel,
        destinoArmazemEfetivoId,
        podeControlarStock,
      })
    ) {
      await marcarTicketEstoqueAplicado(client, ticketId);
      return { applied: false, alreadyAtDestino: true };
    }
    throw applyErr;
  }

  await marcarTicketEstoqueAplicado(client, ticketId);
  return { applied: true };
}

/**
 * Seriais para TRFL/TRA APEADO: tabela do ticket, depois stock na origem ou no destino
 * (tickets antigos sem `armazem_movimentacao_interna_seriais` ou stock já transferido).
 */
async function listarSeriaisParaExportTicket(client, {
  ticketId,
  itemId,
  armazemId,
  origemLocLabel,
  destinoArmazemId,
  destinoLocLabel,
  quantidade,
  hasTicketSerialTable,
}) {
  const qtdInt = Math.floor(Number(quantidade) || 0);
  if (qtdInt <= 0) return [];

  if (hasTicketSerialTable && ticketId) {
    const linked = await client.query(
      `SELECT ss.id, ss.serialnumber
       FROM armazem_movimentacao_interna_seriais amis
       INNER JOIN stock_serial ss ON ss.id = amis.stock_serial_id
       WHERE amis.ticket_id = $1
       ORDER BY ss.serialnumber ASC`,
      [ticketId]
    );
    if ((linked.rows || []).length >= qtdInt) {
      return (linked.rows || []).slice(0, qtdInt);
    }
  }

  const queryAt = async (armId, label) => {
    const arm = Number(armId || 0);
    const loc = String(label || '').trim();
    if (!Number.isFinite(arm) || arm <= 0 || !loc) return [];
    const r = await client.query(
      `SELECT id, serialnumber
       FROM stock_serial
       WHERE item_id = $1
         AND armazem_id = $2
         AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
         AND status IN ('disponivel', 'reservado')
       ORDER BY serialnumber ASC
       LIMIT $4`,
      [itemId, arm, loc, qtdInt]
    );
    return r.rows || [];
  };

  let rows = await queryAt(armazemId, origemLocLabel);
  if (rows.length < qtdInt) {
    rows = await queryAt(destinoArmazemId, destinoLocLabel);
  }
  if (rows.length < qtdInt) {
    const origNorm = String(origemLocLabel || '').trim();
    const destNorm = String(destinoLocLabel || '').trim();
    const r = await client.query(
      `SELECT id, serialnumber
       FROM stock_serial
       WHERE item_id = $1
         AND status IN ('disponivel', 'reservado')
         AND (
           ($2::int > 0 AND armazem_id = $2)
           OR ($3::int > 0 AND armazem_id = $3)
         )
       ORDER BY
         CASE
           WHEN $4::text <> '' AND UPPER(TRIM(localizacao)) = UPPER(TRIM($4::text)) THEN 0
           WHEN $5::text <> '' AND UPPER(TRIM(localizacao)) = UPPER(TRIM($5::text)) THEN 1
           ELSE 2
         END,
         serialnumber ASC
       LIMIT $6`,
      [
        itemId,
        Number(armazemId) || 0,
        Number(destinoArmazemId) || 0,
        origNorm,
        destNorm,
        qtdInt,
      ]
    );
    rows = r.rows || [];
  }
  return rows.slice(0, qtdInt);
}

/** Valida quantidade de S/N do ticket sem carregar todos os seriais (export TRFL/TRA agregado). */
async function validarQuantidadeSeriaisTicketExport(client, {
  ticketId,
  itemId,
  armazemId,
  origemLocLabel,
  destinoArmazemId,
  destinoLocLabel,
  quantidade,
  hasTicketSerialTable,
}) {
  const qtdInt = Math.floor(Number(quantidade) || 0);
  if (qtdInt <= 0) return { ok: true, qtdInt: 0 };

  if (hasTicketSerialTable && ticketId) {
    const cQ = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM armazem_movimentacao_interna_seriais
       WHERE ticket_id = $1`,
      [ticketId]
    );
    const n = Number(cQ.rows[0]?.n || 0) || 0;
    if (n >= qtdInt) return { ok: true, qtdInt };
  }

  const serialRows = await listarSeriaisParaExportTicket(client, {
    ticketId,
    itemId,
    armazemId,
    origemLocLabel,
    destinoArmazemId,
    destinoLocLabel,
    quantidade,
    hasTicketSerialTable,
  });
  return { ok: serialRows.length >= qtdInt, qtdInt };
}

module.exports = {
  isTipoControloSerial,
  syncAliQtyFromSerialCount,
  makeBizError,
  planificarAlocacaoLotes,
  validarSerialsNaOrigem,
  reservarSerialsParaTicket,
  inserirLotesParaTicket,
  libertarReservaSerialsTicket,
  aplicarStockLinhaMovInterna,
  aplicarStockTicketMovInternaSePendente,
  listarSeriaisParaExportTicket,
  validarQuantidadeSeriaisTicketExport,
  ticketEstoqueJaAplicado,
  marcarTicketEstoqueAplicado,
  hasEstoqueAplicadoColumn,
  columnExists,
  invalidateColumnExistsCache,
};
