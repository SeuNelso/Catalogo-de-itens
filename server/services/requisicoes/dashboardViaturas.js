/**
 * Agregação do Dashboard OP (viaturas) — uma passagem no servidor em vez de
 * paginar /movimentos-clog/consulta e listar requisições com todos os itens.
 */

const STATUS_PENDENTES = new Set([
  'pendente',
  'em separacao',
  'separado',
  'em expedicao',
  'apeados',
]);

const HISTORICO_MAX_ROWS = 25000;
const DEFAULT_RANGE_DAYS = 90;

function normalizeStatus(raw) {
  return String(raw || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseDateBR(v) {
  const s = String(v || '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return 0;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function isoDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveDateRange(dataInicioRaw, dataFimRaw) {
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - DEFAULT_RANGE_DAYS);
  let dataInicio = String(dataInicioRaw || '').trim();
  let dataFim = String(dataFimRaw || '').trim();
  if (!dataInicio) dataInicio = isoDateOnly(inicio);
  if (!dataFim) dataFim = isoDateOnly(fim);
  return { dataInicio, dataFim };
}

async function fetchViaturaArmazens(pool) {
  const r = await pool.query(
    `SELECT id, codigo, descricao, tipo
     FROM armazens
     WHERE ativo IS DISTINCT FROM false
     ORDER BY descricao NULLS LAST, codigo NULLS LAST, id`
  );
  const all = r.rows || [];
  const explicitas = all.filter((a) => String(a?.tipo || '').trim().toLowerCase() === 'viatura');
  const viaturas = explicitas.length > 0
    ? explicitas
    : all.filter((a) => String(a?.tipo || '').trim().toLowerCase() !== 'central');
  const viaturaIds = new Set(
    viaturas.map((a) => Number(a.id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const tiposPorId = new Map(
    all.map((a) => [Number(a.id), String(a?.tipo || '').trim().toLowerCase()])
  );
  const labelPorId = new Map(
    viaturas.map((a) => {
      const id = Number(a.id);
      const cod = String(a?.codigo || '').trim();
      const desc = String(a?.descricao || '').trim();
      const label = cod && desc ? `${cod} - ${desc}` : cod || desc || `Viatura ${id}`;
      return [id, label];
    })
  );
  return { viaturaIds, viaturas, tiposPorId, labelPorId };
}

function rowPassesScope(row, { isAdmin, allowedScopeIds, isFluxoDevolucaoViaturaCentral, recebimentoMarker }) {
  if (isAdmin) return true;
  if (!allowedScopeIds.length) return false;
  const origemId = Number(row?.armazem_origem_id);
  const destinoId = Number(row?.armazem_id);
  const origemTipo = String(row?.armazem_origem_tipo || '').trim().toLowerCase();
  const destinoTipo = String(row?.armazem_destino_tipo || '').trim().toLowerCase();
  const observacoesRow = String(row?.Observações || row?.observacoes || '').toUpperCase();
  const isRecebimentoTransfer = observacoesRow.startsWith(String(recebimentoMarker || '').toUpperCase());
  if (isFluxoDevolucaoViaturaCentral(origemTipo, destinoTipo)) {
    return Number.isFinite(destinoId) && allowedScopeIds.includes(destinoId);
  }
  if (isRecebimentoTransfer && Number.isFinite(destinoId)) {
    return allowedScopeIds.includes(destinoId);
  }
  if (Number.isFinite(origemId)) return allowedScopeIds.includes(origemId);
  return true;
}

function detectarViaturaDaLinha(row, viaturaIds, tiposPorId) {
  const origemId = Number(row?.armazem_origem_id || 0);
  const destinoId = Number(row?.armazem_id || 0);
  const origemTipo =
    String(row?.armazem_origem_tipo || '').trim().toLowerCase() || tiposPorId.get(origemId) || '';
  const destinoTipo =
    String(row?.armazem_destino_tipo || '').trim().toLowerCase() || tiposPorId.get(destinoId) || '';
  const origemDesc = String(row?.armazem_origem_descricao || row?.Loc_Inicial || '').trim();
  const destinoDesc = String(
    row?.armazem_destino_descricao || row?.['Novo Armazém'] || row?.['New Localização'] || ''
  ).trim();

  if (destinoTipo === 'viatura' || viaturaIds.has(destinoId)) {
    return { id: destinoId, nome: destinoDesc || `Viatura #${destinoId}`, sentido: 'entrada' };
  }
  if (origemTipo === 'viatura' || viaturaIds.has(origemId)) {
    return { id: origemId, nome: origemDesc || `Viatura #${origemId}`, sentido: 'saida' };
  }
  return null;
}

async function fetchMetaRequisicoes(pool, reqIds) {
  if (!reqIds.length) return new Map();
  const r = await pool.query(
    `SELECT r.id,
            r.armazem_origem_id,
            r.armazem_id,
            ao.tipo AS armazem_origem_tipo,
            ad.tipo AS armazem_destino_tipo,
            ao.descricao AS armazem_origem_descricao,
            ad.descricao AS armazem_destino_descricao
     FROM requisicoes r
     LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
     LEFT JOIN armazens ad ON ad.id = r.armazem_id
     WHERE r.id = ANY($1::int[])`,
    [reqIds]
  );
  return new Map((r.rows || []).map((m) => [Number(m.id), m]));
}

async function fetchHistoricoRows(pool, movimentosHistoricoTableExists, { dataInicio, dataFim }) {
  if (!(await movimentosHistoricoTableExists())) return [];
  const params = [];
  const parts = [];
  let idx = 1;

  const dtExpr = `(
    CASE
      WHEN TRIM(COALESCE(h.row_data->>'Dt_Recepção', '')) ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
      THEN to_date(TRIM(h.row_data->>'Dt_Recepção'), 'DD/MM/YYYY')
      ELSE NULL
    END
  )`;

  if (dataInicio) {
    parts.push(`${dtExpr} >= $${idx++}::date`);
    params.push(dataInicio);
  }
  if (dataFim) {
    parts.push(`${dtExpr} <= $${idx++}::date`);
    params.push(dataFim);
  }

  const whereSql = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  params.push(HISTORICO_MAX_ROWS);

  const hr = await pool.query(
    `SELECT h.requisicao_id, h.row_data
     FROM requisicoes_movimentos_historico h
     ${whereSql}
     ORDER BY h.id DESC
     LIMIT $${idx}`,
    params
  );

  const rows = [];
  const reqIds = new Set();
  for (const x of hr.rows || []) {
    const slot = x.row_data && typeof x.row_data === 'object' ? x.row_data : null;
    if (!slot) continue;
    const rid = Number(x.requisicao_id || slot.requisicao_id || 0);
    if (rid > 0) reqIds.add(rid);
    rows.push({ ...slot, requisicao_id: rid || slot.requisicao_id || null });
  }

  const metaByReq = await fetchMetaRequisicoes(pool, [...reqIds]);
  return rows.map((row) => {
    const rid = Number(row?.requisicao_id || 0);
    const meta = rid > 0 ? metaByReq.get(rid) : null;
    return {
      ...row,
      armazem_origem_id: row?.armazem_origem_id ?? meta?.armazem_origem_id ?? null,
      armazem_id: row?.armazem_id ?? meta?.armazem_id ?? null,
      armazem_origem_tipo: row?.armazem_origem_tipo || meta?.armazem_origem_tipo || '',
      armazem_destino_tipo: row?.armazem_destino_tipo || meta?.armazem_destino_tipo || '',
      armazem_origem_descricao:
        row?.armazem_origem_descricao || meta?.armazem_origem_descricao || '',
      armazem_destino_descricao:
        row?.armazem_destino_descricao || meta?.armazem_destino_descricao || '',
    };
  });
}

function aggregateMovimentos(rows, ctx) {
  const { viaturaIds, tiposPorId, labelPorId, armazemIdFiltro, scopeOpts } = ctx;
  const byViatura = new Map();

  for (const row of rows || []) {
    if (!rowPassesScope(row, scopeOpts)) continue;
    const v = detectarViaturaDaLinha(row, viaturaIds, tiposPorId);
    if (!v || !v.id) continue;
    if (armazemIdFiltro && Number(v.id) !== armazemIdFiltro) continue;

    const key = Number(v.id);
    const nome =
      labelPorId.get(key) || String(v.nome || '').trim() || `Viatura ${key}`;
    const current = byViatura.get(key) || {
      viatura_id: key,
      viatura_nome: nome,
      abastecido_set: new Set(),
      devolvido_set: new Set(),
      movimentos: 0,
      ultimo_ts: 0,
      ultimo_texto: '',
    };

    const reqId = Number(row?.requisicao_id || 0);
    if (v.sentido === 'entrada' && reqId > 0) current.abastecido_set.add(reqId);
    if (v.sentido === 'saida' && reqId > 0) current.devolvido_set.add(reqId);
    current.movimentos += 1;
    const ts = parseDateBR(row?.['Dt_Recepção']);
    if (ts >= current.ultimo_ts) {
      current.ultimo_ts = ts;
      current.ultimo_texto = String(row?.['Dt_Recepção'] || '').trim();
    }
    byViatura.set(key, current);
  }

  return byViatura;
}

async function fetchRequisicoesResumo(pool, opts) {
  const {
    dataInicio,
    dataFim,
    viaturaIds,
    isAdmin,
    allowedScopeIds,
    armazemIdFiltro,
  } = opts;
  if (!viaturaIds.size) {
    return { entrega: [], devolucao: [] };
  }

  let viaturaIdList = [...viaturaIds];
  if (armazemIdFiltro && viaturaIds.has(armazemIdFiltro)) {
    viaturaIdList = [armazemIdFiltro];
  }

  const params = [viaturaIdList];
  let idx = 2;
  const dateParts = [];
  if (dataInicio) {
    dateParts.push(`r.created_at::date >= $${idx++}::date`);
    params.push(dataInicio);
  }
  if (dataFim) {
    dateParts.push(`r.created_at::date <= $${idx++}::date`);
    params.push(dataFim);
  }
  const dateSql = dateParts.length ? ` AND ${dateParts.join(' AND ')}` : '';

  let scopeSql = '';
  if (!isAdmin) {
    if (!allowedScopeIds.length) {
      return { entrega: [], devolucao: [] };
    }
    scopeSql = ` AND (
      (LOWER(TRIM(ad.tipo)) = 'viatura' AND r.armazem_origem_id = ANY($${idx}::int[]))
      OR (LOWER(TRIM(ao.tipo)) = 'viatura' AND LOWER(TRIM(ad.tipo)) = 'central' AND r.armazem_id = ANY($${idx}::int[]))
    )`;
    params.push(allowedScopeIds);
    idx += 1;
  }

  const q = await pool.query(
    `SELECT r.id,
            r.status,
            r.armazem_id,
            r.armazem_origem_id,
            r.tra_numero,
            r.devolucao_tra_apeados_numero,
            r.created_at,
            ao.tipo AS armazem_origem_tipo,
            ad.tipo AS armazem_destino_tipo,
            (COALESCE(ad.codigo, '') || CASE WHEN ad.codigo IS NOT NULL AND ad.codigo <> '' THEN ' - ' ELSE '' END || ad.descricao) AS armazem_descricao,
            (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) AS armazem_origem_descricao
     FROM requisicoes r
     INNER JOIN armazens ad ON r.armazem_id = ad.id
     LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
     WHERE (
       (LOWER(TRIM(ad.tipo)) = 'viatura' AND r.armazem_id = ANY($1::int[]))
       OR (LOWER(TRIM(ao.tipo)) = 'viatura' AND r.armazem_origem_id = ANY($1::int[]))
     )
     ${dateSql}
     ${scopeSql}
     ORDER BY r.created_at DESC
     LIMIT 3000`,
    params
  );

  const entrega = [];
  const devolucao = [];
  for (const row of q.rows || []) {
    const summary = { ...row, itens: [] };
    const destId = Number(row.armazem_id || 0);
    const origId = Number(row.armazem_origem_id || 0);
    const destTipo = String(row.armazem_destino_tipo || '').trim().toLowerCase();
    const origTipo = String(row.armazem_origem_tipo || '').trim().toLowerCase();
    if (destTipo === 'viatura' && viaturaIds.has(destId)) entrega.push(summary);
    if (origTipo === 'viatura' && viaturaIds.has(origId)) devolucao.push(summary);
  }
  return { entrega, devolucao };
}

function mergePendentes(byViatura, requisicoes, { viaturaIds, labelPorId, tipo }) {
  for (const req of requisicoes || []) {
    const pendente = STATUS_PENDENTES.has(normalizeStatus(req?.status));
    if (!pendente) continue;
    const viaturaId =
      tipo === 'entrega' ? Number(req?.armazem_id || 0) : Number(req?.armazem_origem_id || 0);
    if (!viaturaId || !viaturaIds.has(viaturaId)) continue;

    const current = byViatura.get(viaturaId) || {
      viatura_id: viaturaId,
      viatura_nome: labelPorId.get(viaturaId) || `Viatura ${viaturaId}`,
      abastecido_set: new Set(),
      devolvido_set: new Set(),
      movimentos: 0,
      ultimo_ts: 0,
      ultimo_texto: '',
      pendentes_entrega_set: new Set(),
      devolucoes_pendentes_set: new Set(),
    };
    if (tipo === 'entrega') {
      const set = current.pendentes_entrega_set || new Set();
      set.add(Number(req.id));
      current.pendentes_entrega_set = set;
    } else {
      const set = current.devolucoes_pendentes_set || new Set();
      set.add(Number(req.id));
      current.devolucoes_pendentes_set = set;
    }
    byViatura.set(viaturaId, current);
  }
}

function buildResponseFromMaps(byViatura) {
  let totalAbastecido = 0;
  let totalDevolvido = 0;
  let totalPendentesEntrega = 0;
  let totalDevolucoesPendentes = 0;

  const lista = [...byViatura.values()]
    .map((x) => {
      const abastecido = (x.abastecido_set || new Set()).size;
      const devolvido = (x.devolvido_set || new Set()).size;
      const pendentesEntrega = (x.pendentes_entrega_set || new Set()).size;
      const devolucoesPendentes = (x.devolucoes_pendentes_set || new Set()).size;
      totalAbastecido += abastecido;
      totalDevolvido += devolvido;
      totalPendentesEntrega += pendentesEntrega;
      totalDevolucoesPendentes += devolucoesPendentes;
      return {
        viatura_id: x.viatura_id,
        viatura_nome: x.viatura_nome,
        abastecido,
        devolvido,
        pendentes_entrega: pendentesEntrega,
        devolucoes_pendentes: devolucoesPendentes,
        movimentos: Number(x.movimentos || 0),
        ultimo_texto: x.ultimo_texto || '',
      };
    })
    .sort((a, b) => b.abastecido - a.abastecido || b.movimentos - a.movimentos);

  return {
    lista,
    totalViaturas: lista.length,
    totalAbastecido,
    totalDevolvido,
    totalPendentesEntrega,
    totalDevolucoesPendentes,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {object} deps
 * @param {object} options
 */
async function buildDashboardViaturasPayload(pool, deps, options) {
  const {
    dataInicio: dataInicioIn,
    dataFim: dataFimIn,
    armazemIdFiltro,
    isAdmin,
    allowedScopeIds,
  } = options;

  const { dataInicio, dataFim } = resolveDateRange(dataInicioIn, dataFimIn);
  const { viaturaIds, tiposPorId, labelPorId } = await fetchViaturaArmazens(pool);

  const scopeOpts = {
    isAdmin,
    allowedScopeIds: allowedScopeIds || [],
    isFluxoDevolucaoViaturaCentral: deps.isFluxoDevolucaoViaturaCentral,
    recebimentoMarker: deps.RECEBIMENTO_TRANSFERENCIA_MARKER,
  };

  const historicoRows = await fetchHistoricoRows(pool, deps.movimentosHistoricoTableExists, {
    dataInicio,
    dataFim,
  });

  const byViatura = aggregateMovimentos(historicoRows, {
    viaturaIds,
    tiposPorId,
    labelPorId,
    armazemIdFiltro,
    scopeOpts,
  });

  const { entrega, devolucao } = await fetchRequisicoesResumo(pool, {
    dataInicio,
    dataFim,
    viaturaIds,
    isAdmin,
    allowedScopeIds: allowedScopeIds || [],
    armazemIdFiltro,
  });

  mergePendentes(byViatura, entrega, { viaturaIds, labelPorId, tipo: 'entrega' });
  mergePendentes(byViatura, devolucao, { viaturaIds, labelPorId, tipo: 'devolucao' });

  const agregados = buildResponseFromMaps(byViatura);

  return {
    data_inicio: dataInicio,
    data_fim: dataFim,
    historico_linhas_processadas: historicoRows.length,
    ...agregados,
    requisicoes_entrega: entrega,
    requisicoes_devolucao: devolucao,
  };
}

function seriaisFromItemRow(it) {
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    for (const part of s.split(/\r?\n|;|\|/)) {
      for (const x of part.split(/\s*,\s*/)) {
        const t = x.trim();
        if (t) out.push(t);
      }
    }
  };
  if (Array.isArray(it?.seriais)) {
    for (const s of it.seriais) add(s);
  }
  add(it?.serialnumber);
  return [...new Set(out)];
}

/**
 * Itens resumidos para o modal do Dashboard OP (sem pipeline do reporte TRA).
 * @returns {Promise<{ requisicao: object, itens: object[] }|null>}
 */
async function fetchItensResumoRequisicao(pool, deps, requisicaoId) {
  const reqQ = await pool.query(
    `SELECT r.id,
            r.status,
            r.armazem_origem_id,
            r.armazem_id,
            r.tra_numero,
            r.devolucao_tra_apeados_numero,
            r.created_at,
            ao.tipo AS armazem_origem_tipo,
            ad.tipo AS armazem_destino_tipo
     FROM requisicoes r
     INNER JOIN armazens ad ON r.armazem_id = ad.id
     LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
     WHERE r.id = $1`,
    [requisicaoId]
  );
  if (!reqQ.rows.length) return null;
  const requisicao = reqQ.rows[0];

  const itensResult = await pool.query(
    `SELECT ri.id,
            ri.item_id,
            ri.quantidade,
            ri.quantidade_preparada,
            ri.lote,
            ri.serialnumber,
            i.codigo AS item_codigo,
            i.descricao AS item_descricao,
            i.tipocontrolo
     FROM requisicoes_itens ri
     INNER JOIN itens i ON ri.item_id = i.id
     WHERE ri.requisicao_id = $1
     ORDER BY ri.id`,
    [requisicaoId]
  );
  const linhas = itensResult.rows || [];
  if (deps.attachSeriaisToRequisicaoItens) {
    await deps.attachSeriaisToRequisicaoItens(pool, linhas);
  }

  let bobinas = [];
  try {
    const bobinasResult = await pool.query(
      `SELECT b.metros,
              b.lote,
              b.serialnumber,
              ri.item_id,
              i.codigo AS item_codigo,
              i.descricao AS item_descricao
       FROM requisicoes_itens_bobinas b
       INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
       INNER JOIN itens i ON ri.item_id = i.id
       WHERE ri.requisicao_id = $1
       ORDER BY b.id`,
      [requisicaoId]
    );
    bobinas = bobinasResult.rows || [];
  } catch (_) {
    bobinas = [];
  }

  const bobinasPorItemId = new Map();
  for (const b of bobinas) {
    const itemId = Number(b.item_id || 0);
    if (!itemId) continue;
    const list = bobinasPorItemId.get(itemId) || [];
    list.push(b);
    bobinasPorItemId.set(itemId, list);
  }

  const itens = [];
  for (const ri of linhas) {
    const tipo = String(ri.tipocontrolo || '').trim().toUpperCase();
    const itemId = Number(ri.item_id || 0);
    const bobinasItem = bobinasPorItemId.get(itemId) || [];
    if (tipo === 'LOTE' && bobinasItem.length > 0) {
      for (const b of bobinasItem) {
        const metros = Number(b.metros || 0) || 0;
        if (metros <= 0) continue;
        itens.push({
          requisicao_item_id: ri.id,
          item_codigo: String(b.item_codigo || ri.item_codigo || '').trim(),
          item_descricao: String(b.item_descricao || ri.item_descricao || '').trim(),
          quantidade: metros,
          quantidade_preparada: metros,
          lote: String(b.lote || ri.lote || '').trim(),
          seriais: seriaisFromItemRow({ serialnumber: b.serialnumber }),
        });
      }
      continue;
    }
    const qty =
      parseFloat(ri.quantidade_preparada ?? ri.quantidade) || 0;
    if (qty <= 0 && tipo !== 'S/N') continue;
    itens.push({
      requisicao_item_id: ri.id,
      item_codigo: String(ri.item_codigo || '').trim(),
      item_descricao: String(ri.item_descricao || '').trim(),
      quantidade: qty,
      quantidade_preparada: qty,
      lote: String(ri.lote || '').trim(),
      seriais: seriaisFromItemRow(ri),
    });
  }

  return { requisicao, itens };
}

module.exports = {
  buildDashboardViaturasPayload,
  fetchItensResumoRequisicao,
  resolveDateRange,
  DEFAULT_RANGE_DAYS,
  HISTORICO_MAX_ROWS,
};
