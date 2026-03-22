/**
 * Rotas /api/requisicoes — montar com app.use('/api/requisicoes', createRequisicoesRouter(deps))
 */
const express = require('express');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

/** Nome legível do utilizador que criou a requisição (nome+sobrenome → username → nº colaborador). */
const SQL_CRIADOR_NOME = `COALESCE(
  NULLIF(TRIM(CONCAT(COALESCE(u.nome, ''), ' ', COALESCE(u.sobrenome, ''))), ''),
  NULLIF(TRIM(COALESCE(u.username, '')), ''),
  NULLIF(TRIM(COALESCE(u.numero_colaborador::text, '')), ''),
  '—'
)`;

const { isAdmin, isOperador } = require('../utils/roles');
const { isTipoArmazemOrigemRequisicao } = require('../utils/armazensRequisicaoOrigem');
const {
  usuarioEscopadoSemArmazensAtribuidos,
  requisicaoPerfilNegadoMiddleware,
} = require('../middleware/requisicoesScope');

const SQL_CRIADOR_COM_EMAIL = `${SQL_CRIADOR_NOME} AS usuario_nome,
        u.email AS usuario_email,
        u.numero_colaborador AS criador_numero_colaborador,
        u.username AS criador_username`;

/** Admin e perfis de armazém podem intervir apesar de outro utilizador ser o separador (ex.: operador separou, armazém gera TRFL). */
function ignoraBloqueioSeparador(role) {
  return (
    isAdmin(role) ||
    role === 'backoffice_armazem' ||
    role === 'supervisor_armazem'
  );
}

/** Admin pode corrigir preparação de linhas quando a requisição já está separada ou em expedição (antes de entrega). */
function adminPodeCorrigirPreparacaoItemSeparada(status, role) {
  if (!isAdmin(role)) return false;
  const st = String(status || '');
  return st === 'separado' || st === 'EM EXPEDICAO';
}

/** Operador: só separação e entrega; bloqueia TRFL/TRA/Reporte/Clog, criar/editar/apagar req., finalizar, marcar em expedição. */
function denyOperador(req, res, next) {
  if (req.user && isOperador(req.user.role)) {
    return res.status(403).json({
      error:
        'Operadores só podem consultar e separar requisições dos seus armazéns e marcar entrega; não podem executar esta operação.',
      code: 'OPERADOR_RESTRITO',
    });
  }
  next();
}

const SQL_SEPARADOR_NOME = `COALESCE(
  NULLIF(TRIM(CONCAT(COALESCE(su.nome, ''), ' ', COALESCE(su.sobrenome, ''))), ''),
  NULLIF(TRIM(COALESCE(su.username, '')), ''),
  NULLIF(TRIM(COALESCE(su.numero_colaborador::text, '')), ''),
  '—'
)`;

const SQL_LISTA_CRIADOR_E_SEPARADOR = `${SQL_CRIADOR_COM_EMAIL},
        r.separador_usuario_id,
        ${SQL_SEPARADOR_NOME} AS separador_nome`;

function createRequisicoesRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    authenticateToken,
    requisicaoScopeMiddleware,
    requisicaoArmazemOrigemAcessoPermitido,
    assertIdsRequisicoesPermitidas,
    excelUploadRequisicoes,
  } = deps;

  const router = express.Router();

  function respostaBloqueioSeparador(res) {
    return res.status(403).json({
      error:
        'Esta requisição está atribuída a outro utilizador para separação. Só esse utilizador, ou administrador/controller/backoffice armazém, pode continuar.',
      code: 'SEPARACAO_BLOQUEADA',
    });
  }

  /** Bloqueio só em separação ativa; após `separado` (ou outro estado), `separador_usuario_id` é só histórico. */
  function separadorImpedeAcao(row, req) {
    if (!row || row.separador_usuario_id == null) return false;
    if (ignoraBloqueioSeparador(req.user && req.user.role)) return false;
    if (String(row.status || '') !== 'EM SEPARACAO') return false;
    return Number(row.separador_usuario_id) !== Number(req.user && req.user.id);
  }

// ============================================
// ROTAS DE REQUISIÇÕES (V2 - Múltiplos Itens)
// ============================================

// Listar todas as requisições (com informações dos itens)
router.get('/', ...requisicaoAuth, async (req, res) => {
  try {
    if (usuarioEscopadoSemArmazensAtribuidos(req)) {
      return res.json([]);
    }
    const { status, armazem_id, item_id } = req.query;
    let itemIdParsed = null;
    if (item_id != null && String(item_id).trim() !== '') {
      const iid = parseInt(String(item_id), 10);
      if (Number.isFinite(iid)) itemIdParsed = iid;
    }
    const minhas =
      req.query.minhas === '1' ||
      req.query.minhas === 'true' ||
      String(req.query.minhas || '').toLowerCase() === 'sim';

    // Buscar requisições (armazem destino + armazem origem)
    let query = `
      SELECT 
        r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_LISTA_CRIADOR_E_SEPARADOR}
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND r.status = $${paramCount++}`;
      params.push(String(status));
    }

    if (armazem_id != null && String(armazem_id).trim() !== '') {
      const aid = parseInt(String(armazem_id), 10);
      if (Number.isFinite(aid)) {
        query += ` AND r.armazem_id = $${paramCount++}`;
        params.push(aid);
      }
    }

    if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
      query += ` AND r.armazem_origem_id = ANY($${paramCount++}::int[])`;
      params.push(req.requisicaoArmazemOrigemIds);
    }

    if (minhas) {
      if (!req.user || req.user.id == null) {
        return res.status(401).json({ error: 'Sessão inválida.' });
      }
      query += ` AND r.usuario_id = $${paramCount++}`;
      params.push(req.user.id);
    }

    query += ` ORDER BY r.created_at DESC`;

    const limParsed = parseInt(req.query.limit, 10);
    if (!Number.isNaN(limParsed) && limParsed > 0) {
      const lim = Math.min(2000, limParsed);
      const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
      query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(lim, off);
    }

    let requisicoesResult;
    try {
      requisicoesResult = await pool.query(query, params);
    } catch (qErr) {
      if (qErr.code === '42703') {
        let fallbackQuery = `
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_LISTA_CRIADOR_E_SEPARADOR}
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
          WHERE 1=1
        `;
        const fbParams = [];
        let pc = 1;
        if (status) {
          fallbackQuery += ` AND r.status = $${pc++}`;
          fbParams.push(String(status));
        }
        if (armazem_id != null && String(armazem_id).trim() !== '') {
          const aid = parseInt(String(armazem_id), 10);
          if (Number.isFinite(aid)) {
            fallbackQuery += ` AND r.armazem_id = $${pc++}`;
            fbParams.push(aid);
          }
        }
        if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
          fallbackQuery += ` AND r.armazem_origem_id = ANY($${pc++}::int[])`;
          fbParams.push(req.requisicaoArmazemOrigemIds);
        }
        if (minhas) {
          if (!req.user || req.user.id == null) {
            return res.status(401).json({ error: 'Sessão inválida.' });
          }
          fallbackQuery += ` AND r.usuario_id = $${pc++}`;
          fbParams.push(req.user.id);
        }
        fallbackQuery += ` ORDER BY r.created_at DESC`;
        if (!Number.isNaN(limParsed) && limParsed > 0) {
          const lim = Math.min(2000, limParsed);
          const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
          fallbackQuery += ` LIMIT $${pc} OFFSET $${pc + 1}`;
          fbParams.push(lim, off);
        }
        requisicoesResult = await pool.query(fallbackQuery, fbParams);
      } else {
        throw qErr;
      }
    }
    const requisicoes = requisicoesResult.rows;

    // Otimização: buscar todos os itens das requisições em uma única consulta (evita N+1 queries)
    if (requisicoes.length > 0) {
      const reqIds = requisicoes.map(r => r.id).filter(Boolean);
      let itensQuery = `
        SELECT
          ri.*,
          i.codigo as item_codigo,
          i.descricao as item_descricao
        FROM requisicoes_itens ri
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = ANY($1::int[])
      `;
      const itensParams = [reqIds];
      if (itemIdParsed != null) {
        itensQuery += ' AND ri.item_id = $2';
        itensParams.push(itemIdParsed);
      }
      itensQuery += ' ORDER BY ri.requisicao_id, ri.id';

      const itensResult = await pool.query(itensQuery, itensParams);
      const itensPorRequisicao = new Map();
      for (const row of itensResult.rows) {
        const list = itensPorRequisicao.get(row.requisicao_id) || [];
        list.push(row);
        itensPorRequisicao.set(row.requisicao_id, list);
      }

      for (const req of requisicoes) {
        req.itens = itensPorRequisicao.get(req.id) || [];
      }
    }

    // Filtrar requisições que não têm o item_id especificado (se filtro aplicado)
    const filteredRequisicoes =
      itemIdParsed != null ? requisicoes.filter((r) => r.itens && r.itens.length > 0) : requisicoes;

    res.json(filteredRequisicoes);
  } catch (error) {
    // Tabelas de requisições ainda não criadas - retornar lista vazia
    if (error.code === '42P01') {
      console.warn('⚠️ Tabelas "requisicoes" ou "armazens" não existem. Execute: server/create-armazens-requisicoes-v2.sql');
      return res.json([]);
    }
    console.error('Erro ao listar requisições:', error);
    res.status(500).json({ error: 'Erro ao listar requisições', details: error.message });
  }
});

// Exportar requisição no formato exigido pelo sistema da empresa (uma folha, colunas fixas)
router.get('/:id/export-excel', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;

    let reqResult;
    try {
      reqResult = await pool.query(`
        SELECT r.*,
          a.codigo as armazem_destino_codigo,
          ao.codigo as armazem_origem_codigo,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_NOME} AS usuario_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        reqResult = await pool.query(`
          SELECT r.*,
            a.codigo as armazem_destino_codigo,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_NOME} AS usuario_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
        if (reqResult.rows[0]) {
          reqResult.rows[0].armazem_origem_descricao = null;
          reqResult.rows[0].armazem_origem_codigo = null;
        }
      } else throw qErr;
    }

    if (reqResult.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    const requisicao = reqResult.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao,
        i.familia as item_familia, i.subfamilia as item_subfamilia
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);
    requisicao.itens = itensResult.rows;

    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
    const codigoOrigem = requisicao.armazem_origem_codigo || '';
    const codigoDestino = requisicao.armazem_destino_codigo || '';

    const rows = (requisicao.itens || [])
      .map(ri => {
        const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
          ? ri.quantidade_preparada
          : ri.quantidade;
        const qty = parseInt(qtyBase, 10) || 0;
        if (qty <= 0) return null;
        return {
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: ri.localizacao_origem || '',
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: '',
          SerialNumber2: '',
          MacAddress: '',
          CentroCusto: '',
          DestinationWarehouse: codigoDestino,
          DestinationLocation: ri.localizacao_destino || codigoDestino,
          ProjectCode: '',
          Batch: ''
        };
      })
      .filter(Boolean);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{
      Date: '', OriginWarehouse: '', OriginLocation: '', Article: '', Quatity: '',
      SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
      DestinationWarehouse: '', DestinationLocation: '', ProjectCode: '', Batch: ''
    }], { header: ['Date', 'OriginWarehouse', 'OriginLocation', 'Article', 'Quatity', 'SerialNumber1', 'SerialNumber2', 'MacAddress', 'CentroCusto', 'DestinationWarehouse', 'DestinationLocation', 'ProjectCode', 'Batch'] });

    XLSX.utils.book_append_sheet(wb, ws, 'Requisição');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao exportar requisição para Excel:', error);
    res.status(500).json({ error: 'Erro ao exportar requisição', details: error.message });
  }
});

// Fallback localização expedição (quando armazém central não tem expedição configurada)
const LOCALIZACAO_EXPEDICAO_FALLBACK = 'EXPEDICAO.E';

// Helper: gera buffer Excel com as colunas padrão (Date, OriginWarehouse, ... Batch)
function buildExcelTransferencia(rows, res, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{
    Date: '', OriginWarehouse: '', OriginLocation: '', Article: '', Quatity: '',
    SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
    DestinationWarehouse: '', DestinationLocation: '', ProjectCode: '', Batch: ''
  }], { header: ['Date', 'OriginWarehouse', 'OriginLocation', 'Article', 'Quatity', 'SerialNumber1', 'SerialNumber2', 'MacAddress', 'CentroCusto', 'DestinationWarehouse', 'DestinationLocation', 'ProjectCode', 'Batch'] });
  XLSX.utils.book_append_sheet(wb, ws, 'Dados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// Helper: gera ficheiro de reporte formatado no template
// (Artigo, Descrição, Quantidade, ORIGEM, S/N, LOTE, DESTINO[, Observações])
async function buildExcelReporte(rows, res, filename, opts = {}) {
  const includeObservacoes = Boolean(opts.includeObservacoes);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Reporte');

  const baseColumns = [
    { header: 'Artigo', key: 'Artigo', minWidth: 10, maxWidth: 22 },
    { header: 'Descrição', key: 'Descrição', minWidth: 18, maxWidth: 70 },
    { header: 'Quantidade', key: 'Quantidade', minWidth: 10, maxWidth: 18 },
    { header: 'ORIGEM', key: 'ORIGEM', minWidth: 12, maxWidth: 28 },
    { header: 'S/N', key: 'S/N', minWidth: 8, maxWidth: 20 },
    { header: 'LOTE', key: 'LOTE', minWidth: 10, maxWidth: 36 },
    { header: 'DESTINO', key: 'DESTINO', minWidth: 10, maxWidth: 20 }
  ];
  if (includeObservacoes) {
    baseColumns.push({ header: 'Observações', key: 'Observações', minWidth: 14, maxWidth: 45 });
  }

  const safeRows = rows.length
    ? rows
    : [{ Artigo: '', 'Descrição': '', Quantidade: '', ORIGEM: '', 'S/N': '', LOTE: '', DESTINO: '', 'Observações': '' }];

  // Largura automática por conteúdo (header + dados), com limites por coluna.
  const columnsWithWidth = baseColumns.map((col) => {
    const headerLen = String(col.header || '').length;
    let maxLen = headerLen;
    for (const r of safeRows) {
      const cellVal = r[col.key] === null || r[col.key] === undefined ? '' : String(r[col.key]);
      const len = cellVal.length;
      if (len > maxLen) maxLen = len;
    }
    // +2 de folga visual
    const calculated = maxLen + 2;
    const width = Math.max(col.minWidth, Math.min(col.maxWidth, calculated));
    return { header: col.header, key: col.key, width };
  });

  sheet.columns = columnsWithWidth;

  safeRows.forEach(r => sheet.addRow(r));

  // Cabeçalho no estilo do modelo (fundo cinza, texto claro, negrito)
  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF8C8C8C' }
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF404040' } },
      left: { style: 'thin', color: { argb: 'FF404040' } },
      bottom: { style: 'thin', color: { argb: 'FF404040' } },
      right: { style: 'thin', color: { argb: 'FF404040' } }
    };
  });

  // Corpo com espaçamento/legibilidade e bordas
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    row.height = 22;
    row.eachCell((cell, colNumber) => {
      cell.font = { size: 11 };
      cell.alignment = {
        vertical: 'middle',
        horizontal: (colNumber === 2 || (includeObservacoes && colNumber === baseColumns.length)) ? 'left' : 'center',
        wrapText: (colNumber === 2 || (includeObservacoes && colNumber === baseColumns.length))
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF808080' } },
        left: { style: 'thin', color: { argb: 'FF808080' } },
        bottom: { style: 'thin', color: { argb: 'FF808080' } },
        right: { style: 'thin', color: { argb: 'FF808080' } }
      };
    });
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// Helper: ficheiro Clog (saída de armazém) no formato aproximado do template
async function buildExcelClog(rows, res, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Clog');

  const baseColumns = [
    { header: 'Tipo de Movimento', key: 'Tipo de Movimento', minWidth: 16, maxWidth: 24 },
    { header: 'Dt_Recepção', key: 'Dt_Recepção', minWidth: 12, maxWidth: 16 },
    { header: 'REF.', key: 'REF.', minWidth: 8, maxWidth: 14 },
    { header: 'DESCRIPTION', key: 'DESCRIPTION', minWidth: 18, maxWidth: 55 },
    { header: 'QTY', key: 'QTY', minWidth: 8, maxWidth: 16 },
    { header: 'Loc_Inicial', key: 'Loc_Inicial', minWidth: 12, maxWidth: 20 },
    { header: 'S/N', key: 'S/N', minWidth: 8, maxWidth: 18 },
    { header: 'Lote', key: 'Lote', minWidth: 10, maxWidth: 18 },
    { header: 'Novo Armazém', key: 'Novo Armazém', minWidth: 12, maxWidth: 18 },
    { header: 'TRA / DEV', key: 'TRA / DEV', minWidth: 10, maxWidth: 16 },
    { header: 'New Localização', key: 'New Localização', minWidth: 14, maxWidth: 22 },
    { header: 'DEP', key: 'DEP', minWidth: 6, maxWidth: 12 },
    { header: 'Observações', key: 'Observações', minWidth: 14, maxWidth: 30 }
  ];

  const safeRows = rows.length
    ? rows
    : [{
        'Tipo de Movimento': '',
        'Dt_Recepção': '',
        'REF.': '',
        DESCRIPTION: '',
        QTY: '',
        Loc_Inicial: '',
        'S/N': '',
        Lote: '',
        'Novo Armazém': '',
        'TRA / DEV': '',
        'New Localização': '',
        DEP: '',
        Observações: ''
      }];

  const rowCount = safeRows.length;
  // Largura fixa (média min/max): evita O(linhas × colunas) que destróia desempenho em requisições grandes.
  sheet.columns = baseColumns.map((col) => ({
    header: col.header,
    key: col.key,
    width: Math.min(col.maxWidth, Math.max(col.minWidth, Math.ceil((col.minWidth + col.maxWidth) / 2)))
  }));

  // Uma operação em lote em vez de addRow por linha
  sheet.addRows(safeRows);

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF8C8C8C' }
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF404040' } },
      left: { style: 'thin', color: { argb: 'FF404040' } },
      bottom: { style: 'thin', color: { argb: 'FF404040' } },
      right: { style: 'thin', color: { argb: 'FF404040' } }
    };
  });

  // Corpo: para muitas linhas, bordas/célula são o maior custo no ExcelJS — formato leve.
  const LIMITE_ESTILO_CORPO = 400;
  if (rowCount <= LIMITE_ESTILO_CORPO) {
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      row.height = 20;
      row.eachCell((cell, colNumber) => {
        cell.font = { size: 10 };
        const isDesc = colNumber === 4;
        const isObs = colNumber === baseColumns.length;
        cell.alignment = {
          vertical: 'middle',
          horizontal: (isDesc || isObs) ? 'left' : 'center',
          wrapText: (isDesc || isObs)
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF808080' } },
          left: { style: 'thin', color: { argb: 'FF808080' } },
          bottom: { style: 'thin', color: { argb: 'FF808080' } },
          right: { style: 'thin', color: { argb: 'FF808080' } }
        };
      });
    }
  } else {
    sheet.getColumn(4).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    sheet.getColumn(baseColumns.length).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// Buscar requisição + itens (reutilizado por TRFL e TRA).
// includeItens=false evita consulta pesada quando os itens são carregados noutro passo (ex.: Clog).
async function getRequisicaoComItens(id, includeItens = true) {
  let reqResult = await pool.query(`
    SELECT r.*,
      a.codigo as armazem_destino_codigo,
      a.descricao as armazem_destino_descricao,
      ao.codigo as armazem_origem_codigo
    FROM requisicoes r
    INNER JOIN armazens a ON r.armazem_id = a.id
    LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
    WHERE r.id = $1
  `, [id]);
  if (reqResult.rows.length === 0) return null;
  const requisicao = reqResult.rows[0];
  if (!includeItens) {
    requisicao.itens = [];
    return requisicao;
  }
  const itensResult = await pool.query(`
    SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo
    FROM requisicoes_itens ri
    INNER JOIN itens i ON ri.item_id = i.id
    WHERE ri.requisicao_id = $1
    ORDER BY ri.id
  `, [id]);
  requisicao.itens = itensResult.rows;
  return requisicao;
}

function isDestinoEPI(requisicao) {
  const codigo = String(requisicao?.armazem_destino_codigo || '').toUpperCase();
  const descricao = String(requisicao?.armazem_destino_descricao || '').toUpperCase();
  return codigo.includes('EPI') || descricao.includes('EPI');
}

/** Reporte/Clog: em Entregue exige TRA (`tra_gerada_em`); em FINALIZADO permite mesmo sem data (dados antigos / fluxo sem registo). */
function podeExportarReporteOuClog(requisicao) {
  const st = requisicao?.status;
  if (!['Entregue', 'FINALIZADO'].includes(st)) return false;
  if (st === 'FINALIZADO') return true;
  return !!requisicao?.tra_gerada_em;
}

function formatDateBR(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// TRFL — Só quando armazém de origem é geral (central). Destino = localização de expedição do armazém de origem.
router.get('/:id/export-trfl', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!requisicao.separacao_confirmada) {
      return res.status(400).json({ error: 'TRFL só está disponível após confirmar a separação da requisição.' });
    }
    if (!['separado', 'EM EXPEDICAO', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) {
      return res.status(400).json({ error: 'TRFL só está disponível após confirmar a separação (status Separado). Conclua a preparação primeiro.' });
    }

    if (!requisicao.armazem_origem_id) {
      return res.status(400).json({ error: 'TRFL só está disponível quando a requisição tem armazém de origem.' });
    }
    const armazemOrigem = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
    if (armazemOrigem.rows.length === 0) {
      return res.status(400).json({ error: 'Armazém de origem não encontrado.' });
    }
    const ao = armazemOrigem.rows[0];
    const tipoOrigem = (ao.tipo || '').toLowerCase();
    if (tipoOrigem !== 'central') {
      return res.status(400).json({ error: 'TRFL só é gerado quando o armazém de origem é um armazém geral (central). Esta requisição tem origem em armazém viatura.' });
    }

    let localizacaoExpedicao = LOCALIZACAO_EXPEDICAO_FALLBACK;
    const locExp = await pool.query(
      `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
      [requisicao.armazem_origem_id]
    );
    if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
      localizacaoExpedicao = locExp.rows[0].localizacao;
    }

    const codigoOrigem = ao.codigo || 'E';
    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    // Buscar bobinas (para itens de controle por lote)
    let bobinas = [];
    try {
      const bobinasResult = await pool.query(`
        SELECT b.*, ri.item_id, i.codigo as item_codigo
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
      `, [id]);
      bobinas = bobinasResult.rows;
    } catch (_) {
      bobinas = [];
    }

    const rows = [];

    // Linhas por bobina (cada bobina = uma linha)
    for (const b of bobinas) {
      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: requisicao.itens.find(it => it.item_id === b.item_id)?.localizacao_origem || '',
        Article: String(b.item_codigo || ''),
        Quatity: Number(b.metros) || 0,
        SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoOrigem,
        DestinationLocation: localizacaoExpedicao,
        ProjectCode: '',
        Batch: b.lote || ''
      });
    }

    // Itens sem bobinas (controle por quantidade / S/N, etc.)
    for (const ri of requisicao.itens || []) {
      const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
      const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
      if (tipoControlo === 'LOTE' && temBobinas) continue;

      const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
      if (qty <= 0) continue;
      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: ri.localizacao_origem || '',
        Article: String(ri.item_codigo || ''),
        Quatity: qty,
        SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoOrigem,
        DestinationLocation: localizacaoExpedicao,
        ProjectCode: '',
        Batch: ri.lote || ''
      });
    }

    // Exportação TRFL não altera status; o frontend confirma e chama /marcar-em-expedicao
    buildExcelTransferencia(rows, res, `TRFL_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRFL:', error);
    res.status(500).json({ error: 'Erro ao exportar TRFL', details: error.message });
  }
});

// TRFL combinado — várias requisições em um único ficheiro
router.post('/export-trfl-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    let allRows = [];

    for (const rawId of ids) {
      const id = parseInt(rawId, 10);
      if (!id) continue;
      const requisicao = await getRequisicaoComItens(id);
      if (!requisicao) continue;
      if (!requisicao.separacao_confirmada) continue;
      if (!['separado', 'EM EXPEDICAO', 'Entregue'].includes(requisicao.status)) continue;
      if (!requisicao.armazem_origem_id) continue;

      const armazemOrigem = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
      if (armazemOrigem.rows.length === 0) continue;
      const ao = armazemOrigem.rows[0];
      const tipoOrigem = (ao.tipo || '').toLowerCase();
      if (tipoOrigem !== 'central') continue;

      let localizacaoExpedicao = LOCALIZACAO_EXPEDICAO_FALLBACK;
      const locExp = await pool.query(
        `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
        [requisicao.armazem_origem_id]
      );
      if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
        localizacaoExpedicao = locExp.rows[0].localizacao;
      }

      const codigoOrigem = ao.codigo || 'E';
      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(`
          SELECT b.*, ri.item_id, i.codigo as item_codigo
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
        `, [id]);
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
      }

      const rows = [];

      for (const b of bobinas) {
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: requisicao.itens.find(it => it.item_id === b.item_id)?.localizacao_origem || '',
          Article: String(b.item_codigo || ''),
          Quatity: Number(b.metros) || 0,
          SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoOrigem,
          DestinationLocation: localizacaoExpedicao,
          ProjectCode: '',
          Batch: b.lote || ''
        });
      }

      for (const ri of requisicao.itens || []) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;
        const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
        if (qty <= 0) continue;

        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: ri.localizacao_origem || '',
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoOrigem,
          DestinationLocation: localizacaoExpedicao,
          ProjectCode: '',
          Batch: ri.lote || ''
        });
      }

      if (rows.length > 0) {
        allRows = allRows.concat(rows);
      }
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição válida para exportar TRFL combinado.' });
    }

    buildExcelTransferencia(allRows, res, `TRFL_multi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRFL multi:', error);
    res.status(500).json({ error: 'Erro ao exportar TRFL combinado', details: error.message });
  }
});

// TRA — Transferência: origem = mesmo destino da TRFL (armazém origem + expedição) → destino (Vxxx). Alinhado à TRFL.
router.get('/:id/export-tra', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!requisicao.separacao_confirmada) {
      return res.status(400).json({ error: 'TRA só está disponível após confirmar a separação da requisição.' });
    }
    if (!['EM EXPEDICAO', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) {
      return res.status(400).json({ error: 'TRA só está disponível após concluir a TRFL (requisição deve estar Em expedição). Baixe o ficheiro TRFL primeiro.' });
    }

    const codigoOrigem = requisicao.armazem_origem_codigo || 'E';
    const codigoDestino = requisicao.armazem_destino_codigo || '';
    const armazemDestinoId = requisicao.armazem_id;

    // Localização de origem da TRA = mesmo destino da TRFL (expedição do armazém de origem)
    let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
    if (requisicao.armazem_origem_id) {
      const locExp = await pool.query(
        `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
        [requisicao.armazem_origem_id]
      );
      if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
        localizacaoOrigemTRA = locExp.rows[0].localizacao;
      }
    }

    // Localizações do armazém destino: uma com .FERR (ferramentas) e outra sem (demais itens)
    let localizacaoFERR = codigoDestino + '.FERR';
    let localizacaoNormal = codigoDestino;
    try {
      const locResult = await pool.query(
        'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
        [armazemDestinoId]
      );
      if (locResult.rows.length > 0) {
        const locs = locResult.rows.map(r => r.localizacao);
        const comFerr = locs.find(l => (l || '').toUpperCase().includes('.FERR'));
        const semFerr = locs.find(l => !(l || '').toUpperCase().includes('.FERR'));
        if (comFerr) localizacaoFERR = comFerr;
        if (semFerr) localizacaoNormal = semFerr;
      }
    } catch (_) {
      // Tabela pode não existir; usar codigo e codigo.FERR
    }

    // Itens com flag is_ferramenta (setor FERRAMENTA em itens_setores)
    let itensComFerramenta = [];
    try {
      const itensResult = await pool.query(`
        SELECT ri.*, i.codigo as item_codigo, i.tipocontrolo,
          EXISTS (
            SELECT 1 FROM itens_setores is2
            WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
          ) as is_ferramenta
        FROM requisicoes_itens ri
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
        ORDER BY ri.id
      `, [id]);
      itensComFerramenta = itensResult.rows;
    } catch (_) {
      itensComFerramenta = (requisicao.itens || []).map(ri => ({ ...ri, is_ferramenta: false }));
    }

    // Bobinas para TRA (uma linha por bobina)
    let bobinas = [];
    try {
      const bobinasResult = await pool.query(`
        SELECT b.*, ri.item_id, i.codigo as item_codigo
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
      `, [id]);
      bobinas = bobinasResult.rows;
    } catch (_) {
      bobinas = [];
    }

    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    const rows = [];

    // Linhas por bobina (para itens de controle por lote)
    for (const b of bobinas) {
      const ri = itensComFerramenta.find(it => it.item_id === b.item_id) || {};
      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: localizacaoOrigemTRA,
        Article: String(b.item_codigo || ''),
        Quatity: Number(b.metros) || 0,
        SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoDestino,
        DestinationLocation: ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
        ProjectCode: '',
        Batch: b.lote || ''
      });
    }

    // Itens sem bobinas
    for (const ri of itensComFerramenta) {
      const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
      const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
      if (tipoControlo === 'LOTE' && temBobinas) continue;

      const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
        ? ri.quantidade_preparada
        : ri.quantidade;
      const qty = parseInt(qtyBase, 10) || 0;
      if (qty <= 0) continue;

      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: localizacaoOrigemTRA,
        Article: String(ri.item_codigo || ''),
        Quatity: qty,
        SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoDestino,
        DestinationLocation: ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
        ProjectCode: '',
        Batch: ri.lote || ''
      });
    }

    // Registra a primeira geração de TRA (para liberar FINALIZAR no frontend)
    try {
      await pool.query(
        `UPDATE requisicoes
         SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id]
      );
    } catch (_) {}

    // Exportação TRA não altera status
    buildExcelTransferencia(rows, res, `TRA_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRA:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA', details: error.message });
  }
});

// TRA combinado — várias requisições em um único ficheiro
router.post('/export-tra-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    let allRows = [];

    for (const rawId of ids) {
      const id = parseInt(rawId, 10);
      if (!id) continue;
      const requisicao = await getRequisicaoComItens(id);
      if (!requisicao) continue;
      if (!requisicao.separacao_confirmada) continue;
      if (!['Entregue', 'FINALIZADO'].includes(requisicao.status)) continue;

      const codigoOrigem = requisicao.armazem_origem_codigo || 'E';
      const codigoDestino = requisicao.armazem_destino_codigo || '';
      const armazemDestinoId = requisicao.armazem_id;

      let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
      if (requisicao.armazem_origem_id) {
        const locExp = await pool.query(
          `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
          [requisicao.armazem_origem_id]
        );
        if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
          localizacaoOrigemTRA = locExp.rows[0].localizacao;
        }
      }

      let localizacaoFERR = codigoDestino + '.FERR';
      let localizacaoNormal = codigoDestino;
      try {
        const locResult = await pool.query(
          'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [armazemDestinoId]
        );
        if (locResult.rows.length > 0) {
          const locs = locResult.rows.map(r => r.localizacao);
          const comFerr = locs.find(l => (l || '').toUpperCase().includes('.FERR'));
          const semFerr = locs.find(l => !(l || '').toUpperCase().includes('.FERR'));
          if (comFerr) localizacaoFERR = comFerr;
          if (semFerr) localizacaoNormal = semFerr;
        }
      } catch (_) {
        // fallback já definido
      }

      let itensComFerramenta = [];
      try {
        const itensResult = await pool.query(`
          SELECT ri.*, i.codigo as item_codigo, i.tipocontrolo,
            EXISTS (
              SELECT 1 FROM itens_setores is2
              WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
            ) as is_ferramenta
          FROM requisicoes_itens ri
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
          ORDER BY ri.id
        `, [id]);
        itensComFerramenta = itensResult.rows;
      } catch (_) {
        itensComFerramenta = (requisicao.itens || []).map(ri => ({ ...ri, is_ferramenta: false }));
      }

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(`
          SELECT b.*, ri.item_id, i.codigo as item_codigo
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
        `, [id]);
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
      }

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

      const rows = [];

      for (const b of bobinas) {
        const ri = itensComFerramenta.find(it => it.item_id === b.item_id) || {};
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: localizacaoOrigemTRA,
          Article: String(b.item_codigo || ''),
          Quatity: Number(b.metros) || 0,
          SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoDestino,
          DestinationLocation: ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
          ProjectCode: '',
          Batch: b.lote || ''
        });
      }

      for (const ri of itensComFerramenta) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;

        const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
          ? ri.quantidade_preparada
          : ri.quantidade;
        const qty = parseInt(qtyBase, 10) || 0;
        if (qty <= 0) continue;

        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: localizacaoOrigemTRA,
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoDestino,
          DestinationLocation: ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
          ProjectCode: '',
          Batch: ri.lote || ''
        });
      }

      if (rows.length > 0) {
        allRows = allRows.concat(rows);
      }
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição válida para exportar TRA combinado.' });
    }

    // Registra a primeira geração de TRA para todas as requisições enviadas (best-effort)
    try {
      const cleanIds = ids.map(x => parseInt(x, 10)).filter(Boolean);
      if (cleanIds.length > 0) {
        await pool.query(
          `UPDATE requisicoes
           SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
           WHERE id = ANY($1::int[])`,
          [cleanIds]
        );
      }
    } catch (_) {}

    buildExcelTransferencia(allRows, res, `TRA_multi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRA multi:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA combinado', details: error.message });
  }
});

// Clog — saída de armazém (quantidades negativas) baseado na TRA gerada
function computeDestLocFerrNormal(codigoDestino, locResultRows) {
  let localizacaoFERR = codigoDestino + '.FERR';
  let localizacaoNormal = codigoDestino;
  if (locResultRows && locResultRows.length > 0) {
    const locs = locResultRows.map((r) => r.localizacao);
    const comFerr = locs.find((l) => (l || '').toUpperCase().includes('.FERR'));
    const semFerr = locs.find((l) => !(l || '').toUpperCase().includes('.FERR'));
    if (comFerr) localizacaoFERR = comFerr;
    if (semFerr) localizacaoNormal = semFerr;
  }
  return { localizacaoFERR, localizacaoNormal };
}

function clogRowsFromItemData(
  dateStr,
  codigoDestino,
  colaboradorObs,
  localizacaoOrigemTRA,
  localizacaoFERR,
  localizacaoNormal,
  itensComFerramenta,
  bobinas
) {
  const rows = [];
  const itemByItemId = new Map(itensComFerramenta.map((it) => [it.item_id, it]));
  const itemIdsComBobina = new Set(bobinas.map((b) => b.item_id));

  for (const b of bobinas) {
    const itemMeta = itemByItemId.get(b.item_id) || {};
    const qty = -Number(b.metros) || 0;
    if (qty === 0) continue;

    rows.push({
      'Tipo de Movimento': 'Saida de Armazem',
      'Dt_Recepção': dateStr,
      'REF.': String(b.item_codigo || ''),
      DESCRIPTION: String(b.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: localizacaoOrigemTRA,
      'S/N': b.serialnumber || '',
      Lote: b.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': '',
      'New Localização': itemMeta.is_ferramenta ? localizacaoFERR : localizacaoNormal,
      DEP: '',
      Observações: colaboradorObs
    });
  }

  for (const ri of itensComFerramenta) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    if (tipoControlo === 'LOTE' && itemIdsComBobina.has(ri.item_id)) continue;

    const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
      ? ri.quantidade_preparada
      : ri.quantidade;
    const qty = -Number(qtyBase) || 0;
    if (qty === 0) continue;

    rows.push({
      'Tipo de Movimento': 'Saida de Armazem',
      'Dt_Recepção': dateStr,
      'REF.': String(ri.item_codigo || ''),
      DESCRIPTION: String(ri.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: localizacaoOrigemTRA,
      'S/N': ri.serialnumber || '',
      Lote: ri.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': '',
      'New Localização': ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
      DEP: '',
      Observações: colaboradorObs
    });
  }

  return rows;
}

/** Várias requisições: ~4–5 queries em vez de ~5N (muito mais rápido para Clog multi). */
async function buildClogRowsForRequisicaoIds(idsClean, dateStr) {
  if (!idsClean.length) return [];

  const idsUnique = [...new Set(idsClean)];
  const reqRes = await pool.query(`
    SELECT r.*,
      a.codigo as armazem_destino_codigo,
      a.descricao as armazem_destino_descricao,
      ao.codigo as armazem_origem_codigo
    FROM requisicoes r
    INNER JOIN armazens a ON r.armazem_id = a.id
    LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
    WHERE r.id = ANY($1::int[])
  `, [idsUnique]);

  const byId = new Map(reqRes.rows.map((r) => [r.id, r]));
  const candidatas = idsClean.map((id) => byId.get(id)).filter(Boolean)
    .filter((r) => podeExportarReporteOuClog(r) && r.armazem_origem_id);
  if (candidatas.length === 0) return [];

  const origemIds = [...new Set(candidatas.map((r) => r.armazem_origem_id))];
  const armRes = await pool.query(
    'SELECT id, codigo, tipo FROM armazens WHERE id = ANY($1::int[])',
    [origemIds]
  );
  const armById = new Map(armRes.rows.map((a) => [a.id, a]));

  const central = candidatas.filter((r) => {
    const a = armById.get(r.armazem_origem_id);
    return a && String(a.tipo || '').toLowerCase() === 'central';
  });
  if (central.length === 0) return [];

  const requisicaoIdsCentral = [...new Set(central.map((r) => r.id))];
  const origemIdsCentral = [...new Set(central.map((r) => r.armazem_origem_id))];
  const destArmIds = [...new Set(central.map((r) => r.armazem_id))];

  const [expRes, allLocsRes, itensRes, bobRes] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (al.armazem_id) al.armazem_id, al.localizacao
       FROM armazens_localizacoes al
       WHERE al.armazem_id = ANY($1::int[])
         AND LOWER(COALESCE(al.tipo_localizacao, '')) = 'expedicao'
       ORDER BY al.armazem_id, al.id`,
      [origemIdsCentral]
    ),
    pool.query(
      `SELECT armazem_id, localizacao, id
       FROM armazens_localizacoes
       WHERE armazem_id = ANY($1::int[])
       ORDER BY armazem_id, id`,
      [destArmIds]
    ),
    pool.query(`
      SELECT ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao,
        i.tipocontrolo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) as is_ferramenta
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = ANY($1::int[])
      ORDER BY ri.requisicao_id, ri.id
    `, [requisicaoIdsCentral]),
    pool.query(`
      SELECT b.*,
        ri.requisicao_id,
        ri.item_id,
        i.codigo as item_codigo,
        i.descricao as item_descricao
      FROM requisicoes_itens_bobinas b
      INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = ANY($1::int[])
    `, [requisicaoIdsCentral])
  ]);

  const expByArm = new Map(expRes.rows.map((row) => [row.armazem_id, row.localizacao]));
  const locsByDestArm = new Map();
  for (const row of allLocsRes.rows) {
    if (!locsByDestArm.has(row.armazem_id)) locsByDestArm.set(row.armazem_id, []);
    locsByDestArm.get(row.armazem_id).push(row);
  }

  const itensByReq = new Map();
  for (const row of itensRes.rows) {
    if (!itensByReq.has(row.requisicao_id)) itensByReq.set(row.requisicao_id, []);
    itensByReq.get(row.requisicao_id).push(row);
  }
  const bobByReq = new Map();
  for (const row of bobRes.rows) {
    if (!bobByReq.has(row.requisicao_id)) bobByReq.set(row.requisicao_id, []);
    bobByReq.get(row.requisicao_id).push(row);
  }

  const centralEligibleById = new Map(central.map((r) => [r.id, r]));
  const allRows = [];

  for (const id of idsClean) {
    const r = centralEligibleById.get(id);
    if (!r) continue;
    const codigoDestino = r.armazem_destino_codigo || '';
    const localizacaoOrigemTRA = expByArm.get(r.armazem_origem_id) || LOCALIZACAO_EXPEDICAO_FALLBACK;
    const locRows = locsByDestArm.get(r.armazem_id) || [];
    const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(codigoDestino, locRows);
    const itens = itensByReq.get(id) || [];
    const bobinas = bobByReq.get(id) || [];
    const rows = clogRowsFromItemData(
      dateStr,
      codigoDestino,
      r.observacoes || '',
      localizacaoOrigemTRA,
      localizacaoFERR,
      localizacaoNormal,
      itens,
      bobinas
    );
    allRows.push(...rows);
  }

  return allRows;
}

async function buildClogRowsFromRequisicao(requisicao, dateStr) {
  if (!requisicao?.armazem_origem_id) return { rows: [], eligible: false, reason: 'Requisição sem armazém de origem.' };

  const armazemOrigem = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
  if (armazemOrigem.rows.length === 0) {
    return { rows: [], eligible: false, reason: 'Armazém de origem não encontrado.' };
  }
  const tipoOrigem = (armazemOrigem.rows[0].tipo || '').toLowerCase();
  if (tipoOrigem !== 'central') {
    return { rows: [], eligible: false, reason: 'Clog só é gerado quando a origem é armazém central.' };
  }

  const codigoDestino = requisicao.armazem_destino_codigo || '';
  const armazemDestinoId = requisicao.armazem_id;

  let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
  if (requisicao.armazem_origem_id) {
    const locExp = await pool.query(
      `SELECT localizacao
       FROM armazens_localizacoes
       WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao'
       ORDER BY id
       LIMIT 1`,
      [requisicao.armazem_origem_id]
    );
    if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
      localizacaoOrigemTRA = locExp.rows[0].localizacao;
    }
  }

  let locResultRows = [];
  try {
    const locResult = await pool.query(
      'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
      [armazemDestinoId]
    );
    locResultRows = locResult.rows;
  } catch (_) {
    locResultRows = [];
  }
  const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(codigoDestino, locResultRows);

  let itensComFerramenta = [];
  try {
    const itensResult = await pool.query(`
      SELECT ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao,
        i.tipocontrolo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) as is_ferramenta
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [requisicao.id]);
    itensComFerramenta = itensResult.rows;
  } catch (_) {
    itensComFerramenta = (requisicao.itens || []).map((riRow) => ({ ...riRow, is_ferramenta: false }));
  }

  let bobinas = [];
  try {
    const bobinasResult = await pool.query(`
      SELECT b.*,
        ri.item_id,
        i.codigo as item_codigo,
        i.descricao as item_descricao
      FROM requisicoes_itens_bobinas b
      INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [requisicao.id]);
    bobinas = bobinasResult.rows;
  } catch (_) {
    bobinas = [];
  }

  const colaboradorObs = requisicao.observacoes || '';
  const rows = clogRowsFromItemData(
    dateStr,
    codigoDestino,
    colaboradorObs,
    localizacaoOrigemTRA,
    localizacaoFERR,
    localizacaoNormal,
    itensComFerramenta,
    bobinas
  );

  return { rows, eligible: true };
}

router.get('/:id/export-clog', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id, false);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteOuClog(requisicao)) {
      return res.status(400).json({ error: 'Clog só está disponível após gerar a TRA (Entregue) ou quando a requisição estiver finalizada.' });
    }

    const dateStr = formatDateBR(new Date());
    const { rows, eligible, reason } = await buildClogRowsFromRequisicao(requisicao, dateStr);
    if (!eligible || rows.length === 0) {
      return res.status(400).json({ error: reason || 'Nenhuma linha elegível para Clog.' });
    }

    await buildExcelClog(rows, res, `CLOG_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar Clog:', error);
    res.status(500).json({ error: 'Erro ao exportar Clog', details: error.message });
  }
});

router.post('/export-clog-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    const idsClean = ids.map(x => parseInt(x, 10)).filter(Boolean);
    const dateStr = formatDateBR(new Date());
    const allRows = await buildClogRowsForRequisicaoIds(idsClean, dateStr);

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição elegível para gerar Clog (origem central; TRA em Entregue ou requisição finalizada).' });
    }

    await buildExcelClog(allRows, res, `CLOG_multi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar Clog multi:', error);
    res.status(500).json({ error: 'Erro ao exportar Clog multi', details: error.message });
  }
});

router.get('/:id/clog-dados', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id, false);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteOuClog(requisicao)) {
      return res.status(400).json({ error: 'Clog só está disponível após gerar a TRA (Entregue) ou quando a requisição estiver finalizada.' });
    }

    const dateStr = formatDateBR(new Date());
    const { rows, eligible, reason } = await buildClogRowsFromRequisicao(requisicao, dateStr);
    if (!eligible || rows.length === 0) {
      return res.status(400).json({ error: reason || 'Nenhuma linha elegível para Clog.' });
    }

    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'DEP', 'Observações'];
    res.json({ columns, rows });
  } catch (error) {
    console.error('Erro ao obter dados do Clog:', error);
    res.status(500).json({ error: 'Erro ao obter dados do Clog', details: error.message });
  }
});

router.post('/clog-dados-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    const idsClean = ids.map(x => parseInt(x, 10)).filter(Boolean);
    const dateStr = formatDateBR(new Date());
    const allRows = await buildClogRowsForRequisicaoIds(idsClean, dateStr);

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição elegível para Clog (origem central; TRA em Entregue ou requisição finalizada).' });
    }

    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'DEP', 'Observações'];
    res.json({ columns, rows: allRows });
  } catch (error) {
    console.error('Erro ao obter dados do Clog multi:', error);
    res.status(500).json({ error: 'Erro ao obter dados do Clog multi', details: error.message });
  }
});

// Ficheiro de Reporte (template): disponível após gerar TRA
router.get('/:id/export-reporte', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteOuClog(requisicao)) {
      return res.status(400).json({ error: 'Ficheiro de reporte só está disponível após gerar a TRA (Entregue) ou quando a requisição estiver finalizada.' });
    }

    // Mesma origem/destino usados na TRA
    const codigoDestino = requisicao.armazem_destino_codigo || '';
    let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
    if (requisicao.armazem_origem_id) {
      const locExp = await pool.query(
        `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
        [requisicao.armazem_origem_id]
      );
      if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
        localizacaoOrigemTRA = locExp.rows[0].localizacao;
      }
    }

    let bobinas = [];
    try {
      const bobinasResult = await pool.query(`
        SELECT b.*, ri.item_id, i.codigo as item_codigo, i.descricao as item_descricao
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
      `, [id]);
      bobinas = bobinasResult.rows;
    } catch (_) {
      bobinas = [];
    }

    const destinoEPI = isDestinoEPI(requisicao);
    const colaboradorObs = destinoEPI ? (requisicao.observacoes || '') : '';
    const rows = [];
    for (const b of bobinas) {
      rows.push({
        Artigo: String(b.item_codigo || ''),
        'Descrição': String(b.item_descricao || ''),
        Quantidade: Number(b.metros) || 0,
        ORIGEM: localizacaoOrigemTRA,
        'S/N': b.serialnumber || '',
        LOTE: b.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    for (const ri of requisicao.itens || []) {
      const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
      const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
      if (tipoControlo === 'LOTE' && temBobinas) continue;

      const qty = parseFloat(ri.quantidade_preparada ?? ri.quantidade) || 0;
      if (qty <= 0) continue;
      rows.push({
        Artigo: String(ri.item_codigo || ''),
        'Descrição': String(ri.item_descricao || ''),
        Quantidade: qty,
        ORIGEM: localizacaoOrigemTRA,
        'S/N': ri.serialnumber || '',
        LOTE: ri.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    await buildExcelReporte(
      rows,
      res,
      `REPORTE_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      { includeObservacoes: destinoEPI }
    );
  } catch (error) {
    console.error('Erro ao exportar reporte:', error);
    res.status(500).json({ error: 'Erro ao exportar reporte', details: error.message });
  }
});

// Retorna os dados do ficheiro de reporte (para copiar a tabela sem baixar o XLSX)
router.get('/:id/reporte-dados', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteOuClog(requisicao)) {
      return res.status(400).json({ error: 'Dados do reporte só estão disponíveis após gerar a TRA (Entregue) ou quando a requisição estiver finalizada.' });
    }

    const destinoEPI = isDestinoEPI(requisicao);
    const colaboradorObs = destinoEPI ? (requisicao.observacoes || '') : '';

    // Mesma origem/destino usados na TRA
    const codigoDestino = requisicao.armazem_destino_codigo || '';
    let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
    if (requisicao.armazem_origem_id) {
      const locExp = await pool.query(
        `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
        [requisicao.armazem_origem_id]
      );
      if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
        localizacaoOrigemTRA = locExp.rows[0].localizacao;
      }
    }

    let bobinas = [];
    try {
      const bobinasResult = await pool.query(`
        SELECT b.*, ri.item_id, i.codigo as item_codigo, i.descricao as item_descricao
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
      `, [id]);
      bobinas = bobinasResult.rows;
    } catch (_) {
      bobinas = [];
    }

    const rows = [];
    for (const b of bobinas) {
      rows.push({
        Artigo: String(b.item_codigo || ''),
        'Descrição': String(b.item_descricao || ''),
        Quantidade: Number(b.metros) || 0,
        ORIGEM: localizacaoOrigemTRA,
        'S/N': b.serialnumber || '',
        LOTE: b.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    for (const ri of requisicao.itens || []) {
      const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
      const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
      if (tipoControlo === 'LOTE' && temBobinas) continue;

      const qty = parseFloat(ri.quantidade_preparada ?? ri.quantidade) || 0;
      if (qty <= 0) continue;

      rows.push({
        Artigo: String(ri.item_codigo || ''),
        'Descrição': String(ri.item_descricao || ''),
        Quantidade: qty,
        ORIGEM: localizacaoOrigemTRA,
        'S/N': ri.serialnumber || '',
        LOTE: ri.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    const columns = ['Artigo', 'Descrição', 'Quantidade', 'ORIGEM', 'S/N', 'LOTE', 'DESTINO'];
    if (destinoEPI) columns.push('Observações');

    res.json({ columns, rows });
  } catch (error) {
    console.error('Erro ao obter dados do reporte:', error);
    res.status(500).json({ error: 'Erro ao obter dados do reporte', details: error.message });
  }
});

// Dados do ficheiro de reporte (multi)
router.post('/reporte-dados-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    const allRows = [];
    let includeObservacoes = false;
    const idsClean = ids.map(x => parseInt(x, 10)).filter(Boolean);

    for (const id of idsClean) {
      if (!id) continue;

      const requisicao = await getRequisicaoComItens(id);
      if (!requisicao) continue;
      if (!podeExportarReporteOuClog(requisicao)) continue;

      const destinoEPI = isDestinoEPI(requisicao);
      if (destinoEPI) includeObservacoes = true;
      const colaboradorObs = destinoEPI ? (requisicao.observacoes || '') : '';

      // Linha de separação entre requisições
      allRows.push({
        Artigo: `--- Requisição #${id} ---`,
        'Descrição': '',
        Quantidade: '',
        ORIGEM: '',
        'S/N': '',
        LOTE: '',
        DESTINO: '',
        ...(destinoEPI ? { 'Observações': '' } : {})
      });

      const codigoDestino = requisicao.armazem_destino_codigo || '';
      let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
      if (requisicao.armazem_origem_id) {
        const locExp = await pool.query(
          `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
          [requisicao.armazem_origem_id]
        );
        if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
          localizacaoOrigemTRA = locExp.rows[0].localizacao;
        }
      }

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(`
          SELECT b.*, ri.item_id, i.codigo as item_codigo, i.descricao as item_descricao
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
        `, [id]);
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
      }

      for (const b of bobinas) {
        allRows.push({
          Artigo: String(b.item_codigo || ''),
          'Descrição': String(b.item_descricao || ''),
          Quantidade: Number(b.metros) || 0,
          ORIGEM: localizacaoOrigemTRA,
          'S/N': b.serialnumber || '',
          LOTE: b.lote || '',
          DESTINO: codigoDestino,
          'Observações': colaboradorObs
        });
      }

      for (const ri of requisicao.itens || []) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;

        const qty = parseFloat(ri.quantidade_preparada ?? ri.quantidade) || 0;
        if (qty <= 0) continue;

        allRows.push({
          Artigo: String(ri.item_codigo || ''),
          'Descrição': String(ri.item_descricao || ''),
          Quantidade: qty,
          ORIGEM: localizacaoOrigemTRA,
          'S/N': ri.serialnumber || '',
          LOTE: ri.lote || '',
          DESTINO: codigoDestino,
          'Observações': colaboradorObs
        });
      }
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição válida para gerar dados do reporte.' });
    }

    const columns = ['Artigo', 'Descrição', 'Quantidade', 'ORIGEM', 'S/N', 'LOTE', 'DESTINO'];
    if (includeObservacoes) columns.push('Observações');

    res.json({ columns, rows: allRows });
  } catch (error) {
    console.error('Erro ao obter dados do reporte multi:', error);
    res.status(500).json({ error: 'Erro ao obter dados do reporte multi', details: error.message });
  }
});

// Ficheiro de Reporte combinado
router.post('/export-reporte-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de requisições.' });
    }

    try {
      await assertIdsRequisicoesPermitidas(req, ids);
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      throw e;
    }

    let allRows = [];
    let includeObservacoes = false;
    for (const rawId of ids) {
      const id = parseInt(rawId, 10);
      if (!id) continue;
      const requisicao = await getRequisicaoComItens(id);
      if (!requisicao) continue;
      if (!podeExportarReporteOuClog(requisicao)) continue;
      const destinoEPI = isDestinoEPI(requisicao);
      const colaboradorObs = destinoEPI ? (requisicao.observacoes || '') : '';
      if (destinoEPI) includeObservacoes = true;

      // Mesma origem/destino usados na TRA (por requisição)
      const codigoDestino = requisicao.armazem_destino_codigo || '';
      let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
      if (requisicao.armazem_origem_id) {
        const locExp = await pool.query(
          `SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao' ORDER BY id LIMIT 1`,
          [requisicao.armazem_origem_id]
        );
        if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
          localizacaoOrigemTRA = locExp.rows[0].localizacao;
        }
      }

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(`
          SELECT b.*, ri.item_id, i.codigo as item_codigo, i.descricao as item_descricao
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
        `, [id]);
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
      }

      for (const b of bobinas) {
        allRows.push({
          Artigo: String(b.item_codigo || ''),
          'Descrição': String(b.item_descricao || ''),
          Quantidade: Number(b.metros) || 0,
          ORIGEM: localizacaoOrigemTRA,
          'S/N': b.serialnumber || '',
          LOTE: b.lote || '',
          DESTINO: codigoDestino,
          'Observações': colaboradorObs
        });
      }

      for (const ri of requisicao.itens || []) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;
        const qty = parseFloat(ri.quantidade_preparada ?? ri.quantidade) || 0;
        if (qty <= 0) continue;
        allRows.push({
          Artigo: String(ri.item_codigo || ''),
          'Descrição': String(ri.item_descricao || ''),
          Quantidade: qty,
          ORIGEM: localizacaoOrigemTRA,
          'S/N': ri.serialnumber || '',
          LOTE: ri.lote || '',
          DESTINO: codigoDestino,
          'Observações': colaboradorObs
        });
      }
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição válida para gerar ficheiro de reporte.' });
    }

    await buildExcelReporte(
      allRows,
      res,
      `REPORTE_multi_${new Date().toISOString().slice(0, 10)}.xlsx`,
      { includeObservacoes }
    );
  } catch (error) {
    console.error('Erro ao exportar reporte multi:', error);
    res.status(500).json({ error: 'Erro ao exportar reporte combinado', details: error.message });
  }
});

// Buscar requisição por ID (com todos os itens)
router.get('/:id', ...requisicaoAuth, async (req, res) => {
  try {
    const { id } = req.params;

    let reqResult;
    try {
      reqResult = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          a.localizacao as armazem_localizacao,
          ${SQL_CRIADOR_COM_EMAIL},
          r.separador_usuario_id,
          ${SQL_SEPARADOR_NOME} AS separador_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        reqResult = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_COM_EMAIL},
            r.separador_usuario_id,
            ${SQL_SEPARADOR_NOME} AS separador_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          LEFT JOIN usuarios su ON r.separador_usuario_id = su.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    if (reqResult.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    const requisicao = reqResult.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }

    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao,
        i.familia as item_familia, i.subfamilia as item_subfamilia,
        i.tipocontrolo
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);

    // Carregar bobinas (se existirem) para itens controlados por lote
    let bobinasPorItem = {};
    try {
      const bobinasResult = await pool.query(`
        SELECT b.*, ri.item_id
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        WHERE ri.requisicao_id = $1
      `, [id]);
      for (const b of bobinasResult.rows || []) {
        if (!bobinasPorItem[b.item_id]) bobinasPorItem[b.item_id] = [];
        bobinasPorItem[b.item_id].push({
          id: b.id,
          lote: b.lote,
          serialnumber: b.serialnumber,
          metros: b.metros
        });
      }
    } catch (_) {
      bobinasPorItem = {};
    }

    requisicao.itens = (itensResult.rows || []).map(it => ({
      ...it,
      bobinas: bobinasPorItem[it.item_id] || [],
      preparacao_confirmada: it.preparacao_confirmada === true
    }));
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao buscar requisição:', error);
    res.status(500).json({ error: 'Erro ao buscar requisição', details: error.message });
  }
});

// Criar nova requisição (com múltiplos itens)
router.post('/', ...requisicaoAuth, denyOperador, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (usuarioEscopadoSemArmazensAtribuidos(req)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error:
          'Não tem armazéns de origem atribuídos. Um administrador deve associar pelo menos um armazém de origem (central, viatura, APEADO ou EPI) ao seu utilizador.',
      });
    }

    const { armazem_origem_id, armazem_id, itens, observacoes } = req.body;

    // Validações
    if (!armazem_id || !itens || !Array.isArray(itens) || itens.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Campos obrigatórios: armazem_id (destino), itens (array com pelo menos um item)' 
      });
    }

    // Verificar armazém destino
    const armazemCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_id]);
    if (armazemCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Armazém destino não encontrado ou inativo' });
    }

    // Verificar armazém origem (se informado)
    if (armazem_origem_id) {
      const origCheck = await client.query('SELECT id, tipo FROM armazens WHERE id = $1 AND ativo = true', [armazem_origem_id]);
      if (origCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém origem não encontrado ou inativo' });
      }
      if (!isTipoArmazemOrigemRequisicao(origCheck.rows[0].tipo)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Armazém de origem não é um tipo válido (central, viatura, APEADO ou EPI).',
        });
      }
    }

    if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
      const orig = armazem_origem_id ? parseInt(armazem_origem_id, 10) : null;
      if (orig == null || !req.requisicaoArmazemOrigemIds.includes(orig)) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'Só pode criar requisições com origem num dos armazéns de origem atribuídos ao seu utilizador.',
        });
      }
    }

    // Validar itens: apenas existência e quantidade aqui; Lote e Serial serão definidos na separação
    for (const item of itens) {
      if (!item.item_id || !item.quantidade || item.quantidade <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Cada item deve ter item_id e quantidade > 0' 
        });
      }

      // Verificar se o item existe
      const itemCheck = await client.query('SELECT id FROM itens WHERE id = $1', [item.item_id]);
      if (itemCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Item ID ${item.item_id} não encontrado` });
      }
    }

    // Criar requisição (etapa 1: origem, itens, destino - sem localização)
    let reqResult;
    try {
      reqResult = await client.query(`
        INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
        VALUES ($1, $2, $3, $4, 'pendente')
        RETURNING *
      `, [armazem_origem_id || null, armazem_id, observacoes || null, req.user.id]);
    } catch (insertErr) {
      if (insertErr.code === '42703') {
        reqResult = await client.query(`
          INSERT INTO requisicoes (armazem_id, observacoes, usuario_id, status)
          VALUES ($1, $2, $3, 'pendente')
          RETURNING *
        `, [armazem_id, observacoes || null, req.user.id]);
      } else {
        throw insertErr;
      }
    }

    const requisicaoId = reqResult.rows[0].id;

    // Inserir itens (sem lote/serial; esses serão preenchidos na preparação)
    for (const item of itens) {
      await client.query(`
        INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
        VALUES ($1, $2, $3)
        ON CONFLICT (requisicao_id, item_id) 
        DO UPDATE SET quantidade = EXCLUDED.quantidade
      `, [requisicaoId, item.item_id, item.quantidade]);
    }

    await client.query('COMMIT');

    // Buscar requisição completa
    let requisicaoCompleta;
    try {
      requisicaoCompleta = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_COM_EMAIL}
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [requisicaoId]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        requisicaoCompleta = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_COM_EMAIL}
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [requisicaoId]);
      } else {
        throw qErr;
      }
    }

    const requisicao = requisicaoCompleta.rows[0];

    // Buscar itens
    const itensResult = await pool.query(`
      SELECT 
        ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao,
        i.tipocontrolo
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [requisicaoId]);

    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição criada: ID ${requisicaoId} com ${itens.length} item(ns)`);
    res.status(201).json(requisicao);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar requisição:', error);
    res.status(500).json({ error: 'Erro ao criar requisição', details: error.message });
  } finally {
    client.release();
  }
});

// Importar requisição a partir de ficheiro Excel (modelo TRFL/TRA interno)
router.post(
  '/importar-excel',
  authenticateToken,
  requisicaoPerfilNegadoMiddleware,
  denyOperador,
  requisicaoScopeMiddleware,
  excelUploadRequisicoes.single('arquivo'),
  async (req, res) => {
  try {
    if (usuarioEscopadoSemArmazensAtribuidos(req)) {
      return res.status(403).json({
        error:
          'Não tem armazéns de origem atribuídos. Um administrador deve associar pelo menos um armazém de origem (central, viatura, APEADO ou EPI) ao seu utilizador.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo Excel (.xlsx) é obrigatório.' });
    }

    const { armazem_origem_id } = req.body;

    // Armazém origem é obrigatório (central, viatura, APEADO ou EPI)
    if (!armazem_origem_id) {
      return res.status(400).json({ error: 'Armazém origem é obrigatório.' });
    }
    const ao = await pool.query('SELECT id, tipo FROM armazens WHERE id = $1 AND ativo = true', [
      parseInt(armazem_origem_id, 10),
    ]);
    if (ao.rows.length === 0 || !isTipoArmazemOrigemRequisicao(ao.rows[0].tipo)) {
      return res.status(400).json({
        error: 'Armazém origem não encontrado, inativo ou tipo inválido (use central, viatura, APEADO ou EPI).',
      });
    }
    const armazemOrigemId = ao.rows[0].id;

    if (
      req.requisicaoArmazemOrigemIds &&
      req.requisicaoArmazemOrigemIds.length > 0 &&
      !req.requisicaoArmazemOrigemIds.includes(armazemOrigemId)
    ) {
      return res.status(403).json({
        error: 'Só pode importar requisições para um dos armazéns de origem atribuídos ao seu utilizador.',
      });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return res.status(400).json({ error: 'Ficheiro Excel sem folha válida.' });
    }

    // 1) Encontrar código de armazém destino (ex: V874) em qualquer célula
    const range = XLSX.utils.decode_range(sheet['!ref']);
    let codigoArmazemDestino = null;
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = sheet[cellAddr];
        if (!cell || cell.v == null) continue;
        const v = String(cell.v).trim();
        if (/^V\d+$/i.test(v)) {
          codigoArmazemDestino = v.toUpperCase();
        }
      }
    }

    if (!codigoArmazemDestino) {
      return res.status(400).json({ error: 'Não foi possível identificar o armazém destino no Excel (código Vxxx).' });
    }

    const armazemRes = await pool.query('SELECT id FROM armazens WHERE UPPER(codigo) = $1', [codigoArmazemDestino.toUpperCase()]);
    if (armazemRes.rows.length === 0) {
      return res.status(400).json({ error: `Armazém destino ${codigoArmazemDestino} não encontrado no sistema.` });
    }
    const armazemDestinoId = armazemRes.rows[0].id;

    // 2) Encontrar linha de cabeçalho: Artigo | Descrição | Quantidade
    let headerRowNumber = null;
    let colArtigo = null;
    let colQuantidade = null;

    for (let R = range.s.r; R <= range.e.r; R++) {
      const rowValues = [];
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = sheet[cellAddr];
        rowValues.push(cell && cell.v != null ? String(cell.v).trim() : '');
      }
      if (rowValues.includes('Artigo') && rowValues.includes('Descrição') && rowValues.includes('Quantidade')) {
        headerRowNumber = R;
        rowValues.forEach((v, idx) => {
          if (v === 'Artigo') colArtigo = idx;
          if (v === 'Quantidade') colQuantidade = idx;
        });
        break;
      }
    }

    if (headerRowNumber == null || colArtigo == null || colQuantidade == null) {
      return res.status(400).json({ error: 'Cabeçalho Artigo/Descrição/Quantidade não encontrado no Excel.' });
    }

    // 3) Ler linhas de itens (sem query por linha — era o principal gargalo com muitas linhas)
    /** última quantidade vence se o mesmo código aparecer em várias linhas (igual ao INSERT em loop com ON CONFLICT) */
    const quantidadePorCodigo = new Map();
    for (let R = headerRowNumber + 1; R <= range.e.r; R++) {
      const cellArtigo = sheet[XLSX.utils.encode_cell({ r: R, c: colArtigo })];
      const cellQtd = sheet[XLSX.utils.encode_cell({ r: R, c: colQuantidade })];
      const codigo = cellArtigo && cellArtigo.v != null ? String(cellArtigo.v).trim() : '';
      const qtdStr = cellQtd && cellQtd.v != null ? String(cellQtd.v).trim() : '';
      if (!codigo || !qtdStr) continue;

      const quantidade = parseInt(qtdStr, 10);
      if (!quantidade || quantidade <= 0) continue;

      quantidadePorCodigo.set(codigo, quantidade);
    }

    const codigosUnicos = [...quantidadePorCodigo.keys()];
    if (codigosUnicos.length === 0) {
      return res.status(400).json({ error: 'Nenhum item válido encontrado na planilha.' });
    }

    const itensLookup = await pool.query(
      'SELECT id, codigo FROM itens WHERE codigo = ANY($1::text[])',
      [codigosUnicos]
    );
    const idPorCodigo = new Map(itensLookup.rows.map((row) => [row.codigo, row.id]));

    const itens = [];
    for (const codigo of codigosUnicos) {
      const itemId = idPorCodigo.get(codigo);
      if (itemId == null) continue;
      itens.push({ item_id: itemId, quantidade: quantidadePorCodigo.get(codigo) });
    }

    if (itens.length === 0) {
      return res.status(400).json({ error: 'Nenhum item válido encontrado na planilha.' });
    }

    // 4) Criar requisição usando a mesma lógica da rota normal
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reqResult = await client.query(`
        INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
        VALUES ($1, $2, $3, $4, 'pendente')
        RETURNING *
      `, [armazemOrigemId || null, armazemDestinoId, 'Importada de Excel', req.user.id]);

      const requisicaoId = reqResult.rows[0].id;

      const itemIds = itens.map((i) => i.item_id);
      const quantidades = itens.map((i) => i.quantidade);
      await client.query(
        `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
         SELECT $1::int, x.item_id, x.quantidade
         FROM unnest($2::int[], $3::int[]) AS x(item_id, quantidade)
         ON CONFLICT (requisicao_id, item_id)
         DO UPDATE SET quantidade = EXCLUDED.quantidade`,
        [requisicaoId, itemIds, quantidades]
      );

      await client.query('COMMIT');

      res.status(201).json({ requisicao_id: requisicaoId });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar requisição via Excel:', e);
      res.status(500).json({ error: 'Erro ao criar requisição via Excel', details: e.message });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao importar requisição Excel:', error);
    res.status(500).json({ error: 'Erro ao importar requisição Excel', details: error.message });
  }
});

// Atualizar requisição
router.put('/:id', ...requisicaoAuth, denyOperador, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { armazem_origem_id, armazem_id, itens, status, localizacao, observacoes } = req.body;

    // Verificar se a requisição existe
    const checkReq = await client.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    if (checkReq.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, checkReq.rows[0].armazem_origem_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }

    const statusAtual = String(checkReq.rows[0].status || '');
    if (statusAtual !== 'pendente') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:
          'Só é possível editar requisições pendentes. Após o início da separação, a requisição não pode ser alterada.',
        code: 'REQUISICAO_NAO_EDITAVEL',
      });
    }

    // Validações
    if (status && !['pendente', 'EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'Entregue', 'FINALIZADO', 'cancelada'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Status inválido. Use: pendente, EM SEPARACAO, separado, EM EXPEDICAO, Entregue, FINALIZADO ou cancelada'
      });
    }

    // Construir query de atualização dinamicamente
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (armazem_origem_id !== undefined) {
      if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
        const newOrig = armazem_origem_id ? parseInt(armazem_origem_id, 10) : null;
        if (newOrig == null || !req.requisicaoArmazemOrigemIds.includes(newOrig)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Não pode alterar o armazém de origem para fora dos armazéns permitidos.' });
        }
      }
      if (armazem_origem_id) {
        const origCheck = await client.query('SELECT id, tipo FROM armazens WHERE id = $1 AND ativo = true', [armazem_origem_id]);
        if (origCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Armazém origem não encontrado ou inativo' });
        }
        if (!isTipoArmazemOrigemRequisicao(origCheck.rows[0].tipo)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Armazém de origem: use central, viatura, APEADO ou EPI.',
          });
        }
      }
      updates.push(`armazem_origem_id = $${paramCount++}`);
      params.push(armazem_origem_id || null);
    }

    if (armazem_id !== undefined) {
      const armazemCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_id]);
      if (armazemCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém destino não encontrado ou inativo' });
      }
      updates.push(`armazem_id = $${paramCount++}`);
      params.push(armazem_id);
    }

    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      params.push(status);
    }

    if (localizacao !== undefined) {
      updates.push(`localizacao = $${paramCount++}`);
      params.push(localizacao);
    }

    if (observacoes !== undefined) {
      updates.push(`observacoes = $${paramCount++}`);
      params.push(observacoes);
    }

    // Atualizar requisição se houver campos para atualizar
    if (updates.length > 0) {
      params.push(id);
      await client.query(`
        UPDATE requisicoes 
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramCount}
      `, params);
    }

    // Atualizar itens se fornecidos
    if (itens && Array.isArray(itens)) {
      // Validar itens
      for (const item of itens) {
        if (!item.item_id || !item.quantidade || item.quantidade <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cada item deve ter item_id e quantidade > 0' });
        }
      }

      // Remover itens existentes
      await client.query('DELETE FROM requisicoes_itens WHERE requisicao_id = $1', [id]);

      // Inserir novos itens
      for (const item of itens) {
        await client.query(`
          INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
          VALUES ($1, $2, $3)
        `, [id, item.item_id, item.quantidade]);
      }
    }

    await client.query('COMMIT');

    // Buscar requisição completa atualizada
    let requisicaoCompleta;
    try {
      requisicaoCompleta = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_COM_EMAIL}
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        requisicaoCompleta = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_COM_EMAIL}
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    const requisicao = requisicaoCompleta.rows[0];

    // Buscar itens
    const itensResult = await pool.query(`
      SELECT 
        ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [id]);

    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição atualizada: ID ${id}`);
    res.json(requisicao);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar requisição:', error);
    res.status(500).json({ error: 'Erro ao atualizar requisição', details: error.message });
  } finally {
    client.release();
  }
});

// Preparar item individual da requisição (quantidade, localização origem, localização destino)
router.patch('/:id/atender-item', ...requisicaoAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { requisicao_item_id, quantidade_preparada, localizacao_origem, localizacao_destino, lote, serialnumber, bobinas } = req.body;

    if (!requisicao_item_id || quantidade_preparada === undefined || quantidade_preparada < 0) {
      return res.status(400).json({ error: 'requisicao_item_id e quantidade_preparada são obrigatórios (use 0 se não tiver o item).' });
    }
    const isZero = Number(quantidade_preparada) === 0;
    const locOrigem = typeof localizacao_origem === 'string' ? localizacao_origem.trim() : '';
    if (!isZero && !locOrigem) {
      return res.status(400).json({ error: 'Localização de saída (onde está saindo) é obrigatória quando há quantidade preparada.' });
    }

    await client.query('BEGIN');
    let check;
    try {
      check = await client.query(
        'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1 FOR UPDATE',
        [id]
      );
    } catch (lockErr) {
      await client.query('ROLLBACK');
      if (lockErr.code === '42703'
        && String(lockErr.message || '').includes('separador_usuario_id')) {
        return res.status(503).json({
          error: 'Coluna de atribuição do separador em falta na base de dados.',
          details: 'Execute: npm run db:migrate:requisicoes-separador'
        });
      }
      throw lockErr;
    }

    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const stReq = String(check.rows[0].status || '');
    if (stReq === 'cancelada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Requisição cancelada' });
    }
    const podeAlterarPreparacao =
      ['pendente', 'EM SEPARACAO'].includes(stReq) ||
      adminPodeCorrigirPreparacaoItemSeparada(stReq, req.user && req.user.role);
    if (!podeAlterarPreparacao) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:
          'Não é possível alterar a preparação após a requisição estar separada ou em fase posterior (expedição, entrega, etc.). Administradores podem corrigir linhas só em Separadas ou Em expedição.',
        code: 'PREPARACAO_ENCERRADA',
      });
    }

    if (separadorImpedeAcao(check.rows[0], req)) {
      await client.query('ROLLBACK');
      return respostaBloqueioSeparador(res);
    }

    const itemCheck = await client.query(
      `SELECT ri.*, i.tipocontrolo 
       FROM requisicoes_itens ri
       INNER JOIN itens i ON ri.item_id = i.id
       WHERE ri.id = $1 AND ri.requisicao_id = $2`,
      [requisicao_item_id, id]
    );
    if (itemCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado nesta requisição' });
    }
    const item = itemCheck.rows[0];

    // Validar Lote/Serial/Bobinas conforme tipo de controlo do item, apenas quando há saída
    const tipoControlo = (item.tipocontrolo || '').toUpperCase();
    if (!isZero && tipoControlo === 'LOTE' && Array.isArray(bobinas)) {
      if (bobinas.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.item_id} é controlado por LOTE. Informe pelo menos uma bobina.` });
      }
      for (const b of bobinas) {
        const loteB = (b.lote || '').trim();
        const metros = Number(b.metros);
        if (!loteB || !metros || metros <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Toda bobina do item ${item.item_id} deve ter lote e metragem > 0.` });
        }
      }
    } else if (!isZero) {
      if (tipoControlo === 'LOTE' && (!lote || String(lote).trim() === '')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.item_id} é controlado por LOTE. Informe o lote na preparação.` });
      }
      if (tipoControlo === 'S/N' && (!serialnumber || String(serialnumber).trim() === '')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe o Serial number na preparação.` });
      }
    }

    // Localização destino é sempre EXPEDICAO (automático) quando há saída
    const localizacaoDestinoFinal = isZero ? null : 'EXPEDICAO';

    const updateQuery = `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = COALESCE($5, serialnumber),
          preparacao_confirmada = true
      WHERE id = $6`;
    const params = [
      quantidade_preparada,
      localizacaoDestinoFinal,
      isZero ? null : locOrigem,
      isZero ? null : (lote || null),
      isZero ? null : (serialnumber || null),
      requisicao_item_id
    ];

    try {
      await client.query(updateQuery, params);

      // Se houver bobinas para itens de lote e quantidade > 0, registrar detalhamento por bobina.
      // Se quantidade = 0, apagar qualquer detalhamento existente.
      if (tipoControlo === 'LOTE') {
        await client.query('DELETE FROM requisicoes_itens_bobinas WHERE requisicao_item_id = $1', [requisicao_item_id]);
        if (!isZero && Array.isArray(bobinas)) {
          for (const b of bobinas) {
            await client.query(
              `INSERT INTO requisicoes_itens_bobinas (requisicao_item_id, lote, serialnumber, metros)
               VALUES ($1, $2, $3, $4)`,
              [requisicao_item_id, (b.lote || '').trim(), (b.serialnumber || null), Number(b.metros)]
            );
          }
        }
      }

      await client.query(
        `UPDATE requisicoes SET
          separador_usuario_id = COALESCE(separador_usuario_id, $1),
          status = CASE WHEN status = 'pendente' THEN 'EM SEPARACAO' ELSE status END,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [req.user.id, id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Erro ao preparar item: coluna preparacao_confirmada não existe no banco.',
          details: 'Execute a migração: npm run db:migrate:preparacao-confirmada (ou server/migrate-requisicoes-itens-preparacao-confirmada.sql)'
        });
      }
      if (e.code === '23514' && e.constraint === 'requisicoes_status_check') {
        return res.status(503).json({
          error: 'Atualize o constraint de status das requisições (inclui EM SEPARACAO).',
          details: 'Execute: npm run db:migrate:em-separacao'
        });
      }
      throw e;
    }

    // Estado intermédio EM SEPARACAO é aplicado no UPDATE acima; 'separado' (Separadas) só via «Completar separação»
    const fullReq = await pool.query(`
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_CRIADOR_NOME} AS usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `, [id]);
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);
    requisicao.itens = (itensResult.rows || []).map(it => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true
    }));

    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao preparar item:', error);
    res.status(500).json({ error: 'Erro ao preparar item', details: error.message });
  } finally {
    client.release();
  }
});

// Remover linha de requisição (só admin; só em Separadas ou Em expedição; tem de existir mais do que uma linha)
router.delete('/:id/requisicao-itens/:requisicaoItemId', ...requisicaoAuth, async (req, res) => {
  try {
    if (!isAdmin(req.user.role)) {
      return res.status(403).json({
        error: 'Apenas administradores podem remover itens de uma requisição já separada.',
        code: 'APENAS_ADMIN',
      });
    }
    const requisicaoId = parseInt(req.params.id, 10);
    const requisicaoItemId = parseInt(req.params.requisicaoItemId, 10);
    if (!Number.isFinite(requisicaoId) || !Number.isFinite(requisicaoItemId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const check = await pool.query(
      'SELECT id, status, armazem_origem_id FROM requisicoes WHERE id = $1',
      [requisicaoId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const st = String(check.rows[0].status || '');
    if (!adminPodeCorrigirPreparacaoItemSeparada(st, req.user.role)) {
      return res.status(400).json({
        error:
          'Só é possível remover linhas quando a requisição está em Separadas ou Em expedição (e apenas por administrador).',
        code: 'REMOCAO_LINHA_INVALIDA',
      });
    }

    const linha = await pool.query(
      'SELECT id FROM requisicoes_itens WHERE id = $1 AND requisicao_id = $2',
      [requisicaoItemId, requisicaoId]
    );
    if (linha.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada nesta requisição' });
    }

    const cnt = await pool.query(
      'SELECT COUNT(*)::int AS c FROM requisicoes_itens WHERE requisicao_id = $1',
      [requisicaoId]
    );
    if ((cnt.rows[0]?.c || 0) <= 1) {
      return res.status(400).json({
        error: 'Não é possível remover o único item da requisição. Cancele ou edite a requisição por outro meio.',
      });
    }

    try {
      await pool.query('DELETE FROM requisicoes_itens_bobinas WHERE requisicao_item_id = $1', [requisicaoItemId]);
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
    await pool.query('DELETE FROM requisicoes_itens WHERE id = $1 AND requisicao_id = $2', [requisicaoItemId, requisicaoId]);

    const fullReq = await pool.query(
      `
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_CRIADOR_NOME} AS usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `,
      [requisicaoId]
    );
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(
      `
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `,
      [requisicaoId]
    );
    requisicao.itens = (itensResult.rows || []).map((it) => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true,
    }));

    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao remover linha da requisição:', error);
    res.status(500).json({ error: 'Erro ao remover linha', details: error.message });
  }
});

// Atender requisição (marcar como separado e opcionalmente preencher localização) — legado/alternativo
router.patch('/:id/atender', ...requisicaoAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { localizacao } = req.body;

    const check = await pool.query(
      'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'Entregue'].includes(check.rows[0].status)) {
      if (check.rows[0].status === 'EM SEPARACAO') {
        return res.status(400).json({
          error: 'A requisição está em separação. Use a página Preparar e «Concluir preparação da requisição» quando todos os itens estiverem confirmados.'
        });
      }
      return res.status(400).json({ error: 'Requisição já foi preparada' });
    }
    if (check.rows[0].status === 'cancelada') {
      return res.status(400).json({ error: 'Requisição cancelada' });
    }

    await pool.query(
      `
      UPDATE requisicoes 
      SET status = 'separado',
          localizacao = COALESCE($2, localizacao),
          separador_usuario_id = COALESCE(separador_usuario_id, $3),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
      [id, localizacao || null, req.user.id]
    );

    let result;
    try {
      result = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_NOME} AS usuario_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        result = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_NOME} AS usuario_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    const requisicao = result.rows[0];
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [id]);
    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição marcada como separado: ID ${id}`);
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao atender requisição:', error);
    res.status(500).json({ error: 'Erro ao atender requisição', details: error.message });
  }
});

// Completar separação da requisição (todos os itens preparados → status separado)
router.patch('/:id/completar-separacao', ...requisicaoAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (!['pendente', 'EM SEPARACAO'].includes(check.rows[0].status)) {
      return res.status(400).json({
        error: 'Só pode completar a separação quando a requisição está pendente ou em separação e todos os itens foram preparados.'
      });
    }
    let itens;
    try {
      itens = await pool.query(
        'SELECT quantidade, quantidade_preparada, preparacao_confirmada FROM requisicoes_itens WHERE requisicao_id = $1',
        [id]
      );
    } catch (qErr) {
      if (qErr.code === '42703') {
        return res.status(503).json({
          error: 'É obrigatório confirmar a preparação de cada item (incl. 0 quando não houver stock).',
          details: 'Execute a migração: server/migrate-requisicoes-itens-preparacao-confirmada.sql'
        });
      }
      throw qErr;
    }
    const allConfirmed = itens.rows.length > 0 && itens.rows.every(r => r.preparacao_confirmada === true);
    if (!allConfirmed) {
      return res.status(400).json({ error: 'Confirme a preparação de todos os itens antes de completar a separação (inclua 0 na quantidade quando não tiver o item).' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['separado', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({
        error: 'Status inválido no servidor. Execute: npm run db:migrate:em-separacao (e migrações de fases de requisição se ainda não aplicou).'
      });
    }
    console.error('Erro ao completar separação:', error);
    res.status(500).json({ error: 'Erro ao completar separação', details: error.message });
  }
});

// Confirmar separação (após os itens terem sido recolhidos) — só para requisições com status separado
router.patch('/:id/confirmar-separacao', ...requisicaoAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status !== 'separado') {
      return res.status(400).json({ error: 'Só é possível confirmar separação quando a requisição está separada (todos os itens preparados).' });
    }
    await pool.query(
      `UPDATE requisicoes SET separacao_confirmada = true, separacao_confirmada_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '42703') {
      return res.status(503).json({
        error: 'Colunas de confirmação de separação não existem no banco.',
        details: 'Execute a migração: server/migrate-requisicoes-separacao-confirmada.sql'
      });
    }
    console.error('Erro ao confirmar separação:', error);
    res.status(500).json({ error: 'Erro ao confirmar separação', details: error.message });
  }
});

// Marcar como EM EXPEDICAO (após baixar o ficheiro TRFL)
router.patch('/:id/marcar-em-expedicao', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'SELECT id, status, separacao_confirmada, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status !== 'separado') {
      return res.status(400).json({ error: 'Só pode marcar em expedição quando a requisição está separada.' });
    }
    if (!check.rows[0].separacao_confirmada) {
      return res.status(400).json({ error: 'Confirme a separação antes de marcar em expedição.' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['EM EXPEDICAO', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar em expedição:', error);
    res.status(500).json({ error: 'Erro ao marcar em expedição', details: error.message });
  }
});

// Marcar como Entregue (após baixar o ficheiro TRA)
router.patch('/:id/marcar-entregue', ...requisicaoAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status !== 'EM EXPEDICAO') {
      return res.status(400).json({ error: 'Só pode marcar como entregue quando a requisição está em expedição.' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Entregue', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar como entregue:', error);
    res.status(500).json({ error: 'Erro ao marcar como entregue', details: error.message });
  }
});

// Marcar como FINALIZADO (após baixar a TRA e concluir o processo)
router.patch('/:id/finalizar', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'SELECT id, status, armazem_origem_id, separador_usuario_id FROM requisicoes WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (check.rows[0].status === 'cancelada') return res.status(400).json({ error: 'Requisição cancelada' });
    if (check.rows[0].status !== 'Entregue') {
      return res.status(400).json({ error: 'Só é possível finalizar requisições com status Entregue.' });
    }

    await pool.query('UPDATE requisicoes SET status = $1 WHERE id = $2', ['FINALIZADO', id]);
    res.json({ ok: true, id: parseInt(id, 10), status: 'FINALIZADO' });
  } catch (error) {
    console.error('Erro ao finalizar requisição:', error);
    res.status(500).json({ error: 'Erro ao finalizar requisição', details: error.message });
  }
});

// Deletar requisição
router.delete('/:id', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || '';

    // Verificar se a requisição existe
    const checkReq = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    if (checkReq.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    const requisicao = checkReq.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const status = String(requisicao.status || '');
    const statusRestritosAdmin = ['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'Entregue'];
    if (statusRestritosAdmin.includes(status) && userRole !== 'admin') {
      return res.status(403).json({
        error: 'A exclusão de requisições em separação, separadas, em expedição ou entregues é permitida apenas para ADMIN.'
      });
    }

    // Deletar requisição (itens serão deletados automaticamente por CASCADE)
    await pool.query('DELETE FROM requisicoes WHERE id = $1', [id]);

    console.log(`✅ Requisição deletada: ID ${id}`);
    res.json({ message: 'Requisição deletada com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar requisição:', error);
    res.status(500).json({ error: 'Erro ao deletar requisição', details: error.message });
  }
});
  return router;
}

module.exports = { createRequisicoesRouter };
