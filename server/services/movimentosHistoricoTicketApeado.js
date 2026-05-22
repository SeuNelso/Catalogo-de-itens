/**
 * Regista movimento "Transf. Apeado" na consulta de movimentos ao gravar Nº TRA
 * num ticket de movimentação interna (transferência localização → APEADO).
 */

let _cacheMovimentosHistoricoTable = null;

async function movimentosHistoricoTableExists(pool) {
  if (_cacheMovimentosHistoricoTable === true) return true;
  if (_cacheMovimentosHistoricoTable === false) return false;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'requisicoes_movimentos_historico'
       LIMIT 1`
    );
    _cacheMovimentosHistoricoTable = (r.rows || []).length > 0;
  } catch {
    _cacheMovimentosHistoricoTable = false;
  }
  return _cacheMovimentosHistoricoTable;
}

function formatDateBR(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function isTipoControloSerial(tipoControlo) {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
}

function buildClogRowBase(ticket, opts = {}) {
  const ticketId = Number(ticket.id);
  const d = ticket.tra_apeado_gerada_em
    ? new Date(ticket.tra_apeado_gerada_em)
    : ticket.created_at
      ? new Date(ticket.created_at)
      : new Date();
  const traNumero = String(ticket.tra_apeado_numero || '').trim();
  const movId = String(opts.mov_id || `ami:${ticketId}:transf-apeado`).trim();
  const qty = Number(opts.qty);
  const qtyAbs =
    Number.isFinite(qty) && qty !== 0 ? Math.abs(qty) : Math.abs(Number(ticket.quantidade) || 0);
  const qtyFinal = qtyAbs > 0 ? -qtyAbs : 0;

  return {
    mov_id: movId,
    mov_ticket_apeado: true,
    ticket_mov_interna_id: ticketId,
    requisicao_id: null,
    usuario_id: Number(ticket.usuario_id) || null,
    armazem_origem_id: Number(ticket.origem_armazem_id) || null,
    armazem_id: Number(ticket.destino_armazem_id) || null,
    armazem_origem_codigo: String(ticket.origem_armazem_codigo || '').trim(),
    armazem_origem_descricao: String(ticket.origem_armazem_descricao || '').trim(),
    armazem_origem_tipo: String(ticket.origem_armazem_tipo || '').trim().toLowerCase(),
    armazem_destino_codigo: String(ticket.destino_armazem_codigo || '').trim(),
    armazem_destino_descricao: String(ticket.destino_armazem_descricao || '').trim(),
    armazem_destino_tipo: String(ticket.destino_armazem_tipo || '').trim().toLowerCase(),
    __ordem_movimento: 1,
    'Tipo de Movimento': 'Transf. Apeado',
    'Dt_Recepção': formatDateBR(d),
    'REF.': String(opts.ref || ticket.item_codigo || '').trim(),
    DESCRIPTION: String(opts.description || ticket.item_descricao || '').trim(),
    QTY: qtyFinal,
    Loc_Inicial: String(ticket.origem_loc || '').trim(),
    'S/N': String(opts.sn || '').trim(),
    Lote: String(opts.lote || '').trim(),
    'Novo Armazém': String(ticket.destino_armazem_codigo || '').trim(),
    'TRA / DEV': traNumero,
    'New Localização': String(ticket.destino_loc || '').trim(),
    DEP: '',
    Observações: String(opts.observacoes || `Transf. localização APEADO · ticket #${ticketId}`).trim(),
  };
}

async function fetchTicketParaMovimento(pool, ticketId, armazemId) {
  const r = await pool.query(
    `SELECT ami.id, ami.armazem_id, ami.usuario_id, ami.created_at, ami.tra_apeado_gerada_em,
            ami.tra_apeado_numero, ami.quantidade::float AS quantidade,
            i.codigo AS item_codigo, i.descricao AS item_descricao, i.tipocontrolo,
            lo.localizacao AS origem_loc, ld.localizacao AS destino_loc,
            ao.id AS origem_armazem_id, ao.codigo AS origem_armazem_codigo,
            ao.descricao AS origem_armazem_descricao,
            LOWER(TRIM(COALESCE(ao.tipo, ''))) AS origem_armazem_tipo,
            ad.id AS destino_armazem_id, ad.codigo AS destino_armazem_codigo,
            ad.descricao AS destino_armazem_descricao,
            LOWER(TRIM(COALESCE(ad.tipo, ''))) AS destino_armazem_tipo
     FROM armazem_movimentacao_interna ami
     INNER JOIN itens i ON i.id = ami.item_id
     INNER JOIN armazens_localizacoes lo ON lo.id = ami.origem_localizacao_id
     INNER JOIN armazens_localizacoes ld ON ld.id = ami.destino_localizacao_id
     INNER JOIN armazens ao ON ao.id = lo.armazem_id
     INNER JOIN armazens ad ON ad.id = ld.armazem_id
     WHERE ami.id = $1 AND ami.armazem_id = $2
       AND LOWER(TRIM(COALESCE(ad.tipo, ''))) = 'apeado'
       AND COALESCE(TRIM(ami.tra_apeado_numero), '') <> ''`,
    [ticketId, armazemId]
  );
  return r.rows[0] || null;
}

async function buildClogRowsFromTicket(pool, ticket) {
  const ticketId = Number(ticket.id);
  const tipoNorm = String(ticket.tipocontrolo || '').trim().toUpperCase().replace(/\s+/g, '');
  const isSerial = isTipoControloSerial(ticket.tipocontrolo);
  const isLote = tipoNorm === 'LOTE';
  const rows = [];

  const hasLotesQ = await pool.query(
    `SELECT to_regclass('public.armazem_movimentacao_interna_lotes') IS NOT NULL AS ok`
  );
  const hasLotesTable = Boolean(hasLotesQ.rows?.[0]?.ok);
  const hasSeriaisQ = await pool.query(
    `SELECT to_regclass('public.armazem_movimentacao_interna_seriais') IS NOT NULL AS ok`
  );
  const hasSeriaisTable = Boolean(hasSeriaisQ.rows?.[0]?.ok);

  if (isLote && hasLotesTable) {
    const lr = await pool.query(
      `SELECT lote, quantidade::float AS quantidade
       FROM armazem_movimentacao_interna_lotes
       WHERE ticket_id = $1
       ORDER BY lote ASC`,
      [ticketId]
    );
    if ((lr.rows || []).length > 0) {
      for (const lot of lr.rows) {
        const lote = String(lot.lote || '').trim();
        const q = Number(lot.quantidade) || 0;
        if (!lote || q <= 0) continue;
        rows.push(
          buildClogRowBase(ticket, {
            mov_id: `ami:${ticketId}:lote:${lote}`,
            qty: q,
            lote,
          })
        );
      }
      return rows;
    }
  }

  if (isSerial && hasSeriaisTable) {
    const sr = await pool.query(
      `SELECT TRIM(COALESCE(amis.serialnumber, ss.serialnumber, '')) AS sn
       FROM armazem_movimentacao_interna_seriais amis
       LEFT JOIN stock_serial ss ON ss.id = amis.stock_serial_id
       WHERE amis.ticket_id = $1
       ORDER BY 1 ASC`,
      [ticketId]
    );
    const serials = (sr.rows || [])
      .map((x) => String(x.sn || '').trim())
      .filter(Boolean);
    if (serials.length > 0) {
      rows.push(
        buildClogRowBase(ticket, {
          mov_id: `ami:${ticketId}:sn`,
          sn: serials.join('\n'),
          qty: serials.length,
        })
      );
      return rows;
    }
  }

  rows.push(buildClogRowBase(ticket, { mov_id: `ami:${ticketId}:transf-apeado` }));
  return rows;
}

async function upsertRowsHistorico(pool, rows) {
  for (const row of rows) {
    const movKey = String(row.mov_id || '').trim();
    if (!movKey) continue;
    await pool.query(
      `INSERT INTO requisicoes_movimentos_historico (mov_key, requisicao_id, row_data, updated_at)
       VALUES ($1, NULL, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (mov_key)
       DO UPDATE SET
         row_data = EXCLUDED.row_data,
         updated_at = CURRENT_TIMESTAMP`,
      [movKey, JSON.stringify(row)]
    );
  }
}

async function persistTransfApeadoMovimentoFromTicket(pool, ticketId, armazemId) {
  const tid = parseInt(ticketId, 10);
  const aid = parseInt(armazemId, 10);
  if (!Number.isFinite(tid) || tid <= 0 || !Number.isFinite(aid) || aid <= 0) return false;
  if (!(await movimentosHistoricoTableExists(pool))) return false;

  const ticket = await fetchTicketParaMovimento(pool, tid, aid);
  if (!ticket) return false;

  const rows = await buildClogRowsFromTicket(pool, ticket);
  if (!rows.length) return false;

  await pool.query(
    `DELETE FROM requisicoes_movimentos_historico
     WHERE mov_key LIKE $1`,
    [`ami:${tid}:%`]
  );
  await upsertRowsHistorico(pool, rows);
  return true;
}

function schedulePersistTransfApeadoMovimentoFromTicket(pool, ticketId, armazemId, contextLabel = '') {
  setImmediate(() => {
    persistTransfApeadoMovimentoFromTicket(pool, ticketId, armazemId).catch((e) => {
      const tag = contextLabel ? ` (${contextLabel})` : '';
      console.warn(`[movimentos_historico] ticket APEADO${tag}:`, e?.message || e);
    });
  });
}

module.exports = {
  persistTransfApeadoMovimentoFromTicket,
  schedulePersistTransfApeadoMovimentoFromTicket,
};
