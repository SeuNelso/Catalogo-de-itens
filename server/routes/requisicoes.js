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
    const { status, armazem_id, item_id, devolucoes, transferencias } = req.query;
    let itemIdParsed = null;
    if (item_id != null && String(item_id).trim() !== '') {
      const iid = parseInt(String(item_id), 10);
      if (Number.isFinite(iid)) itemIdParsed = iid;
    }
    const minhas =
      req.query.minhas === '1' ||
      req.query.minhas === 'true' ||
      String(req.query.minhas || '').toLowerCase() === 'sim';

    const devolucoesViaturaCentral = ['1', 'true', 'yes', 'sim'].includes(
      String(devolucoes || '').toLowerCase()
    );
    const transferenciasFluxo = ['1', 'true', 'yes', 'sim'].includes(
      String(transferencias || '').toLowerCase()
    );

    // Buscar requisições (armazem destino + armazem origem)
    let query = `
      SELECT 
        r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        a.tipo as armazem_destino_tipo,
        ao.tipo as armazem_origem_tipo,
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

    if (transferenciasFluxo) {
      // Página "Transferências": central <-> APEADO e central -> central.
      query += ` AND (
        (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
      )`;
      params.push('central', 'apeado', 'apeado', 'central', 'central', 'central');
    } else if (devolucoesViaturaCentral) {
      // Devolução: origem = viatura e destino = central
      query += ` AND LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++}`;
      params.push('viatura', 'central');
    } else {
      // Página "Requisições": excluir fluxos dedicados de Devoluções e Transferências.
      // Devoluções: viatura -> central
      // Transferências: central <-> apeado e central -> central
      query += ` AND NOT (
        (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
        OR (LOWER(TRIM(ao.tipo)) = $${paramCount++} AND LOWER(TRIM(a.tipo)) = $${paramCount++})
      )`;
      params.push('viatura', 'central', 'central', 'apeado', 'apeado', 'central', 'central', 'central');
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
            (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
            a.tipo as armazem_destino_tipo,
            ao.tipo as armazem_origem_tipo,
            ${SQL_LISTA_CRIADOR_E_SEPARADOR}
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
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

        if (transferenciasFluxo) {
          fallbackQuery += ` AND (
            (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
          )`;
          fbParams.push('central', 'apeado', 'apeado', 'central', 'central', 'central');
        } else if (devolucoesViaturaCentral) {
          fallbackQuery += ` AND LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++}`;
          fbParams.push('viatura', 'central');
        } else {
          fallbackQuery += ` AND NOT (
            (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
            OR (LOWER(TRIM(ao.tipo)) = $${pc++} AND LOWER(TRIM(a.tipo)) = $${pc++})
          )`;
          fbParams.push('viatura', 'central', 'central', 'apeado', 'apeado', 'central', 'central', 'central');
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
const LOCALIZACAO_RECEBIMENTO_FALLBACK = 'RECEBIMENTO.E';

/** Devolução: origem viatura → destino armazém central (entrada em recebimento + movimento interno). */
function isFluxoDevolucaoViaturaCentral(origemTipo, destTipo) {
  return (
    String(origemTipo || '').toLowerCase() === 'viatura' &&
    String(destTipo || '').toLowerCase() === 'central'
  );
}

async function localizacaoArmazemPorTipo(poolConn, armazemId, tipoLoc) {
  if (!armazemId) return null;
  const r = await poolConn.query(
    `SELECT localizacao FROM armazens_localizacoes
     WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = $2
     ORDER BY id LIMIT 1`,
    [armazemId, String(tipoLoc || '').toLowerCase()]
  );
  return r.rows[0]?.localizacao || null;
}

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
      a.tipo as armazem_destino_tipo,
      ao.codigo as armazem_origem_codigo,
      ao.tipo as armazem_origem_tipo
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
    SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo,
      EXISTS (
        SELECT 1 FROM itens_setores is2
        WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
      ) AS is_ferramenta
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
  if (requisicao?.tra_gerada_em) return true;
  // Devolução (viatura→central): entrada registada com DEV (`devolucao_tra_gerada_em`), sem TRA clássica.
  if (requisicao?.devolucao_tra_gerada_em) return true;
  return false;
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
    if (!['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) {
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

    let tipoDestino = '';
    if (requisicao.armazem_id) {
      const armDest = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_id]);
      if (armDest.rows.length > 0) {
        tipoDestino = String(armDest.rows[0].tipo || '').toLowerCase();
      }
    }
    const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(tipoOrigem, tipoDestino);

    if (!fluxoDevolucao && tipoOrigem !== 'central') {
      return res.status(400).json({ error: 'TRFL só é gerado quando o armazém de origem é um armazém geral (central). Esta requisição tem origem em armazém viatura (use primeiro a TRA de devolução, depois esta TRFL).' });
    }

    // Devolução: movimento interno no central (recebimento → zona final FERR / normal).
    if (fluxoDevolucao) {
      if (!requisicao.armazem_id) {
        return res.status(400).json({ error: 'Requisição sem armazém de destino.' });
      }
      let docRow;
      try {
        docRow = await pool.query(
          'SELECT devolucao_tra_gerada_em, devolucao_trfl_gerada_em FROM requisicoes WHERE id = $1',
          [id]
        );
      } catch (docErr) {
        if (docErr.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw docErr;
      }
      const traDev = docRow.rows[0]?.devolucao_tra_gerada_em;
      if (!traDev) {
        return res.status(400).json({
          error: 'Gere primeiro a TRA de devolução (entrada no armazém destino na localização de recebimento).'
        });
      }

      const armDestRow = await pool.query('SELECT id, codigo FROM armazens WHERE id = $1', [requisicao.armazem_id]);
      if (armDestRow.rows.length === 0) {
        return res.status(400).json({ error: 'Armazém de destino não encontrado.' });
      }
      const ad = armDestRow.rows[0];
      let locRec = await localizacaoArmazemPorTipo(pool, ad.id, 'recebimento');
      if (!locRec) locRec = LOCALIZACAO_RECEBIMENTO_FALLBACK;

      let locDestRows = [];
      try {
        const locResult = await pool.query(
          'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [ad.id]
        );
        locDestRows = locResult.rows || [];
      } catch (_) {
        locDestRows = [];
      }
      const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(ad.codigo || '', locDestRows);
      const codigoCentral = ad.codigo || 'E';

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(`
          SELECT b.*, ri.item_id, i.codigo as item_codigo
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
          ORDER BY ri.id, b.id
        `, [id]);
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
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
        itensComFerramenta = (requisicao.itens || []).map((ri) => ({ ...ri, is_ferramenta: false }));
      }

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
      const rows = [];
      const apeadosQtyByItemId = new Map(
        (itensComFerramenta || []).map((it) => [
          Number(it.item_id),
          Math.max(0, parseInt(it.quantidade_apeados ?? 0, 10) || 0),
        ])
      );
      const apeadosCountByItemId = new Map();

      for (const b of bobinas) {
        const ri = itensComFerramenta.find((it) => it.item_id === b.item_id) || {};
        const itemId = Number(b.item_id);
        const apeadosQty = apeadosQtyByItemId.get(itemId) ?? 0;
        const prevCount = apeadosCountByItemId.get(itemId) ?? 0;
        const nextCount = prevCount + 1;
        apeadosCountByItemId.set(itemId, nextCount);

        const destLoc = nextCount <= apeadosQty ? localizacaoFERR : localizacaoNormal;
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locRec,
          Article: String(b.item_codigo || ''),
          Quatity: Number(b.metros) || 0,
          SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoCentral,
          DestinationLocation: destLoc,
          ProjectCode: '',
          Batch: b.lote || ''
        });
      }

      for (const ri of itensComFerramenta) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some((b) => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;

        const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
        if (qty <= 0) continue;
        const apeadosQty = Math.max(0, Math.min(qty, parseInt(ri.quantidade_apeados ?? 0, 10) || 0));
        const normalQty = Math.max(0, qty - apeadosQty);

        const serials = String(ri.serialnumber || '')
          .split(/\r?\n|;|\|/)
          .map((s) => String(s || '').trim())
          .filter(Boolean);

        if (apeadosQty > 0) {
          const serialApeados = serials.slice(0, apeadosQty).join('\n');
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locRec,
            Article: String(ri.item_codigo || ''),
            Quatity: apeadosQty,
            SerialNumber1: serialApeados || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: localizacaoFERR,
            ProjectCode: '',
            Batch: ri.lote || ''
          });
        }

        if (normalQty > 0) {
          const serialNormal = serials.slice(apeadosQty).join('\n');
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locRec,
            Article: String(ri.item_codigo || ''),
            Quatity: normalQty,
            SerialNumber1: serialNormal || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: localizacaoNormal,
            ProjectCode: '',
            Batch: ri.lote || ''
          });
        }
      }

      try {
        await pool.query(
          `UPDATE requisicoes
           SET devolucao_trfl_gerada_em = COALESCE(devolucao_trfl_gerada_em, CURRENT_TIMESTAMP),
               tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP),
               status = CASE
                 WHEN status IN ('EM EXPEDICAO') THEN 'APEADOS'
                 ELSE status
               END
           WHERE id = $1`,
          [id]
        );
      } catch (upErr) {
        if (upErr.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw upErr;
      }

      buildExcelTransferencia(rows, res, `TRFL_requisicao_${id}_devolucao_${new Date().toISOString().slice(0, 10)}.xlsx`);
      return;
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
      if (!['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'].includes(requisicao.status)) continue;
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

    let tipoOrigemArm = '';
    let tipoDestArm = '';
    if (requisicao.armazem_origem_id) {
      const trO = await pool.query('SELECT tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
      tipoOrigemArm = trO.rows[0]?.tipo || '';
    }
    if (requisicao.armazem_id) {
      const trD = await pool.query('SELECT tipo FROM armazens WHERE id = $1', [requisicao.armazem_id]);
      tipoDestArm = trD.rows[0]?.tipo || '';
    }
    const tipoOrigNorm = String(tipoOrigemArm || '').trim().toLowerCase();
    const tipoDestNorm = String(tipoDestArm || '').trim().toLowerCase();
    const fluxoDevolucaoTra = isFluxoDevolucaoViaturaCentral(tipoOrigNorm, tipoDestNorm);
    const fluxoCentralApeado = tipoOrigNorm === 'central' && tipoDestNorm === 'apeado';

    if (fluxoDevolucaoTra) {
      if (!['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) {
        return res.status(400).json({
          error: 'TRA de devolução só após confirmar a separação (status Separado ou fase seguinte).'
        });
      }
      if (!requisicao.armazem_id) {
        return res.status(400).json({ error: 'Requisição sem armazém de destino.' });
      }

      let locRec = LOCALIZACAO_RECEBIMENTO_FALLBACK;
      const locRecQ = await localizacaoArmazemPorTipo(pool, requisicao.armazem_id, 'recebimento');
      if (locRecQ) locRec = locRecQ;

      const codigoViatura = requisicao.armazem_origem_codigo || 'E';
      const codigoCentral = requisicao.armazem_destino_codigo || '';

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
        itensComFerramenta = (requisicao.itens || []).map((ri) => ({ ...ri, is_ferramenta: false }));
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
        const riMeta = itensComFerramenta.find((it) => it.item_id === b.item_id) || {};
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoViatura,
          OriginLocation: riMeta.localizacao_origem || '',
          Article: String(b.item_codigo || ''),
          Quatity: Number(b.metros) || 0,
          SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoCentral,
          DestinationLocation: locRec,
          ProjectCode: '',
          Batch: b.lote || ''
        });
      }

      for (const ri of itensComFerramenta) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some((b) => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;

        const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
          ? ri.quantidade_preparada
          : ri.quantidade;
        const qty = parseInt(qtyBase, 10) || 0;
        if (qty <= 0) continue;

        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoViatura,
          OriginLocation: ri.localizacao_origem || '',
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoCentral,
          DestinationLocation: locRec,
          ProjectCode: '',
          Batch: ri.lote || ''
        });
      }

      try {
        await pool.query(
          `UPDATE requisicoes
           SET devolucao_tra_gerada_em = COALESCE(devolucao_tra_gerada_em, CURRENT_TIMESTAMP),
               status = CASE
                 WHEN status = 'EM EXPEDICAO' THEN 'APEADOS'
                 ELSE status
               END
           WHERE id = $1`,
          [id]
        );
      } catch (e) {
        if (e.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw e;
      }

      buildExcelTransferencia(rows, res, `DEV_requisicao_${id}_devolucao_${new Date().toISOString().slice(0, 10)}.xlsx`);
      return;
    }

    const statusAceitosTra = fluxoCentralApeado
      ? ['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO']
      : ['EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO'];
    if (!statusAceitosTra.includes(requisicao.status)) {
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

    // Regra de transferência para armazém central:
    // destino deve ser sempre a localização de recebimento.
    let localizacaoDestinoRecebimento = localizacaoNormal;
    if (tipoDestNorm === 'central') {
      const locRecDestino = await localizacaoArmazemPorTipo(pool, armazemDestinoId, 'recebimento');
      if (locRecDestino) localizacaoDestinoRecebimento = locRecDestino;
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
        OriginLocation: fluxoCentralApeado ? (ri.localizacao_origem || '') : localizacaoOrigemTRA,
        Article: String(b.item_codigo || ''),
        Quatity: Number(b.metros) || 0,
        SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoDestino,
        DestinationLocation:
          tipoDestNorm === 'central'
            ? localizacaoDestinoRecebimento
            : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
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
        OriginLocation: fluxoCentralApeado ? (ri.localizacao_origem || '') : localizacaoOrigemTRA,
        Article: String(ri.item_codigo || ''),
        Quatity: qty,
        SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoDestino,
        DestinationLocation:
          tipoDestNorm === 'central'
            ? localizacaoDestinoRecebimento
            : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
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

// TRA de APEADOS (devolução): central recebimento -> armazém APEADO recebimento
// Usa quantidades marcadas como APEADOS em requisicoes_itens.quantidade_apeados.
router.get('/:id/export-tra-apeados', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const destinoApeadoIdRaw = req.query.destino_apeado_id;
    const destinoApeadoId = parseInt(String(destinoApeadoIdRaw || ''), 10);
    if (!Number.isFinite(destinoApeadoId)) {
      return res.status(400).json({ error: 'Informe destino_apeado_id válido.' });
    }

    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }

    // APEADOS deve existir no ciclo; vamos exigir a fase APEADOS.
    if (requisicao.status !== 'APEADOS') {
      return res.status(400).json({ error: 'TRA de APEADOS só está disponível quando a devolução estiver em APEADOS.' });
    }

    if (!requisicao.devolucao_tra_gerada_em) {
      return res.status(400).json({ error: 'Gere primeiro a TRA de devolução.' });
    }

    const apeadosItens = (requisicao.itens || []).filter((it) => {
      const q = parseInt(it.quantidade_apeados ?? 0, 10) || 0;
      return q > 0;
    });

    if (apeadosItens.length === 0) {
      return res.status(400).json({ error: 'Nenhum item marcado como APEADOS (quantidade_apeados > 0).' });
    }

    const apeadoArm = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [destinoApeadoId]);
    if (apeadoArm.rows.length === 0) return res.status(400).json({ error: 'Armazém APEADO destino não encontrado.' });
    const apeadoArmRow = apeadoArm.rows[0];
    const apeadoTipo = String(apeadoArmRow.tipo || '').toLowerCase();
    if (apeadoTipo !== 'apeado') {
      return res.status(400).json({ error: 'Destino deve ser um armazém do tipo APEADO.' });
    }

    // Localização de origem: recebimento do armazém central que recebeu o artigo.
    const centralId = requisicao.armazem_id;
    if (!centralId) return res.status(400).json({ error: 'Requisição sem armazém central (destino da devolução).' });

    let locRecCentral = await localizacaoArmazemPorTipo(pool, centralId, 'recebimento');
    if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;

    // Localização destino: recebimento do armazém APEADO (fallback para código do armazém).
    let locRecApeado = await localizacaoArmazemPorTipo(pool, destinoApeadoId, 'recebimento');
    if (!locRecApeado) locRecApeado = String(apeadoArmRow.codigo || '');
    if (!locRecApeado) return res.status(400).json({ error: 'Localização de recebimento do armazém APEADO não encontrada.' });

    const codigoCentral = String(requisicao.armazem_destino_codigo || '').trim() || (await pool.query('SELECT codigo FROM armazens WHERE id=$1', [centralId])).rows[0]?.codigo || 'E';
    const codigoApeado = String(apeadoArmRow.codigo || '').trim();

    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    // Bobinas (para itens controlados por LOTE)
    const bobinasResult = await pool.query(`
      SELECT
        b.*,
        ri.id AS requisicao_item_id,
        i.codigo AS item_codigo,
        i.tipocontrolo AS tipocontrolo
      FROM requisicoes_itens_bobinas b
      INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id, b.id
    `, [id]);

    const bobinasByRequisicaoItemId = new Map();
    for (const b of bobinasResult.rows || []) {
      const rid = Number(b.requisicao_item_id);
      if (!Number.isFinite(rid)) continue;
      if (!bobinasByRequisicaoItemId.has(rid)) bobinasByRequisicaoItemId.set(rid, []);
      bobinasByRequisicaoItemId.get(rid).push(b);
    }

    const rows = [];
    for (const it of apeadosItens) {
      const apeadosQty = parseInt(it.quantidade_apeados ?? 0, 10) || 0;
      if (apeadosQty <= 0) continue;

      const tipoControlo = String(it.tipocontrolo || '').toUpperCase();

      if (tipoControlo === 'LOTE') {
        const bobinas = bobinasByRequisicaoItemId.get(Number(it.id)) || [];
        const selecionadas = bobinas.slice(0, apeadosQty);
        for (const b of selecionadas) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locRecCentral,
            Article: String(it.item_codigo || b.item_codigo || ''),
            Quatity: Number(b.metros) || 0,
            SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoApeado,
            DestinationLocation: locRecApeado,
            ProjectCode: '',
            Batch: b.lote || ''
          });
        }
      } else if (tipoControlo === 'S/N') {
        const serials = String(it.serialnumber || '')
          .split(/\r?\n|;|\|/)
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const apeadosSerials = serials.slice(0, apeadosQty);
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locRecCentral,
          Article: String(it.item_codigo || ''),
          Quatity: apeadosQty,
          SerialNumber1: apeadosSerials.join('\n'), SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoApeado,
          DestinationLocation: locRecApeado,
          ProjectCode: '',
          Batch: it.lote || ''
        });
      } else {
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locRecCentral,
          Article: String(it.item_codigo || ''),
          Quatity: apeadosQty,
          SerialNumber1: it.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoApeado,
          DestinationLocation: locRecApeado,
          ProjectCode: '',
          Batch: it.lote || ''
        });
      }
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Não foi possível gerar linhas para APEADOS (verifique quantidade_apeados e preparação).' });
    }

    try {
      await pool.query(
        `UPDATE requisicoes
         SET devolucao_tra_apeados_gerada_em = COALESCE(devolucao_tra_apeados_gerada_em, CURRENT_TIMESTAMP),
             tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id]
      );
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Colunas de documentos pendentes em falta.',
          details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
        });
      }
      throw e;
    }

    buildExcelTransferencia(rows, res, `TRA_apeados_devolucao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRA de APEADOS:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA de APEADOS', details: error.message });
  }
});

// TRFL pendente de armazenagem (devolução): central recebimento -> localização escolhida no mesmo central
// Usa somente o saldo remanescente: quantidade_preparada - quantidade_apeados.
router.get('/:id/export-trfl-pendente-armazenagem', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const localizacaoDestinoRaw = String(req.query.localizacao_destino || '').trim();
    let itemLocalizacoes = {};
    try {
      const raw = String(req.query.item_localizacoes || '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          itemLocalizacoes = parsed;
        } else {
          return res.status(400).json({ error: 'item_localizacoes inválido (use objeto JSON por item).' });
        }
      }
    } catch (_) {
      return res.status(400).json({ error: 'item_localizacoes inválido (JSON malformado).' });
    }

    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id)) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }

    const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(requisicao.armazem_origem_tipo, requisicao.armazem_destino_tipo);
    if (!fluxoDevolucao) {
      return res.status(400).json({ error: 'TRFL pendente de armazenagem é apenas para devoluções viatura -> central.' });
    }
    if (requisicao.status !== 'APEADOS') {
      return res.status(400).json({ error: 'TRFL pendente de armazenagem só está disponível em APEADOS.' });
    }
    if (!requisicao.devolucao_tra_gerada_em) {
      return res.status(400).json({ error: 'Gere primeiro o DEV da devolução.' });
    }

    const centralId = requisicao.armazem_id;
    if (!centralId) return res.status(400).json({ error: 'Requisição sem armazém central de destino.' });

    const destLocRows = await pool.query(
      `SELECT localizacao
         FROM armazens_localizacoes
        WHERE armazem_id = $1`,
      [centralId]
    );
    const locDestinoSet = new Set(
      (destLocRows.rows || [])
        .map((r) => String(r.localizacao || '').trim().toUpperCase())
        .filter(Boolean)
    );
    const localizacaoDefault = localizacaoDestinoRaw || null;
    if (!localizacaoDefault && Object.keys(itemLocalizacoes).length === 0) {
      return res.status(400).json({ error: 'Informe localizacao_destino ou item_localizacoes.' });
    }
    if (localizacaoDefault && !locDestinoSet.has(localizacaoDefault.toUpperCase())) {
      return res.status(400).json({ error: 'A localização de destino não pertence ao armazém central desta devolução.' });
    }

    let locRecCentral = await localizacaoArmazemPorTipo(pool, centralId, 'recebimento');
    if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;

    const codigoCentral = String(requisicao.armazem_destino_codigo || '').trim() || 'E';
    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    const bobinasResult = await pool.query(`
      SELECT
        b.*,
        ri.id AS requisicao_item_id,
        i.codigo AS item_codigo
      FROM requisicoes_itens_bobinas b
      INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id, b.id
    `, [id]);
    const bobinasByRequisicaoItemId = new Map();
    for (const b of bobinasResult.rows || []) {
      const rid = Number(b.requisicao_item_id);
      if (!Number.isFinite(rid)) continue;
      if (!bobinasByRequisicaoItemId.has(rid)) bobinasByRequisicaoItemId.set(rid, []);
      bobinasByRequisicaoItemId.get(rid).push(b);
    }

    const rows = [];
    for (const it of (requisicao.itens || [])) {
      const totalQty = parseInt(it.quantidade_preparada ?? it.quantidade, 10) || 0;
      const apeadosQty = parseInt(it.quantidade_apeados ?? 0, 10) || 0;
      const remQty = Math.max(0, totalQty - apeadosQty);
      if (remQty <= 0) continue;
      const keyA = String(it.id);
      const keyB = String(it.item_id);
      const locByItem = String(itemLocalizacoes[keyA] || itemLocalizacoes[keyB] || '').trim();
      const localizacaoDestino = locByItem || localizacaoDefault;
      if (!localizacaoDestino) {
        return res.status(400).json({ error: `Falta localização de destino para o item ${it.item_codigo || it.item_id}.` });
      }
      if (!locDestinoSet.has(localizacaoDestino.toUpperCase())) {
        return res.status(400).json({
          error: `A localização "${localizacaoDestino}" não pertence ao armazém central desta devolução.`
        });
      }

      const tipoControlo = String(it.tipocontrolo || '').toUpperCase();

      if (tipoControlo === 'LOTE') {
        const bobinas = bobinasByRequisicaoItemId.get(Number(it.id)) || [];
        const selecionadas = bobinas.slice(apeadosQty, apeadosQty + remQty);
        for (const b of selecionadas) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locRecCentral,
            Article: String(it.item_codigo || b.item_codigo || ''),
            Quatity: Number(b.metros) || 0,
            SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: localizacaoDestino,
            ProjectCode: '',
            Batch: b.lote || ''
          });
        }
      } else if (tipoControlo === 'S/N') {
        const serials = String(it.serialnumber || '')
          .split(/\r?\n|;|\|/)
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const remSerials = serials.slice(apeadosQty, apeadosQty + remQty);
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locRecCentral,
          Article: String(it.item_codigo || ''),
          Quatity: remQty,
          SerialNumber1: remSerials.join('\n'), SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoCentral,
          DestinationLocation: localizacaoDestino,
          ProjectCode: '',
          Batch: it.lote || ''
        });
      } else {
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locRecCentral,
          Article: String(it.item_codigo || ''),
          Quatity: remQty,
          SerialNumber1: it.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoCentral,
          DestinationLocation: localizacaoDestino,
          ProjectCode: '',
          Batch: it.lote || ''
        });
      }
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum saldo pendente de armazenagem para exportar TRFL.' });
    }

    try {
      await pool.query(
        `UPDATE requisicoes
         SET devolucao_trfl_pendente_gerada_em = COALESCE(devolucao_trfl_pendente_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id]
      );
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Colunas de documentos pendentes em falta.',
          details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
        });
      }
      throw e;
    }

    buildExcelTransferencia(rows, res, `TRFL_pendente_armazenagem_devolucao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRFL pendente de armazenagem:', error);
    res.status(500).json({ error: 'Erro ao exportar TRFL pendente de armazenagem', details: error.message });
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

function clogLocInicial(isDevolucao, localizacaoOrigemTRA, rowMeta) {
  if (isDevolucao) {
    const loc = String(rowMeta?.localizacao_origem || '').trim();
    if (loc) return loc;
  }
  return localizacaoOrigemTRA;
}

function clogRowsFromItemData(
  dateStr,
  codigoDestino,
  colaboradorObs,
  localizacaoOrigemTRA,
  localizacaoFERR,
  localizacaoNormal,
  itensComFerramenta,
  bobinas,
  opts = {}
) {
  const isDevolucao = Boolean(opts?.isDevolucao);
  const tipoMovimento = isDevolucao ? 'Devolucao de carrinha' : 'Saida de Armazem';
  const qtySign = isDevolucao ? 1 : -1;
  const devolucaoDestinoLoc = String(opts?.devolucaoDestinoLoc || '').trim();
  const newLocDevolucao = devolucaoDestinoLoc || LOCALIZACAO_RECEBIMENTO_FALLBACK;
  const rows = [];
  const itemByItemId = new Map(itensComFerramenta.map((it) => [it.item_id, it]));
  const itemIdsComBobina = new Set(bobinas.map((b) => b.item_id));

  for (const b of bobinas) {
    const itemMeta = itemByItemId.get(b.item_id) || {};
    const qty = qtySign * (Number(b.metros) || 0);
    if (qty === 0) continue;

    rows.push({
      'Tipo de Movimento': tipoMovimento,
      'Dt_Recepção': dateStr,
      'REF.': String(b.item_codigo || ''),
      DESCRIPTION: String(b.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: clogLocInicial(isDevolucao, localizacaoOrigemTRA, itemMeta),
      'S/N': b.serialnumber || '',
      Lote: b.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': '',
      'New Localização': isDevolucao ? newLocDevolucao : (itemMeta.is_ferramenta ? localizacaoFERR : localizacaoNormal),
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
    const qty = qtySign * (Number(qtyBase) || 0);
    if (qty === 0) continue;

    rows.push({
      'Tipo de Movimento': tipoMovimento,
      'Dt_Recepção': dateStr,
      'REF.': String(ri.item_codigo || ''),
      DESCRIPTION: String(ri.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: clogLocInicial(isDevolucao, localizacaoOrigemTRA, ri),
      'S/N': ri.serialnumber || '',
      Lote: ri.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': '',
      'New Localização': isDevolucao ? newLocDevolucao : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
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
      a.tipo as armazem_destino_tipo,
      ao.codigo as armazem_origem_codigo,
      ao.tipo as armazem_origem_tipo
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

  const elegiveis = candidatas.filter((r) => {
    const a = armById.get(r.armazem_origem_id);
    if (!a) return false;
    const tipoO = String(a.tipo || '').toLowerCase();
    const tipoD = String(r.armazem_destino_tipo || '').toLowerCase();
    if (tipoO === 'central') return true;
    return isFluxoDevolucaoViaturaCentral(tipoO, tipoD);
  });
  if (elegiveis.length === 0) return [];

  const requisicaoIdsCentral = [...new Set(elegiveis.map((r) => r.id))];
  const origemIdsCentral = [...new Set(elegiveis.map((r) => r.armazem_origem_id))];
  const destArmIds = [...new Set(elegiveis.map((r) => r.armazem_id))];

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
      `SELECT armazem_id, localizacao, id, tipo_localizacao
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
  const recByDestArm = new Map();
  for (const row of allLocsRes.rows) {
    if (!locsByDestArm.has(row.armazem_id)) locsByDestArm.set(row.armazem_id, []);
    locsByDestArm.get(row.armazem_id).push(row);
    if (
      !recByDestArm.has(row.armazem_id) &&
      String(row.tipo_localizacao || '').toLowerCase() === 'recebimento' &&
      String(row.localizacao || '').trim()
    ) {
      recByDestArm.set(row.armazem_id, String(row.localizacao).trim());
    }
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

  const elegiveisById = new Map(elegiveis.map((r) => [r.id, r]));
  const allRows = [];

  for (const id of idsClean) {
    const r = elegiveisById.get(id);
    if (!r) continue;
    const codigoDestino = r.armazem_destino_codigo || '';
    const localizacaoOrigemTRA = expByArm.get(r.armazem_origem_id) || LOCALIZACAO_EXPEDICAO_FALLBACK;
    const locRows = locsByDestArm.get(r.armazem_id) || [];
    const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(codigoDestino, locRows);
    const itens = itensByReq.get(id) || [];
    const bobinas = bobByReq.get(id) || [];
    const isDevolucao = isFluxoDevolucaoViaturaCentral(
      r.armazem_origem_tipo,
      r.armazem_destino_tipo
    );
    const rows = clogRowsFromItemData(
      dateStr,
      codigoDestino,
      r.observacoes || '',
      localizacaoOrigemTRA,
      localizacaoFERR,
      localizacaoNormal,
      itens,
      bobinas,
      {
        isDevolucao,
        devolucaoDestinoLoc: recByDestArm.get(r.armazem_id) || LOCALIZACAO_RECEBIMENTO_FALLBACK
      }
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
  const tipoDestino = String(requisicao.armazem_destino_tipo || '').toLowerCase();
  const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(tipoOrigem, tipoDestino);
  if (tipoOrigem !== 'central' && !fluxoDevolucao) {
    return {
      rows: [],
      eligible: false,
      reason: 'Clog só é gerado com origem armazém central ou com devolução viatura → central.',
    };
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
  let localizacaoRecebimentoDestino = null;
  try {
    localizacaoRecebimentoDestino = await localizacaoArmazemPorTipo(pool, armazemDestinoId, 'recebimento');
  } catch (_) {
    localizacaoRecebimentoDestino = null;
  }

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
    bobinas,
    {
      isDevolucao: fluxoDevolucao,
      devolucaoDestinoLoc: localizacaoRecebimentoDestino || LOCALIZACAO_RECEBIMENTO_FALLBACK
    }
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
      return res.status(400).json({
        error:
          'Nenhuma requisição elegível para gerar Clog (origem central ou devolução viatura→central; TRA/DEV em Entregue ou requisição finalizada).',
      });
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

    const rowsModal = (rows || []).map((r) => ({ ...r, Observações: '' }));
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'DEP', 'Observações'];
    res.json({ columns, rows: rowsModal });
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
      return res.status(400).json({
        error:
          'Nenhuma requisição elegível para Clog (origem central ou devolução viatura→central; TRA/DEV em Entregue ou requisição finalizada).',
      });
    }

    const rowsModal = (allRows || []).map((r) => ({ ...r, Observações: '' }));
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'DEP', 'Observações'];
    res.json({ columns, rows: rowsModal });
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
    const isDevolucaoViaturaCentral = isFluxoDevolucaoViaturaCentral(
      requisicao.armazem_origem_tipo,
      requisicao.armazem_destino_tipo
    );
    const origemReporte = isDevolucaoViaturaCentral
      ? (requisicao.armazem_origem_codigo || localizacaoOrigemTRA)
      : localizacaoOrigemTRA;

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
        ORIGEM: origemReporte,
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
        ORIGEM: origemReporte,
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
    const isDevolucaoViaturaCentral = isFluxoDevolucaoViaturaCentral(
      requisicao.armazem_origem_tipo,
      requisicao.armazem_destino_tipo
    );
    const origemReporte = isDevolucaoViaturaCentral
      ? (requisicao.armazem_origem_codigo || localizacaoOrigemTRA)
      : localizacaoOrigemTRA;

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
        ORIGEM: origemReporte,
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
        ORIGEM: origemReporte,
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
      const isDevolucaoViaturaCentral = isFluxoDevolucaoViaturaCentral(
        requisicao.armazem_origem_tipo,
        requisicao.armazem_destino_tipo
      );
      const origemReporte = isDevolucaoViaturaCentral
        ? (requisicao.armazem_origem_codigo || localizacaoOrigemTRA)
        : localizacaoOrigemTRA;

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
          ORIGEM: origemReporte,
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
          ORIGEM: origemReporte,
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
      const isDevolucaoViaturaCentral = isFluxoDevolucaoViaturaCentral(
        requisicao.armazem_origem_tipo,
        requisicao.armazem_destino_tipo
      );
      const origemReporte = isDevolucaoViaturaCentral
        ? (requisicao.armazem_origem_codigo || localizacaoOrigemTRA)
        : localizacaoOrigemTRA;

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
          ORIGEM: origemReporte,
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
          ORIGEM: origemReporte,
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
          a.tipo AS armazem_destino_tipo,
          ao.tipo AS armazem_origem_tipo,
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
        i.tipocontrolo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) AS is_ferramenta
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
    const sheetName1 = workbook.SheetNames[0];
    const sheetName2 = workbook.SheetNames[1];
    const sheet1 = sheetName1 ? workbook.Sheets[sheetName1] : null;
    const sheet2 = sheetName2 ? workbook.Sheets[sheetName2] : null;

    if (!sheet1) {
      return res.status(400).json({ error: 'Ficheiro Excel sem folha válida na página 1.' });
    }

    const normalizeText = (v) =>
      String(v || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const scanCodigoV = (sheet) => {
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
      return codigoArmazemDestino;
    };

    const parseItensFromSheet = (sheet, { tolerarSemCabecalho }) => {
      const range = XLSX.utils.decode_range(sheet['!ref']);

      // Cabeçalho: Artigo | (Descrição) | Quantidade
      let headerRowNumber = null;
      let colArtigo = null;
      let colQuantidade = null;

      for (let R = range.s.r; R <= range.e.r; R++) {
        let hasArtigo = false;
        let hasQuantidade = false;
        let hasDescricao = false;
        let detectedColArtigo = null;
        let detectedColQtd = null;

        for (let C = range.s.c; C <= range.e.c; C++) {
          const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = sheet[cellAddr];
          if (!cell || cell.v == null) continue;

          const text = normalizeText(cell.v);
          if (text === 'artigo') {
            hasArtigo = true;
            detectedColArtigo = C;
          }
          if (text === 'quantidade') {
            hasQuantidade = true;
            detectedColQtd = C;
          }
          if (text.includes('descr')) {
            hasDescricao = true;
          }
        }

        if (hasArtigo && hasQuantidade && hasDescricao) {
          headerRowNumber = R;
          colArtigo = detectedColArtigo;
          colQuantidade = detectedColQtd;
          break;
        }
      }

      if (headerRowNumber == null || colArtigo == null || colQuantidade == null) {
        if (tolerarSemCabecalho) {
          return { itens: [] };
        }
        throw new Error('Cabeçalho Artigo/Descrição/Quantidade não encontrado no Excel.');
      }

      // Ler linhas de itens
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
        return { itens: [] };
      }

      return { quantidadePorCodigo, codigosUnicos };
    };

    const criarRequisicao = async ({
      client,
      itens,
      armazemOrigemIdReq,
      armazemDestinoId,
      observacoes
    }) => {
      const reqResult = await client.query(
        `
          INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
          VALUES ($1, $2, $3, $4, 'pendente')
          RETURNING id
        `,
        [armazemOrigemIdReq || null, armazemDestinoId, observacoes, req.user.id]
      );

      const requisicaoId = reqResult.rows[0].id;

      const itemIds = itens.map((i) => i.item_id);
      const quantidades = itens.map((i) => i.quantidade);
      await client.query(
        `
          INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
          SELECT $1::int, x.item_id, x.quantidade
          FROM unnest($2::int[], $3::int[]) AS x(item_id, quantidade)
          ON CONFLICT (requisicao_id, item_id)
          DO UPDATE SET quantidade = EXCLUDED.quantidade
        `,
        [requisicaoId, itemIds, quantidades]
      );

      return requisicaoId;
    };

    const parseSheetForImport = async (sheet, kind) => {
      // Página 2 (devolução): não usamos o Vxxx para definir armazéns.
      // A devolução herda os armazéns através da regra:
      //   - armazem_origem (devolução) = armazem_destino (requisição página 1)
      //   - armazem_destino (devolução) = armazem_origem (requisição, escolhido pelo utilizador)
      if (kind === 'devolucao') {
        const parsed = parseItensFromSheet(sheet, { tolerarSemCabecalho: true });
        if (!parsed || Array.isArray(parsed.itens)) {
          return { itens: Array.isArray(parsed?.itens) ? parsed.itens : [] };
        }

        const { quantidadePorCodigo, codigosUnicos } = parsed;
        if (!codigosUnicos || codigosUnicos.length === 0) {
          return { itens: [] };
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
        return { itens };
      }

      // Página 1 (requisição): Vxxx no Excel determina o armazém destino.
      const codigoArmazemDestino = scanCodigoV(sheet);
      if (!codigoArmazemDestino) {
        throw new Error('Não foi possível identificar o armazém destino no Excel (código Vxxx).');
      }

      const armazemRes = await pool.query(
        'SELECT id, tipo FROM armazens WHERE UPPER(codigo) = $1',
        [codigoArmazemDestino.toUpperCase()]
      );
      if (armazemRes.rows.length === 0) {
        throw new Error(`Armazém destino ${codigoArmazemDestino} não encontrado no sistema.`);
      }

      const armazemDestinoId = armazemRes.rows[0].id;
      const armazemDestinoTipo = armazemRes.rows[0].tipo;

      const parsed = parseItensFromSheet(sheet, { tolerarSemCabecalho: false });
      if (!parsed || !Array.isArray(parsed.itens) && !parsed.codigosUnicos) {
        return { itens: [] };
      }

      if (parsed.itens) {
        return { itens: [], armazemDestinoId, armazemDestinoTipo };
      }

      const { quantidadePorCodigo, codigosUnicos } = parsed;
      if (!codigosUnicos || codigosUnicos.length === 0) {
        return { itens: [], armazemDestinoId, armazemDestinoTipo };
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

      return { itens, armazemDestinoId, armazemDestinoTipo };
    };

    let parsedReq = null;
    try {
      parsedReq = await parseSheetForImport(sheet1, 'requisicao');
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Erro ao interpretar página 1 do Excel.' });
    }
    if (!parsedReq || !Array.isArray(parsedReq.itens) || parsedReq.itens.length === 0) {
      return res.status(400).json({ error: 'Nenhum item válido encontrado na página 1 (requisição).' });
    }

    // Criar requisição (página 1)
    const client = await pool.connect();
    let requisicaoId = null;
    let devolucaoId = null;
    try {
      await client.query('BEGIN');
      requisicaoId = await criarRequisicao({
        client,
        itens: parsedReq.itens,
        armazemOrigemIdReq: armazemOrigemId,
        armazemDestinoId: parsedReq.armazemDestinoId,
        observacoes: 'Importada de Excel (página 1)'
      });

      // Criar devolução (página 2) apenas se houver artigos listados
      if (sheet2) {
        const parsedDev = await parseSheetForImport(sheet2, 'devolucao');
        const temItensDev = parsedDev?.itens && parsedDev.itens.length > 0;
        if (temItensDev) {
          // Regra pedida:
          //   - devolução armazem_origem = destino da requisição (página 1)
          //   - devolução armazem_destino = origem da requisição (selecionada no frontend)
          const armazemOrigemDevTipo = String(parsedReq.armazemDestinoTipo || '').toLowerCase();
          const armazemDestinoDevTipo = String(ao.rows[0]?.tipo || '').toLowerCase();
          if (armazemOrigemDevTipo !== 'viatura') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error:
                'Página 2 tem artigos (devolução), mas a destino da requisição (página 1) não é do tipo viatura.'
            });
          }
          if (armazemDestinoDevTipo !== 'central') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error:
                'Página 2 tem artigos (devolução), mas a origem selecionada na requisição não é do tipo central (destino da devolução).'
            });
          }

          devolucaoId = await criarRequisicao({
            client,
            itens: parsedDev.itens,
            armazemOrigemIdReq: parsedReq.armazemDestinoId,
            armazemDestinoId: armazemOrigemId,
            observacoes: 'Importada de Excel (página 2 - Devolução)'
          });
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ requisicao_id: requisicaoId, devolucao_id: devolucaoId || null });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar requisições via Excel:', e);
      res.status(500).json({ error: 'Erro ao criar requisições via Excel', details: e.message });
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
    if (status && !['pendente', 'EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO', 'cancelada'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Status inválido. Use: pendente, EM SEPARACAO, separado, EM EXPEDICAO, APEADOS, Entregue, FINALIZADO ou cancelada'
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
    const {
      requisicao_item_id,
      quantidade_preparada,
      quantidade_apeados,
      localizacao_origem,
      localizacao_destino,
      lote,
      serialnumber,
      bobinas,
      serials,
    } = req.body;

    if (!requisicao_item_id || quantidade_preparada === undefined || quantidade_preparada < 0) {
      return res.status(400).json({ error: 'requisicao_item_id e quantidade_preparada são obrigatórios (use 0 se não tiver o item).' });
    }
    const isZero = Number(quantidade_preparada) === 0;
    let quantidadeApeadosFinal = 0;
    if (!isZero) {
      const qApeadosRaw = quantidade_apeados === undefined ? 0 : Number(quantidade_apeados);
      if (!Number.isFinite(qApeadosRaw)) {
        return res.status(400).json({ error: 'quantidade_apeados deve ser numérico (use 0 se não tiver APEADOS).' });
      }
      if (!Number.isInteger(qApeadosRaw)) {
        return res.status(400).json({ error: 'quantidade_apeados deve ser um inteiro.' });
      }
      if (qApeadosRaw < 0) {
        return res.status(400).json({ error: 'quantidade_apeados não pode ser negativo.' });
      }
      const totalQtyInt = Number(quantidade_preparada);
      if (qApeadosRaw > totalQtyInt) {
        return res.status(400).json({
          error: 'quantidade_apeados não pode ser superior à quantidade preparada.',
        });
      }
      quantidadeApeadosFinal = qApeadosRaw;
    }
    const locOrigem = typeof localizacao_origem === 'string' ? localizacao_origem.trim() : '';
    if (!isZero && !locOrigem) {
      return res.status(400).json({ error: 'Localização de saída (onde está saindo) é obrigatória quando há quantidade preparada.' });
    }

    await client.query('BEGIN');
    let check;
    try {
      check = await client.query(
        'SELECT id, status, armazem_origem_id, armazem_id, separador_usuario_id FROM requisicoes WHERE id = $1 FOR UPDATE',
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
      `SELECT ri.*, i.tipocontrolo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) AS is_ferramenta
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

    if (!isZero && check.rows[0].armazem_origem_id && check.rows[0].armazem_id) {
      const tiposR = await client.query(
        `SELECT ao.tipo AS origem_tipo, ad.tipo AS dest_tipo, ao.codigo AS origem_codigo
         FROM armazens ao
         CROSS JOIN armazens ad
         WHERE ao.id = $1 AND ad.id = $2`,
        [check.rows[0].armazem_origem_id, check.rows[0].armazem_id]
      );
      const tr = tiposR.rows[0];
      if (tr && isFluxoDevolucaoViaturaCentral(tr.origem_tipo, tr.dest_tipo)) {
        const codV = String(tr.origem_codigo || '').trim().toUpperCase();
        const isFerr = item.is_ferramenta === true;
        const expected = isFerr ? `${codV}.FERR` : codV;
        const lo = locOrigem.trim().toUpperCase();
        if (lo !== expected) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: isFerr
              ? `Devolução da viatura: a localização de origem deste artigo (ferramenta) deve ser ${expected}.`
              : `Devolução da viatura: a localização de origem deste artigo deve ser ${expected} (não use ${codV}.FERR exceto para ferramentas).`
          });
        }
      }
    }

    // Validar Lote/Serial/Bobinas conforme tipo de controlo do item, apenas quando há saída
    const tipoControlo = (item.tipocontrolo || '').toUpperCase();
    let serialsNormalizados = null;
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
      if (tipoControlo === 'S/N') {
        if (Array.isArray(serials)) {
          serialsNormalizados = serials.map((s) => String(s || '').trim()).filter(Boolean);
          if (serialsNormalizados.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe pelo menos um serial number.` });
          }
          const serialsUnicos = new Set(serialsNormalizados);
          if (serialsUnicos.size !== serialsNormalizados.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Item ${item.item_id} contém serial numbers duplicados. Remova os repetidos antes de confirmar.`
            });
          }
        } else if (!serialnumber || String(serialnumber).trim() === '') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe o Serial number na preparação.` });
        }
      }
    }

    // Localização destino é sempre EXPEDICAO (automático) quando há saída
    const localizacaoDestinoFinal = isZero ? null : 'EXPEDICAO';

    const serialnumberFinal = isZero
      ? null
      : (serialsNormalizados ? serialsNormalizados.join('\n') : (serialnumber || null));

    const updateQuery = `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = COALESCE($5, serialnumber),
          quantidade_apeados = $6,
          preparacao_confirmada = true
      WHERE id = $7`;
    const params = [
      quantidade_preparada,
      localizacaoDestinoFinal,
      isZero ? null : locOrigem,
      isZero ? null : (lote || null),
      serialnumberFinal,
      quantidadeApeadosFinal,
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
    if (['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'].includes(check.rows[0].status)) {
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
    if (!['EM EXPEDICAO', 'APEADOS'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Só pode marcar como entregue quando a requisição está em expedição (EM EXPEDICAO) ou APEADOS.' });
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
      `SELECT
         r.id,
         r.status,
         r.armazem_origem_id,
         r.separador_usuario_id,
         r.tra_gerada_em,
         r.devolucao_tra_gerada_em,
         r.devolucao_tra_apeados_gerada_em,
         r.devolucao_trfl_pendente_gerada_em,
         ao.tipo AS origem_tipo,
         ad.tipo AS destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
       LEFT JOIN armazens ad ON ad.id = r.armazem_id
       WHERE r.id = $1`,
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
    const row = check.rows[0];
    const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(row.origem_tipo, row.destino_tipo);
    const fluxoCentralApeado =
      String(row.origem_tipo || '').trim().toLowerCase() === 'central' &&
      String(row.destino_tipo || '').trim().toLowerCase() === 'apeado';
    if (fluxoDevolucao) {
      const docsPendentesOk = Boolean(row.devolucao_tra_apeados_gerada_em) && Boolean(row.devolucao_trfl_pendente_gerada_em);
      if (!(['EM EXPEDICAO', 'APEADOS'].includes(row.status) && row.devolucao_tra_gerada_em && docsPendentesOk)) {
        return res.status(400).json({
          error: 'No fluxo de devolução, só é possível finalizar após gerar DEV, TRA APEADOS e TRFL PENDENTE.'
        });
      }
    } else if (fluxoCentralApeado) {
      if (!(['separado', 'Entregue'].includes(row.status) && Boolean(row.tra_gerada_em))) {
        return res.status(400).json({
          error: 'Para transferência Central -> APEADO, finalize apenas após gerar a TRA.'
        });
      }
    } else if (row.status !== 'Entregue') {
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
    const statusRestritosAdmin = ['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'];
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
