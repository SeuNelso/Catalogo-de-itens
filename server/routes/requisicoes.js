/**
 * Rotas /api/requisicoes — montar com app.use('/api/requisicoes', createRequisicoesRouter(deps))
 */
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pdfParseLib = require('pdf-parse');
const { buildExcelTransferencia } = require('../utils/buildExcelTransferencia');
const { quantidadeStockNacionalNoArmazem } = require('../utils/stockNacionalMatch');
const ITENS_NACIONAL_CACHE_TTL_MS = 20000;
const itensNacionalPorArmazemCache = new Map();

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
  isFluxoDevolucaoViaturaCentral,
  isFluxoDevolucaoEpiCentral,
  isFluxoDevolucaoParaCentral,
} = require('../middleware/requisicoesScope');
const { usuarioTemPermissaoControloStock, usuarioTemPermissaoConsultaMovimentos } = require('../utils/usuarioDbColumns');
const { quantidadePreparadaEfetiva, itemTemSaidaTrflTra } = require('../services/requisicoes/preparacaoUtils');

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

/** Admin pode remover linha de artigo (mín. 2 linhas) em preparação ou expedição. */
function adminPodeRemoverLinhaRequisicao(status, role) {
  if (!isAdmin(role)) return false;
  const st = String(status || '');
  return ['pendente', 'EM SEPARACAO', 'separado', 'EM EXPEDICAO'].includes(st);
}

/** Operador: só separação e entrega; bloqueia TRFL/TRA/Reporte/Clog, criar/editar/apagar req., finalizar, marcar em expedição. */
function denyOperador(req, res, next) {
  if (req.user && (isOperador(req.user.role) || req.user.role === 'backoffice_operations')) {
    return res.status(403).json({
      error:
        'Perfil sem permissão para esta operação. Este utilizador pode apenas criar e monitorizar requisições no seu escopo.',
      code: 'PERFIL_RESTRITO',
    });
  }
  next();
}

function denyOnlyOperador(req, res, next) {
  if (req.user && isOperador(req.user.role)) {
    return res.status(403).json({
      error:
        'Operadores só podem consultar e separar requisições dos seus armazéns e marcar entrega; não podem executar esta operação.',
      code: 'OPERADOR_RESTRITO',
    });
  }
  next();
}

function denyBackofficeOperations(req, res, next) {
  if (req.user && req.user.role === 'backoffice_operations') {
    return res.status(403).json({
      error:
        'Backoffice Operations pode apenas criar e monitorizar requisições/devoluções/transferências no seu escopo.',
      code: 'BACKOFFICE_OPERATIONS_RESTRITO',
    });
  }
  next();
}

function denyNonAdmin(req, res, next) {
  if (!req.user || !isAdmin(req.user.role)) {
    return res.status(403).json({
      error: 'Apenas administradores podem executar esta operação.',
      code: 'ADMIN_ONLY',
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

const SQL_CANCELADOR_NOME = `COALESCE(
  NULLIF(TRIM(CONCAT(COALESCE(cu.nome, ''), ' ', COALESCE(cu.sobrenome, ''))), ''),
  NULLIF(TRIM(COALESCE(cu.username, '')), ''),
  NULLIF(TRIM(COALESCE(cu.numero_colaborador::text, '')), ''),
  '—'
)`;

const SQL_LISTA_CRIADOR_E_SEPARADOR = `${SQL_CRIADOR_COM_EMAIL},
        r.separador_usuario_id,
        ${SQL_SEPARADOR_NOME} AS separador_nome,
        r.cancelada_em,
        r.cancelada_por_usuario_id,
        ${SQL_CANCELADOR_NOME} AS cancelada_por_nome`;

const EPI_DISCLAIMER_PADRAO =
  'Declaração (DL 348/93 de 1 de Outubro): Declaro(a) que recebi os Equipamentos de Proteção Individual (EPI) acima mencionados e que fui informado(a) dos respetivos riscos que pretendem proteger, comprometendo-me a utilizá-los corretamene de acordo com as instruções recebidas, a conservá-los e mantê-los em bom estado, e a participar ao meu superior hierárquico todas as avarias ou deficiências de que tenha conhecimento.';

function makeStockPrepBizError(status, error, code, extra) {
  const err = new Error(error);
  err.isStockPrepBiz = true;
  err.status = status;
  err.payload = { error, ...(code ? { code } : {}), ...extra };
  return err;
}

function isTipoControloSerial(tipoControlo) {
  const raw = String(tipoControlo || '').trim().toUpperCase();
  if (!raw) return false;
  const norm = raw.replace(/\s+/g, '');
  return norm === 'S/N' || norm === 'SN' || norm === 'SERIAL';
}

/** Separa S/N de caixa opcional numa linha (tab, pipe ou espaço — espelha import no cliente). */
function serialLimpoDeLinhaComCaixa(raw) {
  const line = String(raw || '').trim();
  if (!line) return { sn: '', caixa: '' };
  const tab = line.indexOf('\t');
  if (tab > 0) {
    return {
      sn: line.slice(0, tab).trim(),
      caixa: line.slice(tab + 1).trim(),
    };
  }
  const pipe = line.indexOf('|');
  if (pipe > 0) {
    return {
      sn: line.slice(0, pipe).trim(),
      caixa: line.slice(pipe + 1).trim(),
    };
  }
  const spaceParts = line.split(/\s+/).filter(Boolean);
  if (spaceParts.length >= 2) {
    return {
      sn: spaceParts[0],
      caixa: spaceParts.slice(1).join(' ') || '',
    };
  }
  return { sn: line, caixa: '' };
}

function serialsNormalizadosList(value) {
  const isSerialInformadoValido = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return false;
    const norm = s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (norm === 'sem serial') return false;
    return true;
  };
  const seen = new Set();
  const out = [];
  const pushSn = (raw) => {
    const { sn } = serialLimpoDeLinhaComCaixa(raw);
    if (!isSerialInformadoValido(sn)) return;
    const k = sn.toUpperCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(sn);
  };
  const raw = String(value || '');
  if (/\r?\n/.test(raw)) {
    for (const line of raw.split(/\r?\n/).map((l) => String(l || '').trim()).filter(Boolean)) {
      pushSn(line);
    }
    return out;
  }
  for (const chunk of raw.split(';').map((s) => String(s || '').trim()).filter(Boolean)) {
    pushSn(chunk);
  }
  return out;
}

/** { sn, caixa } com sn único (case-insensitive), primeira caixa ganha. */
function dedupeSeriaisLinhasPorSerial(linhas) {
  const seen = new Set();
  const out = [];
  for (const row of linhas || []) {
    const sn = String(row?.sn || row?.serial || row?.serialnumber || '').trim();
    if (!sn) continue;
    const k = sn.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const cxSrc = row?.caixa ?? row?.codigo_caixa;
    const caixaRaw = cxSrc != null ? String(cxSrc).trim() : '';
    out.push({ sn, caixa: caixaRaw || null });
  }
  return out;
}

/** Extrai lista { sn, caixa } do body de uma linha de item (recebimento / API). */
function extractSeriaisLinhasFromItemBody(x) {
  const acc = [];
  if (Array.isArray(x?.seriais_linhas)) {
    for (const row of x.seriais_linhas) {
      const sn = String(row?.serial ?? row?.serialnumber ?? row?.sn ?? '').trim();
      const caixa = String(
        row?.caixa ?? row?.codigo_caixa ?? row?.box ?? row?.embalagem ?? row?.n_caixa ?? ''
      ).trim();
      if (sn) acc.push({ sn, caixa: caixa || null });
    }
  }
  if (Array.isArray(x?.seriais)) {
    for (const s of x.seriais) {
      if (s != null && typeof s === 'object' && !Array.isArray(s)) {
        const sn = String(s.serial ?? s.serialnumber ?? s.sn ?? '').trim();
        const caixa = String(s.caixa ?? s.codigo_caixa ?? s.box ?? s.embalagem ?? '').trim();
        if (sn) acc.push({ sn, caixa: caixa || null });
      } else {
        const t = String(s || '').trim();
        if (t) acc.push({ sn: t, caixa: null });
      }
    }
  }
  if (x?.serial != null && String(x.serial).trim()) {
    for (const sn of serialsNormalizadosList(String(x.serial))) {
      acc.push({ sn, caixa: null });
    }
  }
  if (x?.seriais_text != null && String(x.seriais_text).trim()) {
    for (const sn of serialsNormalizadosList(String(x.seriais_text))) {
      acc.push({ sn, caixa: null });
    }
  }
  return dedupeSeriaisLinhasPorSerial(acc);
}

const CLOG_TIPO_DEVOLUCAO_EPI = 'Devolucao EPI';
const CLOG_TIPO_DEVOLUCAO_CARRINHA = 'Devolucao de carrinha';

/** Armazém EPI por tipo ou heurística código/descrição (Clog / consulta movimentos). */
function armazemOrigemEhEpi(origemTipo, origemCodigo, origemDescricao) {
  if (String(origemTipo || '').trim().toLowerCase() === 'epi') return true;
  const cod = String(origemCodigo || '').toUpperCase();
  const desc = String(origemDescricao || '').toUpperCase();
  return cod.includes('EPI') || desc.includes('EPI');
}

/** Devolução para central: viatura/EPI explícitos ou armazém EPI por heurística. */
function isFluxoDevolucaoParaCentralClog(requisicaoOrOrigemTipo, destinoTipo, origemCodigo, origemDescricao) {
  if (requisicaoOrOrigemTipo && typeof requisicaoOrOrigemTipo === 'object') {
    const rec = requisicaoOrOrigemTipo;
    if (isFluxoDevolucaoParaCentral(rec.armazem_origem_tipo, rec.armazem_destino_tipo)) return true;
    if (String(rec.armazem_destino_tipo || '').trim().toLowerCase() !== 'central') return false;
    return armazemOrigemEhEpi(
      rec.armazem_origem_tipo,
      rec.armazem_origem_codigo,
      rec.armazem_origem_descricao
    );
  }
  if (isFluxoDevolucaoParaCentral(requisicaoOrOrigemTipo, destinoTipo)) return true;
  if (String(destinoTipo || '').trim().toLowerCase() !== 'central') return false;
  return armazemOrigemEhEpi(requisicaoOrOrigemTipo, origemCodigo, origemDescricao);
}

function tipoMovimentoClogParaDevolucao(origemTipo, destinoTipo, origemCodigo, origemDescricao) {
  if (
    isFluxoDevolucaoEpiCentral(origemTipo, destinoTipo) ||
    (String(destinoTipo || '').trim().toLowerCase() === 'central' &&
      armazemOrigemEhEpi(origemTipo, origemCodigo, origemDescricao))
  ) {
    return CLOG_TIPO_DEVOLUCAO_EPI;
  }
  return CLOG_TIPO_DEVOLUCAO_CARRINHA;
}

/** Snapshots antigos classificavam EPI→central como devolução de carrinha. */
function normalizarTipoMovimentoClogDevolucao(row) {
  if (!row || typeof row !== 'object') return row;
  const t = String(row['Tipo de Movimento'] || '').trim().toLowerCase();
  if (t !== 'devolucao de carrinha') return row;
  const origemTipo = String(row.armazem_origem_tipo || '').toLowerCase();
  const destinoTipo = String(row.armazem_destino_tipo || '').toLowerCase();
  if (
    isFluxoDevolucaoEpiCentral(origemTipo, destinoTipo) ||
    (destinoTipo === 'central' &&
      armazemOrigemEhEpi(
        origemTipo,
        row.armazem_origem_codigo,
        row.armazem_origem_descricao
      ))
  ) {
    return { ...row, 'Tipo de Movimento': CLOG_TIPO_DEVOLUCAO_EPI };
  }
  return row;
}

function ordemTipoMovimentoClog(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  if (t === 'transf. apeado') return 1;
  if (t === 'devolucao epi' || t === 'devolucao de carrinha') return 2;
  return 9;
}

const {
  STOCK_STATUS,
  SQL_STOCK_LOTE_STATUS,
  statusStockLoteFromQuantidades,
  reservarMetros: reservarMetrosStockLote,
  liberarMetrosPorRequisicaoItem: liberarMetrosStockLotePorRequisicaoItem,
} = require('../services/stock/lote');
const { quantidadeNecessariaStockPreparacao } = require('../services/requisicoes/preparacaoUtils');
const { logStockMovimento: logStockMovimentoAuditoria } = require('../services/stock/auditoria');
const { localizacaoExisteNoArmazem } = require('../services/stock/consulta');
const { makeStockPrepBizError: makeStockPrepBizErrorSvc } = require('../services/stock/lote');

async function liberarReservasLotePorRequisicaoItemModule(db, opts) {
  await liberarMetrosStockLotePorRequisicaoItem(db, (mov) => logStockMovimentoAuditoria(mov), opts);
}

async function liberarReservasLotePorRequisicaoModule(db, opts) {
  const itens = await db.query(`SELECT id FROM requisicoes_itens WHERE requisicao_id = $1`, [
    opts.requisicaoId,
  ]);
  for (const it of itens.rows || []) {
    // eslint-disable-next-line no-await-in-loop
    await liberarReservasLotePorRequisicaoItemModule(db, {
      requisicaoItemId: it.id,
      usuarioId: opts.usuarioId,
      origem: opts.origem,
    });
  }
}

function armazemControlaSerialNumbers(tipoArmazem, compartilhaStockSerial) {
  if (compartilhaStockSerial === true || compartilhaStockSerial === false) {
    return compartilhaStockSerial;
  }
  const tipo = String(tipoArmazem || '').trim().toLowerCase();
  return tipo === 'central' || tipo === 'apeado' || tipo === 'apeados';
}

async function obterCompartilhaStockSerialArmazem(db, armazemId, tipoArmazemFallback) {
  if (!armazemId) return armazemControlaSerialNumbers(tipoArmazemFallback);
  // Em transação, um SELECT que falha (ex. coluna em falta, 42703) aborta o bloco até ROLLBACK.
  // SAVEPOINT permite recuperar e aplicar o fallback sem invalidar o resto da transação.
  const sp = `sp_cs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let savepointAtivo = false;
  try {
    await db.query(`SAVEPOINT ${sp}`);
    savepointAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    const q = await db.query(
      `SELECT compartilha_stock_serial
       FROM armazens
       WHERE id = $1`,
      [armazemId]
    );
    if (savepointAtivo) {
      try {
        await db.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (!q.rows.length) return armazemControlaSerialNumbers(tipoArmazemFallback);
    const v = q.rows[0].compartilha_stock_serial;
    if (v === true || v === false) return v;
    return armazemControlaSerialNumbers(tipoArmazemFallback);
  } catch (e) {
    if (savepointAtivo) {
      try {
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') {
      return armazemControlaSerialNumbers(tipoArmazemFallback);
    }
    throw e;
  }
}

/** Armazém central + armazens_localizacao_item: exige quantidade na localização de saída (só chamada se o utilizador tiver controlo de stock). */
async function assertStockSuficientePreparacaoLocalizacao(client, opts) {
  const { armazemOrigemId, itemId, itemCodigo, locLabel, needQty } = opts;
  const need = Number(needQty);
  if (!armazemOrigemId || !Number.isFinite(need) || need <= 0) return;
  const lab = (locLabel && String(locLabel).trim()) || '';
  if (!lab) return;
  const tipoR = await client.query(
    `SELECT LOWER(TRIM(COALESCE(tipo,''))) AS tipo FROM armazens WHERE id = $1`,
    [armazemOrigemId]
  );
  if (!tipoR.rows[0] || tipoR.rows[0].tipo !== 'central') return;
  try {
    const r = await client.query(
      `SELECT ali.quantidade::numeric AS q
       FROM armazens_localizacao_item ali
       INNER JOIN armazens_localizacoes al ON al.id = ali.localizacao_id AND al.armazem_id = $1
       WHERE ali.item_id = $2 AND UPPER(TRIM(al.localizacao)) = UPPER(TRIM($3::text))`,
      [armazemOrigemId, itemId, lab]
    );
    const disp = r.rows.length ? Number(r.rows[0].q) : 0;
    if (disp + 1e-9 < need) {
      throw makeStockPrepBizError(
        400,
        disp <= 0
          ? `Não há stock do artigo ${itemCodigo || itemId} na localização «${lab}».`
          : `Stock insuficiente na localização «${lab}» para o artigo ${itemCodigo || itemId} (disponível: ${disp}, necessário: ${need}).`,
        disp <= 0 ? 'STOCK_LOCALIZACAO_PREPARACAO_INEXISTENTE' : 'STOCK_PREPARACAO_INSUFICIENTE',
        { item_id: itemId, disponivel: disp, necessario: need }
      );
    }
  } catch (e) {
    throw e;
  }
}

async function resolveLocalizacaoIdPorCodigo(client, armazemId, label) {
  const r = await client.query(
    `SELECT id FROM armazens_localizacoes
     WHERE armazem_id = $1 AND UPPER(TRIM(localizacao)) = UPPER(TRIM($2::text))
     LIMIT 1`,
    [armazemId, label]
  );
  return r.rows[0]?.id ?? null;
}

async function resolveLocalizacaoExpedicaoId(client, armazemId) {
  const sp = `sp_exp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let savepointAtivo = false;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    savepointAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    const r = await client.query(
      `SELECT id FROM armazens_localizacoes
       WHERE armazem_id = $1
         AND (
           LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao'
           OR UPPER(TRIM(localizacao)) = 'EXPEDICAO'
         )
       ORDER BY id
       LIMIT 1`,
      [armazemId]
    );
    if (savepointAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
    return r.rows[0]?.id ?? null;
  } catch (e) {
    if (savepointAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') {
      const r2 = await client.query(
        `SELECT id FROM armazens_localizacoes
         WHERE armazem_id = $1 AND UPPER(TRIM(localizacao)) = 'EXPEDICAO'
         ORDER BY id
         LIMIT 1`,
        [armazemId]
      );
      return r2.rows[0]?.id ?? null;
    }
    throw e;
  }
}

async function adicionarQtyArmazemLocalizacaoItem(client, localizacaoId, itemId, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return;
  await client.query(
    `INSERT INTO armazens_localizacao_item (localizacao_id, item_id, quantidade)
     VALUES ($1, $2, $3::numeric)
     ON CONFLICT (localizacao_id, item_id) DO UPDATE SET
       quantidade = armazens_localizacao_item.quantidade + EXCLUDED.quantidade,
       updated_at = CURRENT_TIMESTAMP`,
    [localizacaoId, itemId, q]
  );
}

async function localizacaoArmazemPorTipoConn(poolConn, armazemId, tipoLoc) {
  if (!armazemId) return null;
  const r = await poolConn.query(
    `SELECT localizacao FROM armazens_localizacoes
     WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = $2
     ORDER BY id LIMIT 1`,
    [armazemId, String(tipoLoc || '').toLowerCase()]
  );
  return r.rows[0]?.localizacao || null;
}

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

async function validarVinculoTransferenciaCentral(client, { armazemOrigemId, armazemDestinoId }) {
  const origemId = parseInt(armazemOrigemId, 10);
  const destinoId = parseInt(armazemDestinoId, 10);
  if (!Number.isFinite(origemId) || !Number.isFinite(destinoId)) return;

  let armRows;
  const sp = `sp_vvtc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let savepointAtivo = false;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    savepointAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    const arm = await client.query(
      `SELECT id, LOWER(TRIM(COALESCE(tipo, ''))) AS tipo, armazem_central_vinculado_id
       FROM armazens
       WHERE id = ANY($1::int[])`,
      [[origemId, destinoId]]
    );
    armRows = arm.rows || [];
    if (savepointAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (e) {
    if (savepointAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code !== '42703') throw e;
    const arm = await client.query(
      `SELECT id, LOWER(TRIM(COALESCE(tipo, ''))) AS tipo
       FROM armazens
       WHERE id = ANY($1::int[])`,
      [[origemId, destinoId]]
    );
    armRows = (arm.rows || []).map((r) => ({ ...r, armazem_central_vinculado_id: null }));
  }

  const byId = new Map(armRows.map((r) => [Number(r.id), r]));
  const origem = byId.get(origemId);
  const destino = byId.get(destinoId);
  if (!origem || !destino) return;

  const tipoOrigem = String(origem.tipo || '').toLowerCase();
  const tipoDestino = String(destino.tipo || '').toLowerCase();
  if (tipoOrigem !== 'central') return;
  if (tipoDestino !== 'apeado' && tipoDestino !== 'epi') return;

  const centralVinculadoDestino = destino.armazem_central_vinculado_id == null
    ? null
    : Number(destino.armazem_central_vinculado_id);
  if (!centralVinculadoDestino || centralVinculadoDestino !== origemId) {
    throw makeStockPrepBizError(
      400,
      'Transferência inválida: este armazém APEADO/EPI não está vinculado ao armazém central de origem.',
      'TRANSFERENCIA_CENTRAL_VINCULO_INVALIDO',
      { armazem_origem_id: origemId, armazem_destino_id: destinoId }
    );
  }
}

async function subtrairQtyArmazemLocalizacaoItem(client, localizacaoId, itemId, qty, itemCodigo) {
  const sub = await client.query(
    `UPDATE armazens_localizacao_item
     SET quantidade = quantidade - $1::numeric, updated_at = CURRENT_TIMESTAMP
     WHERE localizacao_id = $2 AND item_id = $3 AND quantidade >= $1::numeric
     RETURNING quantidade`,
    [qty, localizacaoId, itemId]
  );
  if (sub.rows.length === 0) {
    throw makeStockPrepBizError(
      400,
      itemCodigo
        ? `Stock insuficiente na localização de saída para o artigo ${itemCodigo}.`
        : 'Stock insuficiente na localização de saída.',
      'STOCK_LOCALIZACAO_INSUFICIENTE',
      { item_id: itemId }
    );
  }
  const rest = Number(sub.rows[0].quantidade);
  if (rest <= 0) {
    await client.query('DELETE FROM armazens_localizacao_item WHERE localizacao_id = $1 AND item_id = $2', [
      localizacaoId,
      itemId,
    ]);
  }
}

function requisicaoTemLinhasQuantidadeTrfl(itens, bobinas) {
  const list = itens || [];
  const bob = bobinas || [];
  const itemById = new Map(list.map((ri) => [ri.item_id, ri]));
  for (const b of bob) {
    const ri = itemById.get(b.item_id);
    if (!itemTemSaidaTrflTra(ri)) continue;
    if ((Number(b.metros) || 0) > 0) return true;
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    if (itemTemSaidaTrflTra(ri)) return true;
  }
  return false;
}

/**
 * 1.ª geração de TRFL (fluxo normal central): retira de cada localização de preparação e soma em EXPEDICAO.
 * Idempotente via requisicoes.trfl_estoque_aplicado_em.
 */
async function aplicarStockTrflSePendenteNormais(client, { requisicaoId, armazemOrigemId, itens, bobinas }) {
  let doc;
  const spTrfl = `sp_trfl_rd_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let spTrflAtivo = false;
  try {
    await client.query(`SAVEPOINT ${spTrfl}`);
    spTrflAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    doc = await client.query(
      `SELECT trfl_estoque_aplicado_em FROM requisicoes WHERE id = $1 FOR UPDATE`,
      [requisicaoId]
    );
    if (spTrflAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${spTrfl}`);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (e) {
    if (spTrflAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${spTrfl}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') return;
    throw e;
  }
  if (doc.rows[0]?.trfl_estoque_aplicado_em) return;

  if (!requisicaoTemLinhasQuantidadeTrfl(itens, bobinas)) {
    await client.query(
      `UPDATE requisicoes SET trfl_estoque_aplicado_em = CURRENT_TIMESTAMP WHERE id = $1 AND trfl_estoque_aplicado_em IS NULL`,
      [requisicaoId]
    );
    return;
  }

  const expId = await resolveLocalizacaoExpedicaoId(client, armazemOrigemId);
  if (!expId) {
    throw makeStockPrepBizError(
      400,
      'Não existe localização de expedição no armazém de origem (tipo expedicao ou código EXPEDICAO).',
      'LOCALIZACAO_EXPEDICAO_INEXISTENTE'
    );
  }

  async function moverParaExpedicao(origLabel, itemId, itemCodigo, qty) {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return;
    const lab = (origLabel && String(origLabel).trim()) || '';
    if (!lab) {
      throw makeStockPrepBizError(
        400,
        `Artigo ${itemCodigo || itemId}: falta localização de origem na preparação para movimentar stock.`,
        'LOCALIZACAO_ORIGEM_PREPARACAO_EM_FALTA',
        { item_id: itemId }
      );
    }
    const origId = await resolveLocalizacaoIdPorCodigo(client, armazemOrigemId, lab);
    if (!origId) {
      throw makeStockPrepBizError(
        400,
        `A localização de saída «${lab}» não existe no armazém de origem.`,
        'LOCALIZACAO_ORIGEM_INEXISTENTE',
        { item_id: itemId }
      );
    }
    if (origId === expId) {
      throw makeStockPrepBizError(
        400,
        'A localização de saída não pode ser a mesma que a expedição.',
        'ORIGEM_IGUAL_EXPEDICAO',
        { item_id: itemId }
      );
    }
    await subtrairQtyArmazemLocalizacaoItem(client, origId, itemId, q, itemCodigo || String(itemId));
    await adicionarQtyArmazemLocalizacaoItem(client, expId, itemId, q);
  }

  const list = itens || [];
  const bob = bobinas || [];
  for (const b of bob) {
    const ri = list.find((it) => it.item_id === b.item_id) || {};
    if (!itemTemSaidaTrflTra(ri)) continue;
    await moverParaExpedicao(ri.localizacao_origem, b.item_id, ri.item_codigo || b.item_codigo, Number(b.metros) || 0);
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    if (!itemTemSaidaTrflTra(ri)) continue;
    const qty = Math.floor(quantidadePreparadaEfetiva(ri));
    await moverParaExpedicao(ri.localizacao_origem, ri.item_id, ri.item_codigo, qty);
  }

  const spTrflUp = `sp_trfl_up_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let spTrflUpAtivo = false;
  try {
    await client.query(`SAVEPOINT ${spTrflUp}`);
    spTrflUpAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    await client.query(
      `UPDATE requisicoes SET trfl_estoque_aplicado_em = CURRENT_TIMESTAMP WHERE id = $1`,
      [requisicaoId]
    );
    if (spTrflUpAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${spTrflUp}`);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (e) {
    if (spTrflUpAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${spTrflUp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') {
      /* coluna em falta: movimento já feito na BD de stock */
      return;
    }
    throw e;
  }
}

/**
 * 1.ª geração de TRA (saída do central): baixa stock na EXPEDICAO do armazém de origem.
 * Se o destino for outro armazém central, credita na localização de recebimento desse armazém.
 */
async function baixarStockTraExpedicaoSePendenteNormais(client, {
  requisicaoId,
  armazemOrigemId,
  armazemDestinoId,
  tipoDestinoNorm,
  itens,
  bobinas,
  localizacaoRecebimentoDestino,
}) {
  let doc;
  const spTraRd = `sp_tra_rd_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let spTraRdAtivo = false;
  try {
    await client.query(`SAVEPOINT ${spTraRd}`);
    spTraRdAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    doc = await client.query(
      `SELECT tra_baixa_expedicao_aplicada_em FROM requisicoes WHERE id = $1 FOR UPDATE`,
      [requisicaoId]
    );
    if (spTraRdAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${spTraRd}`);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (e) {
    if (spTraRdAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${spTraRd}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') return;
    throw e;
  }
  if (doc.rows[0]?.tra_baixa_expedicao_aplicada_em) return;

  if (!requisicaoTemLinhasQuantidadeTrfl(itens, bobinas)) {
    await client.query(
      `UPDATE requisicoes SET tra_baixa_expedicao_aplicada_em = CURRENT_TIMESTAMP WHERE id = $1 AND tra_baixa_expedicao_aplicada_em IS NULL`,
      [requisicaoId]
    );
    return;
  }

  let destLocId = null;
  if (String(tipoDestinoNorm || '').toLowerCase() === 'central' && armazemDestinoId) {
    let locRec = localizacaoRecebimentoDestino
      ? String(localizacaoRecebimentoDestino).trim()
      : null;
    if (!locRec) {
      locRec = await localizacaoArmazemPorTipoConn(client, armazemDestinoId, 'recebimento');
    }
    if (locRec) {
      destLocId = await resolveLocalizacaoIdPorCodigo(client, armazemDestinoId, locRec);
    }
    if (!destLocId) {
      throw makeStockPrepBizError(
        400,
        'Não foi possível resolver a localização de recebimento no armazém destino (central) para o stock.',
        'LOCALIZACAO_RECEB_DESTINO',
        { armazem_destino_id: armazemDestinoId }
      );
    }
  }

  const expId = await resolveLocalizacaoExpedicaoId(client, armazemOrigemId);
  if (!expId) {
    throw makeStockPrepBizError(
      400,
      'Não existe localização de expedição no armazém de origem.',
      'LOCALIZACAO_EXPEDICAO_INEXISTENTE'
    );
  }

  async function baixaLinha(itemId, itemCodigo, qty) {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return;
    await subtrairQtyArmazemLocalizacaoItem(client, expId, itemId, q, itemCodigo || String(itemId));
    if (destLocId) {
      await adicionarQtyArmazemLocalizacaoItem(client, destLocId, itemId, q);
    }
  }

  const list = itens || [];
  const bob = bobinas || [];
  for (const b of bob) {
    const ri = list.find((it) => it.item_id === b.item_id) || {};
    if (!itemTemSaidaTrflTra(ri)) continue;
    await baixaLinha(b.item_id, ri.item_codigo || b.item_codigo, Number(b.metros) || 0);
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    if (!itemTemSaidaTrflTra(ri)) continue;
    const qty = Math.floor(quantidadePreparadaEfetiva(ri));
    await baixaLinha(ri.item_id, ri.item_codigo, qty);
  }

  const spTraUp = `sp_tra_up_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  let spTraUpAtivo = false;
  try {
    await client.query(`SAVEPOINT ${spTraUp}`);
    spTraUpAtivo = true;
  } catch (spErr) {
    if (spErr.code !== '25P01') throw spErr;
  }
  try {
    await client.query(
      `UPDATE requisicoes SET tra_baixa_expedicao_aplicada_em = CURRENT_TIMESTAMP WHERE id = $1`,
      [requisicaoId]
    );
    if (spTraUpAtivo) {
      try {
        await client.query(`RELEASE SAVEPOINT ${spTraUp}`);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (e) {
    if (spTraUpAtivo) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${spTraUp}`);
      } catch (_) {
        /* ignore */
      }
    }
    if (e.code === '42703') return;
    throw e;
  }
}

async function creditarStockNaLocalizacaoArmazem(client, armazemId, itemId, itemCodigo, locLabel, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return;
  const lab = String(locLabel || '').trim();
  if (!lab) {
    throw makeStockPrepBizError(
      400,
      'Localização de destino em falta para movimento de stock.',
      'LOCALIZACAO_STOCK_EM_FALTA',
      { item_id: itemId }
    );
  }
  const locId = await resolveLocalizacaoIdPorCodigo(client, armazemId, lab);
  if (!locId) {
    throw makeStockPrepBizError(
      400,
      `A localização «${lab}» não existe no armazém.`,
      'LOCALIZACAO_STOCK_INEXISTENTE',
      { item_id: itemId }
    );
  }
  await adicionarQtyArmazemLocalizacaoItem(client, locId, itemId, q);
}

/** Atualiza `stock_serial` entre localizações do mesmo armazém central (devolução TRFL interna). */
async function moverSeriaisMesmoArmazemPorLabels(
  client,
  armazemId,
  itemId,
  itemCodigo,
  fromLabel,
  toLabel,
  serialnumbers
) {
  const sns = [...new Set((serialnumbers || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!sns.length) return;
  const from = String(fromLabel || '').trim();
  const to = String(toLabel || '').trim();
  if (!from || !to || from.toUpperCase() === to.toUpperCase()) return;
  const moved = await client.query(
    `UPDATE stock_serial
     SET localizacao = $4,
         status = 'disponivel',
         reservado_em = NULL,
         requisicao_id = NULL,
         requisicao_item_id = NULL,
         atualizado_em = CURRENT_TIMESTAMP
     WHERE item_id = $1
       AND armazem_id = $2
       AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
       AND UPPER(TRIM(serialnumber)) = ANY(
         SELECT UPPER(TRIM(u.x)) FROM unnest($5::text[]) AS u(x)
       )
       AND status IN ('disponivel', 'reservado')
     RETURNING serialnumber`,
    [itemId, armazemId, from, to, sns]
  );
  if ((moved.rows || []).length < sns.length) {
    throw makeStockPrepBizError(
      400,
      `Seriais insuficientes na origem para ${itemCodigo || itemId}.`,
      'SERIAIS_ORIGEM_INSUFICIENTES',
      { item_id: itemId, origem: from, destino: to }
    );
  }
}

async function moverStockMesmoArmazemPorLabels(client, armazemId, itemId, itemCodigo, fromLabel, toLabel, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return;
  const from = String(fromLabel || '').trim();
  const to = String(toLabel || '').trim();
  if (!from || !to) {
    throw makeStockPrepBizError(
      400,
      'Localização de origem ou destino em falta para movimento de stock.',
      'LOCALIZACAO_STOCK_EM_FALTA',
      { item_id: itemId }
    );
  }
  if (from.toUpperCase() === to.toUpperCase()) return;
  const fromId = await resolveLocalizacaoIdPorCodigo(client, armazemId, from);
  const toId = await resolveLocalizacaoIdPorCodigo(client, armazemId, to);
  if (!fromId || !toId) {
    throw makeStockPrepBizError(
      400,
      `Localização de movimento interno inexistente («${from}» → «${to}»).`,
      'LOCALIZACAO_STOCK_INEXISTENTE',
      { item_id: itemId }
    );
  }
  await subtrairQtyArmazemLocalizacaoItem(client, fromId, itemId, q, itemCodigo || String(itemId));
  await adicionarQtyArmazemLocalizacaoItem(client, toId, itemId, q);
}

async function moverStockEntreArmazensPorLabels(client, origArmId, origLabel, destArmId, destLabel, itemId, itemCodigo, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return;
  const ol = String(origLabel || '').trim();
  const dl = String(destLabel || '').trim();
  if (!ol || !dl) {
    throw makeStockPrepBizError(
      400,
      'Localização de origem ou destino em falta para transferência entre armazéns.',
      'LOCALIZACAO_STOCK_EM_FALTA',
      { item_id: itemId }
    );
  }
  const origId = await resolveLocalizacaoIdPorCodigo(client, origArmId, ol);
  const destId = await resolveLocalizacaoIdPorCodigo(client, destArmId, dl);
  if (!origId || !destId) {
    throw makeStockPrepBizError(
      400,
      `Localização inexistente na transferência entre armazéns («${ol}» → «${dl}»).`,
      'LOCALIZACAO_STOCK_INEXISTENTE',
      { item_id: itemId }
    );
  }
  await subtrairQtyArmazemLocalizacaoItem(client, origId, itemId, q, itemCodigo || String(itemId));
  await adicionarQtyArmazemLocalizacaoItem(client, destId, itemId, q);
}

async function logStockMovimentoHelper(db, {
  tipo,
  itemId,
  armazemId,
  localizacao,
  lote,
  serialnumber,
  quantidade,
  requisicaoId,
  requisicaoItemId,
  caixaId,
  usuarioId,
  payload,
}) {
  await db.query(
    `INSERT INTO stock_movimentos_auditoria
     (tipo, item_id, armazem_id, localizacao, lote, serialnumber, quantidade, requisicao_id, requisicao_item_id, caixa_id, usuario_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      tipo,
      itemId || null,
      armazemId || null,
      localizacao || null,
      lote || null,
      serialnumber || null,
      quantidade ?? null,
      requisicaoId || null,
      requisicaoItemId || null,
      caixaId || null,
      usuarioId || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

/** Liga um `stock_serial` à caixa física (`stock_caixas` + `stock_caixa_seriais`). */
async function vincularStockSerialACaixaEntrada(client, {
  itemId,
  armazemId,
  localizacao,
  stockSerialId,
  codigoCaixa,
}) {
  const cx = String(codigoCaixa || '').trim();
  if (!cx || !stockSerialId) return null;
  try {
    const caixaQ = await client.query(
      `INSERT INTO stock_caixas (codigo_caixa, item_id, armazem_id, localizacao, status, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, 'fechada', NULL)
       ON CONFLICT (codigo_caixa)
       DO UPDATE SET
         item_id = EXCLUDED.item_id,
         armazem_id = EXCLUDED.armazem_id,
         localizacao = EXCLUDED.localizacao,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id`,
      [cx, itemId, armazemId, localizacao]
    );
    const caixaId = Number(caixaQ.rows[0]?.id || 0) || null;
    if (!caixaId) return null;
    await client.query(
      `INSERT INTO stock_caixa_seriais (caixa_id, stock_serial_id)
       VALUES ($1, $2)
       ON CONFLICT (stock_serial_id)
       DO UPDATE SET caixa_id = EXCLUDED.caixa_id`,
      [caixaId, stockSerialId]
    );
    return caixaId;
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

/** S/N + caixa opcional a partir da tabela filha ou do blob `serialnumber`. */
async function seriaisComCaixaFromRequisicaoItem(client, requisicaoItemId, serialnumberBlob) {
  const rid = Number(requisicaoItemId);
  if (Number.isFinite(rid)) {
    try {
      const snRows = await client.query(
        `SELECT TRIM(serialnumber) AS sn,
                NULLIF(TRIM(codigo_caixa), '') AS codigo_caixa
         FROM requisicoes_itens_seriais
         WHERE requisicao_item_id = $1
         ORDER BY ordem, id`,
        [rid]
      );
      const rows = (snRows.rows || [])
        .map((r) => ({
          sn: String(r.sn || '').trim(),
          codigo_caixa: String(r.codigo_caixa || '').trim(),
        }))
        .filter((r) => r.sn);
      if (rows.length) return rows;
    } catch (e) {
      if (e.code === '42P01') {
        // tabela inexistente — cair para blob
      } else if (e.code === '42703') {
        const snRows = await client.query(
          `SELECT TRIM(serialnumber) AS sn
           FROM requisicoes_itens_seriais
           WHERE requisicao_item_id = $1
           ORDER BY ordem, id`,
          [rid]
        );
        const rows = (snRows.rows || [])
          .map((r) => ({
            sn: String(r.sn || '').trim(),
            codigo_caixa: '',
          }))
          .filter((r) => r.sn);
        if (rows.length) return rows;
      } else {
        throw e;
      }
    }
  }
  const blobMap = caixaPorSerialFromSerialnumberBlob(serialnumberBlob);
  return serialsNormalizadosList(serialnumberBlob).map((sn) => ({
    sn,
    codigo_caixa: blobMap.get(sn.toUpperCase()) || '',
  }));
}

/** DEV (devolução): crédito na localização de recebimento do central. */
async function aplicarStockDevolucaoEntradaRecebimento(client, { centralId, locRec, itensComFerramenta, bobinas }) {
  if (!centralId || !locRec) return;
  const list = itensComFerramenta || [];
  const bob = bobinas || [];
  let stockAplicado = false;
  for (const b of bob) {
    const metros = Number(b.metros) || 0;
    if (metros <= 0) continue;
    const ri = list.find((it) => it.item_id === b.item_id) || {};
    if (!itemTemSaidaTrflTra(ri)) continue;
    const localizacaoCadastro = locRec;
    await creditarStockNaLocalizacaoArmazem(
      client,
      centralId,
      b.item_id,
      ri.item_codigo || b.item_codigo,
      localizacaoCadastro,
      metros
    );
    stockAplicado = true;
    const loteBobina = String(b.lote || '').trim();
    if (loteBobina) {
      await client.query(
        `INSERT INTO stock_lote (item_id, armazem_id, localizacao, lote, quantidade_disponivel)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (item_id, armazem_id, localizacao, lote)
         DO UPDATE SET
           quantidade_disponivel = stock_lote.quantidade_disponivel + EXCLUDED.quantidade_disponivel,
           atualizado_em = CURRENT_TIMESTAMP`,
        [b.item_id, centralId, localizacaoCadastro, loteBobina, metros]
      );
      await logStockMovimentoHelper(client, {
        tipo: 'entrada_devolucao_lote',
        itemId: b.item_id,
        armazemId: centralId,
        localizacao: localizacaoCadastro,
        lote: loteBobina,
        quantidade: metros,
        requisicaoId: Number(ri.requisicao_id) || null,
        requisicaoItemId: Number(b.requisicao_item_id || ri.id) || null,
        usuarioId: null,
        payload: { origem: 'aplicarStockDevolucaoEntradaRecebimento' },
      });
    }
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    if (!itemTemSaidaTrflTra(ri)) continue;
    const qty = Math.floor(quantidadePreparadaEfetiva(ri));
    if (qty <= 0) continue;
    await creditarStockNaLocalizacaoArmazem(client, centralId, ri.item_id, ri.item_codigo, locRec, qty);
    stockAplicado = true;
  }

  // Rastreabilidade de S/N na entrada de devolução/recebimento:
  // além do crédito em quantidade, cada serial precisa ficar disponível no armazém central.
  for (const ri of list) {
    const tipoControlo = String(ri.tipocontrolo || '').toUpperCase();
    if (!isTipoControloSerial(tipoControlo)) continue;
    // eslint-disable-next-line no-await-in-loop
    const serialRows = await seriaisComCaixaFromRequisicaoItem(client, ri.id, ri.serialnumber);
    if (!serialRows.length) continue;
    const localizacaoCadastro = locRec;
    const seen = new Set();
    for (const { sn, codigo_caixa: codigoCaixa } of serialRows) {
      const key = `${ri.item_id}::${sn}`.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      stockAplicado = true;
      // eslint-disable-next-line no-await-in-loop
      const upsert = await client.query(
        `INSERT INTO stock_serial (item_id, armazem_id, localizacao, serialnumber, lote, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item_id, serialnumber)
         DO UPDATE SET
           armazem_id = EXCLUDED.armazem_id,
           localizacao = EXCLUDED.localizacao,
           lote = COALESCE(NULLIF(EXCLUDED.lote, ''), stock_serial.lote),
           status = EXCLUDED.status,
           requisicao_id = NULL,
           requisicao_item_id = NULL,
           reservado_em = NULL,
           consumido_em = NULL,
           atualizado_em = CURRENT_TIMESTAMP
         RETURNING id`,
        [ri.item_id, centralId, localizacaoCadastro, sn, ri.lote || null, STOCK_STATUS.DISPONIVEL]
      );
      const stockSerialId = Number(upsert.rows[0]?.id || 0) || null;
      let caixaId = null;
      if (codigoCaixa && stockSerialId) {
        // eslint-disable-next-line no-await-in-loop
        caixaId = await vincularStockSerialACaixaEntrada(client, {
          itemId: ri.item_id,
          armazemId: centralId,
          localizacao: localizacaoCadastro,
          stockSerialId,
          codigoCaixa,
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await logStockMovimentoHelper(client, {
        tipo: 'entrada_devolucao_serial',
        itemId: ri.item_id,
        armazemId: centralId,
        localizacao: localizacaoCadastro,
        lote: ri.lote || null,
        serialnumber: sn,
        quantidade: 1,
        requisicaoId: Number(ri.requisicao_id) || null,
        requisicaoItemId: Number(ri.id) || null,
        caixaId,
        usuarioId: null,
        payload: {
          origem: 'aplicarStockDevolucaoEntradaRecebimento',
          codigo_caixa: codigoCaixa || null,
        },
      });
    }
  }
  if (!stockAplicado) return;
  try {
    await client.query(
      `UPDATE armazens
       SET monitor_rececao_oculto_teste = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND monitor_rececao_oculto_teste = true`,
      [centralId]
    );
  } catch (e) {
    if (e?.code !== '42703') throw e;
  }
}

/**
 * Garante que cada linha de `requisicoes_itens` traz em `serialnumber` os S/N de `requisicoes_itens_seriais`
 * (a preparação de recebimento costuma persistir só na tabela filha).
 */
async function mergeRequisicaoItensSeriaisFromChildTable(client, itensRows) {
  const rows = Array.isArray(itensRows) ? itensRows : [];
  const ids = rows.map((r) => Number(r.id)).filter(Number.isFinite);
  if (!ids.length) return rows;
  let seriaisQ;
  try {
    seriaisQ = await client.query(
      `SELECT requisicao_item_id, TRIM(serialnumber) AS sn
       FROM requisicoes_itens_seriais
       WHERE requisicao_item_id = ANY($1::int[])
       ORDER BY requisicao_item_id, ordem, id`,
      [ids]
    );
  } catch (e) {
    if (e.code === '42P01') return rows;
    throw e;
  }
  const byRi = new Map();
  for (const r of seriaisQ.rows || []) {
    const rid = Number(r.requisicao_item_id);
    const sn = String(r.sn || '').trim();
    if (!Number.isFinite(rid) || !sn) continue;
    if (!byRi.has(rid)) byRi.set(rid, []);
    byRi.get(rid).push(sn);
  }
  return rows.map((ri) => {
    const fromChild = byRi.get(Number(ri.id)) || [];
    if (fromChild.length) {
      return { ...ri, serialnumber: fromChild.join('\n') };
    }
    const fromBlob = serialsNormalizadosList(ri.serialnumber);
    if (!fromBlob.length) return ri;
    return { ...ri, serialnumber: fromBlob.join('\n') };
  });
}

/** TRFL interna devolução: recebimento → FERR / zona normal (mesmo central). */
async function aplicarStockTrflDevolucaoInterno(client, {
  centralId,
  locRec,
  localizacaoFERR,
  localizacaoNormal,
  itensComFerramenta,
  bobinas,
}) {
  if (!centralId || !locRec) return;
  const list = itensComFerramenta || [];
  const bob = bobinas || [];
  const apeadosQtyByItemId = new Map(
    list.map((it) => [Number(it.item_id), Math.max(0, parseInt(it.quantidade_apeados ?? 0, 10) || 0)])
  );
  const apeadosCountByItemId = new Map();

  for (const b of bob) {
    const ri = list.find((it) => it.item_id === b.item_id) || {};
    if (!itemTemSaidaTrflTra(ri)) continue;
    const itemId = Number(b.item_id);
    const apeadosQty = apeadosQtyByItemId.get(itemId) ?? 0;
    const hasMarcacaoApeado = bob.some((bb) => Number(bb?.item_id) === itemId && Boolean(bb?.apeado));
    let destLoc = localizacaoNormal;
    if (hasMarcacaoApeado) {
      destLoc = Boolean(b?.apeado) ? localizacaoFERR : localizacaoNormal;
    } else {
      const prevCount = apeadosCountByItemId.get(itemId) ?? 0;
      const nextCount = prevCount + 1;
      apeadosCountByItemId.set(itemId, nextCount);
      destLoc = nextCount <= apeadosQty ? localizacaoFERR : localizacaoNormal;
    }
    const metros = Number(b.metros) || 0;
    if (metros <= 0) continue;
    await moverStockMesmoArmazemPorLabels(
      client,
      centralId,
      itemId,
      ri.item_codigo || b.item_codigo,
      locRec,
      destLoc,
      metros
    );
  }

  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((bb) => bb.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    if (!itemTemSaidaTrflTra(ri)) continue;
    const qty = Math.floor(quantidadePreparadaEfetiva(ri));
    const apeadosQty = Math.max(0, Math.min(qty, parseInt(ri.quantidade_apeados ?? 0, 10) || 0));
    const normalQty = Math.max(0, qty - apeadosQty);
    if (isTipoControloSerial(tipoControlo)) {
      const serialsMeta = await serialsComApeadoRequisicaoItem(client, Number(ri.id), ri);
      let apeadosSns = serialsMeta.filter((x) => x.apeado).map((x) => x.sn).slice(0, apeadosQty);
      let normalSns = serialsMeta.filter((x) => !x.apeado).map((x) => x.sn).slice(0, normalQty);
      if (apeadosQty > 0 && apeadosSns.length < apeadosQty) {
        const restantes = serialsMeta
          .map((x) => x.sn)
          .filter((sn) => !normalSns.includes(sn) && !apeadosSns.includes(sn));
        apeadosSns = [...apeadosSns, ...restantes].slice(0, apeadosQty);
      }
      if (normalQty > 0 && normalSns.length < normalQty) {
        const restantes = serialsMeta
          .map((x) => x.sn)
          .filter((sn) => !apeadosSns.includes(sn) && !normalSns.includes(sn));
        normalSns = [...normalSns, ...restantes].slice(0, normalQty);
      }
      if (apeadosQty > 0) {
        if (apeadosSns.length > 0) {
          await moverSeriaisMesmoArmazemPorLabels(
            client,
            centralId,
            ri.item_id,
            ri.item_codigo,
            locRec,
            localizacaoFERR,
            apeadosSns
          );
        }
        await moverStockMesmoArmazemPorLabels(
          client,
          centralId,
          ri.item_id,
          ri.item_codigo,
          locRec,
          localizacaoFERR,
          apeadosQty
        );
      }
      if (normalQty > 0) {
        if (normalSns.length > 0) {
          await moverSeriaisMesmoArmazemPorLabels(
            client,
            centralId,
            ri.item_id,
            ri.item_codigo,
            locRec,
            localizacaoNormal,
            normalSns
          );
        }
        await moverStockMesmoArmazemPorLabels(
          client,
          centralId,
          ri.item_id,
          ri.item_codigo,
          locRec,
          localizacaoNormal,
          normalQty
        );
      }
      continue;
    }
    if (apeadosQty > 0) {
      await moverStockMesmoArmazemPorLabels(client, centralId, ri.item_id, ri.item_codigo, locRec, localizacaoFERR, apeadosQty);
    }
    if (normalQty > 0) {
      await moverStockMesmoArmazemPorLabels(client, centralId, ri.item_id, ri.item_codigo, locRec, localizacaoNormal, normalQty);
    }
  }
}

/** TRFL pendente armazenagem: remanescente da origem lógica de stock → localização escolhida. */
async function aplicarStockTrflPendenteDevolucao(client, {
  centralId,
  locOrigemMovimento,
  localizacaoDefault,
  itemLocalizacoes,
  itens,
  bobinasByRequisicaoItemId,
}) {
  if (!centralId || !locOrigemMovimento) return;
  const itemLocalizacoesObj = itemLocalizacoes || {};

  for (const it of itens || []) {
    const totalQty = parseInt(it.quantidade_preparada ?? it.quantidade, 10) || 0;
    const apeadosQty = parseInt(it.quantidade_apeados ?? 0, 10) || 0;
    const remQty = Math.max(0, totalQty - apeadosQty);
    if (remQty <= 0) continue;
    const keyA = String(it.id);
    const keyB = String(it.item_id);
    const locByItem = String(itemLocalizacoesObj[keyA] || itemLocalizacoesObj[keyB] || '').trim();
    const localizacaoDestino = locByItem || localizacaoDefault;
    if (!localizacaoDestino) continue;

    const tipoControlo = String(it.tipocontrolo || '').toUpperCase();

    if (tipoControlo === 'LOTE') {
      const bobinas = bobinasByRequisicaoItemId.get(Number(it.id)) || [];
      const bobinasApeadas = bobinas.filter((b) => Boolean(b?.apeado));
      const bobinasNormais = bobinas.filter((b) => !Boolean(b?.apeado));
      const selecionadas = (bobinasNormais.length > 0 || bobinasApeadas.length > 0)
        ? bobinasNormais.slice(0, remQty)
        : bobinas.slice(apeadosQty, apeadosQty + remQty);
      for (const b of selecionadas) {
        const metros = Number(b.metros) || 0;
        if (metros <= 0) continue;
        await moverStockMesmoArmazemPorLabels(
          client,
          centralId,
          it.item_id,
          it.item_codigo || b.item_codigo,
          locOrigemMovimento,
          localizacaoDestino,
          metros
        );
      }
    } else if (isTipoControloSerial(tipoControlo)) {
      const serialsMeta = await serialsComApeadoRequisicaoItem(client, Number(it.id), it);
      const serialsNormais = serialsMeta.filter((x) => !x.apeado).map((x) => x.sn);
      const selecionados = serialsNormais.slice(0, remQty);
      if (selecionados.length > 0) {
        for (const sn of selecionados) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO stock_serial (item_id, armazem_id, localizacao, serialnumber, lote, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (item_id, serialnumber)
             DO UPDATE SET
               armazem_id = EXCLUDED.armazem_id,
               localizacao = EXCLUDED.localizacao,
               lote = COALESCE(NULLIF(EXCLUDED.lote, ''), stock_serial.lote),
               status = EXCLUDED.status,
               requisicao_id = NULL,
               requisicao_item_id = NULL,
               reservado_em = NULL,
               consumido_em = NULL,
               atualizado_em = CURRENT_TIMESTAMP`,
            [it.item_id, centralId, localizacaoDestino, sn, it.lote || null, STOCK_STATUS.DISPONIVEL]
          );
        }
      } else {
        await moverStockMesmoArmazemPorLabels(
          client,
          centralId,
          it.item_id,
          it.item_codigo,
          locOrigemMovimento,
          localizacaoDestino,
          remQty
        );
      }
    } else {
      await moverStockMesmoArmazemPorLabels(
        client,
        centralId,
        it.item_id,
        it.item_codigo,
        locOrigemMovimento,
        localizacaoDestino,
        remQty
      );
    }
  }
}

/** TRA APEADOS: saída na localização de origem (FERR após TRFL interna, senão recebimento) → recebimento do armazém APEADO. */
async function aplicarStockTraApeadosDevolucao(client, {
  centralId,
  locOrigemCentral,
  destinoApeadoId,
  locRecApeado,
  apeadosItens,
  bobinasByRequisicaoItemId,
}) {
  if (!centralId || !destinoApeadoId || !locRecApeado || !locOrigemCentral) return;

  for (const it of apeadosItens || []) {
    const apeadosQty = parseInt(it.quantidade_apeados ?? 0, 10) || 0;
    if (apeadosQty <= 0) continue;
    const tipoControlo = String(it.tipocontrolo || '').toUpperCase();
    if (tipoControlo === 'LOTE') {
      const bobinas = bobinasByRequisicaoItemId.get(Number(it.id)) || [];
      const bobinasApeadas = bobinas.filter((b) => Boolean(b?.apeado));
      const selecionadas = bobinasApeadas.length > 0 ? bobinasApeadas.slice(0, apeadosQty) : bobinas.slice(0, apeadosQty);
      for (const b of selecionadas) {
        const metros = Number(b.metros) || 0;
        if (metros <= 0) continue;
        await moverStockEntreArmazensPorLabels(
          client,
          centralId,
          locOrigemCentral,
          destinoApeadoId,
          locRecApeado,
          it.item_id,
          it.item_codigo || b.item_codigo,
          metros
        );
      }
    } else if (isTipoControloSerial(tipoControlo)) {
      const serialsMeta = await serialsComApeadoRequisicaoItem(client, Number(it.id), it);
      const serialsApeados = serialsMeta.filter((x) => x.apeado).map((x) => x.sn);
      const selecionados = serialsApeados.slice(0, apeadosQty);
      if (selecionados.length > 0) {
        for (const sn of selecionados) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO stock_serial (item_id, armazem_id, localizacao, serialnumber, lote, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (item_id, serialnumber)
             DO UPDATE SET
               armazem_id = EXCLUDED.armazem_id,
               localizacao = EXCLUDED.localizacao,
               lote = COALESCE(NULLIF(EXCLUDED.lote, ''), stock_serial.lote),
               status = EXCLUDED.status,
               requisicao_id = NULL,
               requisicao_item_id = NULL,
               reservado_em = NULL,
               consumido_em = NULL,
               atualizado_em = CURRENT_TIMESTAMP`,
            [it.item_id, destinoApeadoId, locRecApeado, sn, it.lote || null, STOCK_STATUS.DISPONIVEL]
          );
        }
      } else {
        await moverStockEntreArmazensPorLabels(
          client,
          centralId,
          locOrigemCentral,
          destinoApeadoId,
          locRecApeado,
          it.item_id,
          it.item_codigo,
          apeadosQty
        );
      }
    } else {
      await moverStockEntreArmazensPorLabels(
        client,
        centralId,
        locOrigemCentral,
        destinoApeadoId,
        locRecApeado,
        it.item_id,
        it.item_codigo,
        apeadosQty
      );
    }
  }
}

function createRequisicoesRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    authenticateToken,
    requisicaoScopeMiddleware,
    requisicaoArmazemOrigemAcessoPermitido,
    assertIdsRequisicoesPermitidas,
    excelUploadRequisicoes,
    armazemMovimentacaoInternaTableExists,
  } = deps;

  const router = express.Router();
  const stockImportUpload = multer({ storage: multer.memoryStorage() });

  const RECEBIMENTO_TRANSFERENCIA_MARKER = 'RECEBIMENTO_TRANSFERENCIA_V1';
  const DEV_APEADOS_STOCK_PENDENTE_MARKER = 'DEV_APEADOS_STOCK_PENDENTE';
  const DEV_TRFL_PENDENTE_STOCK_MARKER = 'DEV_TRFL_PENDENTE_STOCK_PENDENTE';
  const DEV_RECEBIMENTO_STOCK_APLICADO_MARKER = 'DEV_RECEBIMENTO_STOCK_APLICADO';
  const TRFL_PENDENTE_LOC_TAG = 'TRFL_PENDENTE_LOC';
  const RECEBIMENTO_MONITOR_CLEAR_TEST_MARKER = 'RECEBIMENTO_MONITOR_CLEAR_TEST';

  function hasRecebimentoMarker(requisicao) {
    const obs = String(requisicao?.observacoes || '');
    return obs.toUpperCase().startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
  }

  function getAutoFromReqId(requisicao) {
    const m = /AUTO_FROM_REQ:\s*(\d+)/i.exec(String(requisicao?.observacoes || ''));
    const id = m ? parseInt(String(m[1] || ''), 10) : NaN;
    return Number.isFinite(id) ? id : null;
  }

  function markerFlagAtivo(obsRaw, markerKey) {
    return new RegExp(`${markerKey}:\\s*1`, 'i').test(String(obsRaw || ''));
  }

  function upsertMarkerFlag(obsRaw, markerKey, flag) {
    const obs = String(obsRaw || '').trim();
    const next = `${markerKey}:${flag ? 1 : 0}`;
    if (!obs) return next;
    const re = new RegExp(`${markerKey}:\\s*[01]`, 'i');
    if (re.test(obs)) return obs.replace(re, next);
    return `${obs} | ${next}`;
  }

  function upsertTaggedValue(obsRaw, tagKey, valueRaw) {
    const obs = String(obsRaw || '').trim();
    const value = String(valueRaw || '').trim();
    if (!value) return obs;
    const escapedTag = String(tagKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = `${tagKey}:${value}`;
    const re = new RegExp(`(?:^|\\|)\\s*${escapedTag}:\\s*[^|]*`, 'i');
    if (!obs) return token;
    if (re.test(obs)) {
      return obs.replace(re, (m) => {
        const hasPipePrefix = /^\s*\|/.test(m);
        return `${hasPipePrefix ? ' | ' : ''}${token}`;
      }).trim();
    }
    return `${obs} | ${token}`;
  }

  function getTaggedValue(obsRaw, tagKey) {
    const escapedTag = String(tagKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\|)\\s*${escapedTag}:\\s*([^|]+)`, 'i').exec(String(obsRaw || ''));
    return String(m?.[1] || '').trim();
  }

  async function extractPdfText(buffer) {
    // Compatível com API nova (classe PDFParse) e legado (função default).
    if (pdfParseLib && typeof pdfParseLib.PDFParse === 'function') {
      const parser = new pdfParseLib.PDFParse({ data: buffer });
      try {
        const out = await parser.getText();
        return String(out?.text || '');
      } finally {
        try {
          await parser.destroy();
        } catch (_) {}
      }
    }
    const fn = typeof pdfParseLib === 'function' ? pdfParseLib : pdfParseLib?.default;
    if (typeof fn === 'function') {
      const out = await fn(buffer);
      return String(out?.text || '');
    }
    throw new Error('Biblioteca de PDF sem parser compatível.');
  }

  function getRecebimentoDestinoCodigo(requisicao) {
    // Nesta implementação, para garantir scope por "armazém de origem" (requisicoes_armazem_origem_ids),
    // criamos a requisição com:
    // - requisicoes.armazem_origem_id = armazém destino (onde o utilizador vai receber)
    // - requisicoes.armazem_id = armazém origem (de onde vêm os bens)
    // Então:
    // - "destino" (recebimento) = requisicao.armazem_origem_codigo
    // - "origem" (envio) = requisicao.armazem_destino_codigo
    return {
      destino: requisicao?.armazem_origem_codigo || '',
      origem: requisicao?.armazem_destino_codigo || '',
    };
  }

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

  async function logStockMovimento(opts) {
    return logStockMovimentoAuditoria({ ...opts, db: opts.db || pool });
  }

  async function liberarReservasLotePorRequisicaoItem(db, opts) {
    return liberarReservasLotePorRequisicaoItemModule(db, opts);
  }

  async function liberarReservasLotePorRequisicao(db, opts) {
    return liberarReservasLotePorRequisicaoModule(db, opts);
  }

const LOCALIZACAO_EXPEDICAO_FALLBACK = 'EXPEDICAO.E';
const LOCALIZACAO_RECEBIMENTO_FALLBACK = 'RECEBIMENTO.E';

async function buildRecebimentoMercadoriaReporteRows(poolConn, requisicao) {
  const locRecebimentoDestino =
    (await localizacaoArmazemPorTipoConn(poolConn, requisicao.armazem_origem_id, 'recebimento')) ||
    LOCALIZACAO_RECEBIMENTO_FALLBACK;
  const columns = ['COD', 'DESCRIÇÃO', 'QTD', 'S/N', 'LOTE', 'Localização destino'];
  const rows = (requisicao.itens || []).map((it) => ({
    COD: String(it.item_codigo || '').trim(),
    'DESCRIÇÃO': String(it.item_descricao || '').trim(),
    QTD: Number(it.quantidade_preparada ?? it.quantidade ?? 0) || 0,
    'S/N': String(it.serialnumber || '').trim(),
    LOTE: String(it.lote || '').trim(),
    'Localização destino': String(locRecebimentoDestino || '').trim(),
  }));
  return { columns, rows };
}

async function buildRecebimentoMercadoriaReporteRowsDetalhado(poolConn, requisicao) {
  const locRecebimentoDestino =
    (await localizacaoArmazemPorTipoConn(poolConn, requisicao.armazem_origem_id, 'recebimento')) ||
    LOCALIZACAO_RECEBIMENTO_FALLBACK;
  const columns = ['COD', 'DESCRIÇÃO', 'QTD', 'S/N', 'LOTE', 'Localização destino'];
  const itens = Array.isArray(requisicao?.itens) ? requisicao.itens : [];
  if (!itens.length) return { columns, rows: [] };

  const reqItemIds = itens.map((it) => Number(it.id)).filter((id) => Number.isFinite(id));
  const bobinasByReqItemId = new Map();
  if (reqItemIds.length > 0) {
    try {
      const qb = await poolConn.query(
        `SELECT requisicao_item_id, lote, serialnumber, metros
         FROM requisicoes_itens_bobinas
         WHERE requisicao_item_id = ANY($1::int[])`,
        [reqItemIds]
      );
      for (const b of qb.rows || []) {
        const rid = Number(b.requisicao_item_id);
        if (!Number.isFinite(rid)) continue;
        if (!bobinasByReqItemId.has(rid)) bobinasByReqItemId.set(rid, []);
        bobinasByReqItemId.get(rid).push(b);
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
  }

  const rows = [];
  for (const it of itens) {
    const cod = String(it.item_codigo || '').trim();
    const desc = String(it.item_descricao || '').trim();
    const tipoControlo = String(it.tipocontrolo || '').trim().toUpperCase();
    const reqItemId = Number(it.id);
    const bobinas = Number.isFinite(reqItemId) ? (bobinasByReqItemId.get(reqItemId) || []) : [];

    if (isTipoControloSerial(tipoControlo)) {
      let serials = [];
      if (Number.isFinite(reqItemId)) {
        // eslint-disable-next-line no-await-in-loop
        serials = await serialsRecolhidosRequisicaoItem(poolConn, reqItemId, it);
      }
      if (!serials.length) serials = serialsNormalizadosList(it.serialnumber);
      if (serials.length) {
        for (const sn of serials) {
          rows.push({
            COD: cod,
            'DESCRIÇÃO': desc,
            QTD: 1,
            'S/N': String(sn || '').trim(),
            LOTE: String(it.lote || '').trim(),
            'Localização destino': String(locRecebimentoDestino || '').trim(),
          });
        }
        continue;
      }
    }

    if (tipoControlo === 'LOTE' && bobinas.length) {
      for (const b of bobinas) {
        const metros = Number(b.metros) || 0;
        if (metros <= 0) continue;
        rows.push({
          COD: cod,
          'DESCRIÇÃO': desc,
          QTD: metros,
          'S/N': String(b.serialnumber || '').trim(),
          LOTE: String(b.lote || it.lote || '').trim(),
          'Localização destino': String(locRecebimentoDestino || '').trim(),
        });
      }
      continue;
    }

    rows.push({
      COD: cod,
      'DESCRIÇÃO': desc,
      QTD: Number(it.quantidade_preparada ?? it.quantidade ?? 0) || 0,
      'S/N': String(it.serialnumber || '').trim(),
      LOTE: String(it.lote || '').trim(),
      'Localização destino': String(locRecebimentoDestino || '').trim(),
    });
  }
  return { columns, rows };
}

// Helper: gera ficheiro de reporte formatado no template
// (Artigo, Descrição, Quantidade, ORIGEM, S/N, LOTE, DESTINO[, Observações])
// ou, com opts.recebimentoMercadoria: COD, DESCRIÇÃO, QTD, S/N, LOTE, Localização destino
async function buildExcelReporte(rows, res, filename, opts = {}) {
  const includeObservacoes = Boolean(opts.includeObservacoes);
  const recebimentoMercadoria = Boolean(opts.recebimentoMercadoria);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Reporte');

  let baseColumns;
  if (recebimentoMercadoria) {
    baseColumns = [
      { header: 'COD', key: 'COD', minWidth: 10, maxWidth: 22 },
      { header: 'DESCRIÇÃO', key: 'DESCRIÇÃO', minWidth: 18, maxWidth: 70 },
      { header: 'QTD', key: 'QTD', minWidth: 8, maxWidth: 14 },
      { header: 'S/N', key: 'S/N', minWidth: 8, maxWidth: 20 },
      { header: 'LOTE', key: 'LOTE', minWidth: 10, maxWidth: 36 },
      { header: 'Localização destino', key: 'Localização destino', minWidth: 14, maxWidth: 28 },
    ];
  } else {
    baseColumns = [
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
  }

  const emptyRow = recebimentoMercadoria
    ? { COD: '', 'DESCRIÇÃO': '', QTD: '', 'S/N': '', LOTE: '', 'Localização destino': '' }
    : { Artigo: '', 'Descrição': '', Quantidade: '', ORIGEM: '', 'S/N': '', LOTE: '', DESTINO: '', 'Observações': '' };

  const safeRows = rows.length ? rows : [emptyRow];

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
      const colKey = baseColumns[colNumber - 1]?.key;
      const leftAlign =
        colKey === 'Descrição' ||
        colKey === 'DESCRIÇÃO' ||
        colKey === 'Observações' ||
        colKey === 'Localização destino' ||
        (!recebimentoMercadoria && includeObservacoes && colNumber === baseColumns.length);
      cell.alignment = {
        vertical: 'middle',
        horizontal: leftAlign ? 'left' : 'center',
        wrapText: leftAlign
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

/** Mapa S/N (maiúsculas) → caixa a partir de texto multilinha `sn\\tcaixa` ou `sn|caixa` (ex.: coluna requisicoes_itens.serialnumber). */

function caixaPorSerialFromSerialnumberBlob(blob) {
  const m = new Map();
  for (const line of String(blob || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const { sn, caixa } = serialLimpoDeLinhaComCaixa(line);
    if (sn) m.set(sn.toUpperCase(), caixa || '');
  }
  return m;
}

function mergeSeriaisDetalheComBlobRi(blob, det, arr) {
  const bySn = caixaPorSerialFromSerialnumberBlob(blob);
  if (bySn.size === 0) return det;
  return det.map((d, i) => {
    if (String(d.codigo_caixa || '').trim()) return d;
    const sn = String(d.serialnumber || arr[i] || '').trim();
    const cx = bySn.get(sn.toUpperCase());
    return cx ? { ...d, codigo_caixa: cx } : d;
  });
}

/** Anexa `seriais: string[]`, `seriais_detalhe` (S/N + caixa opcional) e reconstrói `serialnumber` (join \\n). */
async function attachSeriaisToRequisicaoItens(poolConn, itens) {
  if (!Array.isArray(itens) || itens.length === 0) return;
  const ids = itens.map((it) => it.id).filter((id) => Number.isFinite(Number(id)));
  if (!ids.length) return;
  try {
    let sr;
    try {
      sr = await poolConn.query(
        `SELECT requisicao_item_id, serialnumber, COALESCE(apeado, false) AS apeado,
                NULLIF(TRIM(COALESCE(codigo_caixa, '')), '') AS codigo_caixa
         FROM requisicoes_itens_seriais
         WHERE requisicao_item_id = ANY($1::int[])
         ORDER BY requisicao_item_id, ordem, id`,
        [ids]
      );
    } catch (eCol) {
      if (eCol.code !== '42703' && eCol.code !== '42P01') throw eCol;
      try {
        sr = await poolConn.query(
          `SELECT requisicao_item_id, serialnumber, COALESCE(apeado, false) AS apeado
           FROM requisicoes_itens_seriais
           WHERE requisicao_item_id = ANY($1::int[])
           ORDER BY requisicao_item_id, ordem, id`,
          [ids]
        );
      } catch (e2) {
        if (e2.code !== '42703' && e2.code !== '42P01') throw e2;
        try {
          sr = await poolConn.query(
            `SELECT requisicao_item_id, serialnumber, ordem, id
             FROM requisicoes_itens_seriais
             WHERE requisicao_item_id = ANY($1::int[])
             ORDER BY requisicao_item_id, ordem, id`,
            [ids]
          );
        } catch (e3) {
          if (e3.code !== '42P01') throw e3;
          sr = { rows: [] };
        }
      }
    }
    const map = new Map();
    const detMap = new Map();
    const apeadosMap = new Map();
    for (const row of sr.rows || []) {
      const rid = row.requisicao_item_id;
      const sn = String(row.serialnumber || '').trim();
      if (!sn) continue;
      if (!map.has(rid)) map.set(rid, []);
      if (!detMap.has(rid)) detMap.set(rid, []);
      map.get(rid).push(sn);
      const cx =
        row.codigo_caixa != null && String(row.codigo_caixa).trim() !== ''
          ? String(row.codigo_caixa).trim()
          : '';
      detMap.get(rid).push({ serialnumber: sn, codigo_caixa: cx });
      if (Boolean(row.apeado)) {
        if (!apeadosMap.has(rid)) apeadosMap.set(rid, []);
        apeadosMap.get(rid).push(sn);
      }
    }
    for (const it of itens) {
      const arr = map.get(it.id);
      let det = detMap.get(it.id);
      if (arr && det && det.length) {
        const allCxEmpty = det.every((d) => !String(d.codigo_caixa || '').trim());
        const blobRi = it.serialnumber;
        if (allCxEmpty && blobRi && /[\t|]/.test(String(blobRi))) {
          det = mergeSeriaisDetalheComBlobRi(blobRi, det, arr);
          detMap.set(it.id, det);
        }
      }
    }
    for (const it of itens) {
      const arr = map.get(it.id);
      const det = detMap.get(it.id);
      if (arr && arr.length) {
        it.seriais = arr;
        const d = det && det.length ? det : arr.map((s) => ({ serialnumber: s, codigo_caixa: '' }));
        it.seriais_detalhe = d;
        const lines = arr.map((sn, i) => {
          const cx = d[i] ? String(d[i].codigo_caixa || '').trim() : '';
          return cx ? `${sn}\t${cx}` : sn;
        });
        it.serialnumber = lines.join('\n');
      } else {
        it.seriais = null;
        it.seriais_detalhe = null;
      }
      it.serials_apeados = apeadosMap.get(it.id) || [];
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
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
  await attachSeriaisToRequisicaoItens(pool, requisicao.itens);
  return requisicao;
}

function isDestinoEPI(requisicao) {
  const codigo = String(requisicao?.armazem_destino_codigo || '').toUpperCase();
  const descricao = String(requisicao?.armazem_destino_descricao || '').toUpperCase();
  const tipo = String(requisicao?.armazem_destino_tipo || '').toLowerCase();
  return tipo === 'epi' || codigo.includes('EPI') || descricao.includes('EPI');
}

/** Entrega para EPI ou devolução EPI → central (colaborador nas observações). */
function requisicaoComColaboradorEpi(requisicao) {
  if (isDestinoEPI(requisicao)) return true;
  return isFluxoDevolucaoEpiCentral(
    requisicao?.armazem_origem_tipo,
    requisicao?.armazem_destino_tipo
  );
}

/** Coluna Observações no Clog / lista de movimentos: só nome e nº do colaborador (import EPI), sem declaração nem resto. */
function observacoesClogEpiSomenteColaborador(obsRaw) {
  const s = String(obsRaw || '').trim();
  if (!s) return '';
  const iDecl = s.search(/\bDeclaração\s*:/i);
  const semDeclaracao = iDecl >= 0 ? s.slice(0, iDecl).trim() : s;
  const parts = semDeclaracao.split('|').map((p) => p.trim()).filter(Boolean);
  const colabParts = parts.filter(
    (p) => /^colaborador\s*:/i.test(p) || /^nr\.\s*colab\.?\s*:/i.test(p)
  );
  return colabParts.join(' | ');
}

function observacoesClogEpiCodigoNome(obsRaw) {
  const s = String(obsRaw || '').trim();
  if (!s) return '';
  const nomeMatch = s.match(/colaborador\s*:\s*([^|]+)/i);
  const numeroMatch = s.match(/nr\.\s*colab\.?\s*:\s*([^|]+)/i);
  const nome = String(nomeMatch?.[1] || '').trim();
  const numero = String(numeroMatch?.[1] || '').trim();
  if (numero && nome) return `${numero}-${nome}`;
  return numero || nome || '';
}

function observacoesTemColaboradorEpi(obsRaw) {
  const s = String(obsRaw || '');
  return /(?:^|\|)\s*colaborador\s*:/i.test(s) && /(?:^|\|)\s*nr\.?\s*colab\.?\s*:/i.test(s);
}

/** Coluna Observações no reporte EPI (modal / XLSX): só "nº - nome" extraído do texto da requisição. */
function observacoesReporteEpiColaborador(obsRaw) {
  const s = String(obsRaw || '').trim();
  if (!s) return '';
  const nomeMatch = s.match(/colaborador\s*:\s*([^|]+)/i);
  const numeroMatch = s.match(/nr\.\s*colab\.?\s*:\s*([^|]+)/i);
  const nome = String(nomeMatch?.[1] || '').trim();
  const numero = String(numeroMatch?.[1] || '').trim();
  if (numero && nome) return `${numero} - ${nome}`;
  if (numero) return numero;
  if (nome) return nome;
  return '';
}

function labelArmazem(codigo, descricao) {
  const cod = String(codigo || '').trim();
  const desc = String(descricao || '').trim();
  if (cod && desc) return `${cod} - ${desc}`;
  return cod || desc || '';
}

function formatarNumeroTraDev(valorRaw, prefixoPadrao) {
  const s = String(valorRaw || '').trim();
  if (!s) return '';
  const now = new Date();
  const anoAtual = String(now.getFullYear());
  const prefixo = String(prefixoPadrao || '').trim().toUpperCase() || 'TRA';

  const mComPrefixo = s.match(/^(TRA|DEV)\s*(\d+)(?:\s*\/\s*(\d{4}))?$/i);
  if (mComPrefixo) {
    const p = String(mComPrefixo[1] || prefixo).toUpperCase();
    const numero = String(mComPrefixo[2] || '').trim();
    const ano = String(mComPrefixo[3] || anoAtual).trim();
    return `${p} ${numero}/${ano}`;
  }

  const mNumeroAno = s.match(/^(\d+)\s*\/\s*(\d{4})$/);
  if (mNumeroAno) {
    const numero = String(mNumeroAno[1] || '').trim();
    const ano = String(mNumeroAno[2] || '').trim();
    return `${prefixo} ${numero}/${ano}`;
  }

  const mSomenteNumero = s.match(/^(\d+)$/);
  if (mSomenteNumero) {
    const numero = String(mSomenteNumero[1] || '').trim();
    return `${prefixo} ${numero}/${anoAtual}`;
  }

  return s;
}

function formatarNumeroTraApeados(valorRaw) {
  const base = formatarNumeroTraDev(valorRaw, 'TRA');
  const m = String(base || '').trim().match(/^(TRA|DEV)\s+(.+)$/i);
  if (!m) return base;
  return `TRA ${String(m[2] || '').trim()}`;
}

async function normalizarObservacoesConsultaMovimentos(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return [];
  const armazemIds = [
    ...new Set(
      list
        .flatMap((row) => [Number(row?.armazem_origem_id), Number(row?.armazem_id)])
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const armazemById = new Map();
  if (armazemIds.length > 0) {
    const armRes = await pool.query(
      `SELECT id, codigo, descricao
       FROM armazens
       WHERE id = ANY($1::int[])`,
      [armazemIds]
    );
    for (const arm of armRes.rows || []) {
      armazemById.set(Number(arm.id), labelArmazem(arm.codigo, arm.descricao));
    }
  }
  return list.map((row) => {
    const tipo = String(row?.['Tipo de Movimento'] || '').trim().toLowerCase();
    const destinoTipo = String(row?.armazem_destino_tipo || '').trim().toLowerCase();
    const origemLabel = armazemById.get(Number(row?.armazem_origem_id)) || '';
    const destinoLabel = armazemById.get(Number(row?.armazem_id)) || '';
    const rawObs = String(row?.Observações || '').trim();
    let obs = '';
    if (tipo === 'transf. apeado') {
      obs = '';
    } else if (tipo === 'transferencia') {
      obs = origemLabel && destinoLabel ? `${origemLabel} > ${destinoLabel}` : '';
    } else if (tipo === 'saida de armazem') {
      const isEpi =
        destinoTipo === 'epi' ||
        String(row?.['Novo Armazém'] || '').toUpperCase().includes('EPI');
      obs = isEpi ? observacoesClogEpiCodigoNome(rawObs) : destinoLabel;
    } else if (tipo === 'devolucao de carrinha') {
      obs = origemLabel;
    } else if (tipo === 'devolucao epi') {
      obs = observacoesClogEpiCodigoNome(rawObs) || origemLabel;
    }
    return { ...row, Observações: obs };
  });
}

async function normalizarTraDevTransfApeado(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return [];
  const reqIds = [
    ...new Set(
      list
        .map((row) => Number(row?.requisicao_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const traApeadosByReqId = new Map();
  if (reqIds.length > 0) {
    const reqRes = await pool.query(
      `SELECT id, devolucao_tra_apeados_numero
       FROM requisicoes
       WHERE id = ANY($1::int[])`,
      [reqIds]
    );
    for (const r of reqRes.rows || []) {
      const rid = Number(r.id);
      if (!Number.isFinite(rid) || rid <= 0) continue;
      const valor = formatarNumeroTraApeados(String(r.devolucao_tra_apeados_numero || '').trim());
      if (valor) traApeadosByReqId.set(rid, valor);
    }
  }
  return list.map((row) => {
    const tipo = String(row?.['Tipo de Movimento'] || '').trim().toLowerCase();
    if (tipo !== 'transf. apeado') return row;
    const reqId = Number(row?.requisicao_id);
    const traApeados = traApeadosByReqId.get(reqId);
    if (!traApeados) return row;
    return { ...row, 'TRA / DEV': traApeados };
  });
}

function isFluxoCentralApeadoTipos(origemTipo, destinoTipo) {
  return (
    String(origemTipo || '').trim().toLowerCase() === 'central' &&
    String(destinoTipo || '').trim().toLowerCase() === 'apeado'
  );
}

/** Transferência central→APEADO: Clog só após TRA gerada e Nº TRA guardado (registo Transf. Apeado). */
function podeExportarClogCentralApeado(requisicao) {
  if (
    !isFluxoCentralApeadoTipos(
      requisicao?.armazem_origem_tipo,
      requisicao?.armazem_destino_tipo
    )
  ) {
    return false;
  }
  const st = String(requisicao?.status || '');
  if (!['separado', 'Entregue', 'FINALIZADO'].includes(st)) return false;
  if (!requisicao?.tra_gerada_em) return false;
  return Boolean(String(requisicao?.tra_numero || '').trim());
}

/** Consulta movimentos: oculta linhas de requisições com TRA gerada mas sem Nº TRA registado. */
function requisicaoMetaPermiteLinhaMovimentoConsulta(meta) {
  if (!meta) return true;
  const st = String(meta.status || '');
  if (st === 'FINALIZADO') return true;
  if (meta.devolucao_tra_gerada_em) return true;
  if (observacoesIndicamRecebimentoMercadoriaTransfer(meta)) return true;
  if (meta.tra_gerada_em && !String(meta.tra_numero || '').trim()) return false;
  return true;
}

function filtrarLinhasMovimentoConsulta(rowsIn, metaByReqId) {
  const mapa = metaByReqId instanceof Map ? metaByReqId : null;
  return (Array.isArray(rowsIn) ? rowsIn : []).filter((row) => {
    const rid = Number(row?.requisicao_id || 0);
    const meta = mapa && Number.isFinite(rid) && rid > 0 ? mapa.get(rid) : null;
    if (!meta) {
      const tipo = String(row['Tipo de Movimento'] || '').toLowerCase();
      const traCol = String(row['TRA / DEV'] || '').trim();
      if (
        (tipo.includes('transf') && tipo.includes('apeado')) ||
        tipo === 'transf. apeado'
      ) {
        return Boolean(traCol);
      }
      return true;
    }
    return requisicaoMetaPermiteLinhaMovimentoConsulta(meta);
  });
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

/** Reporte de devolução em conferência: permitir em EM EXPEDICAO no fluxo viatura -> central. */
function podeExportarReporteDevolucaoEmProcesso(requisicao) {
  const st = String(requisicao?.status || '');
  if (st !== 'EM EXPEDICAO') return false;
  return isFluxoDevolucaoParaCentral(
    requisicao?.armazem_origem_tipo,
    requisicao?.armazem_destino_tipo
  );
}

/** Mesmo prefixo que `RECEBIMENTO_TRANSFERENCIA_MARKER` em `createRequisicoesRouter`. */
function observacoesIndicamRecebimentoMercadoriaTransfer(requisicao) {
  return String(requisicao?.observacoes || '')
    .toUpperCase()
    .startsWith('RECEBIMENTO_TRANSFERENCIA_V1');
}

/**
 * Reporte com TRFL já registada, em EM EXPEDICAO (ex.: transferências entre centrais).
 * Exclui recebimento de mercadoria e cancelamento em expedição.
 */
function podeExportarReporteEmExpedicaoPosTrfl(requisicao) {
  if (String(requisicao?.status || '') !== 'EM EXPEDICAO') return false;
  if (observacoesIndicamRecebimentoMercadoriaTransfer(requisicao)) return false;
  if (requisicao?.cancelada_em_expedicao) return false;
  return Boolean(requisicao?.tra_gerada_em);
}

function podeExportarReporteRequisicao(requisicao) {
  return (
    podeExportarReporteOuClog(requisicao) ||
    podeExportarReporteDevolucaoEmProcesso(requisicao) ||
    podeExportarReporteEmExpedicaoPosTrfl(requisicao)
  );
}

/** Devolução viatura/EPI → central: Clog após DEV gerado e Nº DEV/TRA registado (inclui EM EXPEDICAO/APEADOS). */
function podeExportarClogDevolucaoParaCentral(requisicao) {
  if (!isFluxoDevolucaoParaCentralClog(requisicao)) return false;
  if (!requisicao?.devolucao_tra_gerada_em) return false;
  return Boolean(String(requisicao?.tra_numero || '').trim());
}

/** Clog permite também devolução em APEADOS após DEV + Nº DEV guardado. */
function podeExportarClog(requisicao) {
  if (podeExportarClogCentralApeado(requisicao)) return true;
  if (podeExportarClogDevolucaoParaCentral(requisicao)) return true;
  if (podeExportarReporteOuClog(requisicao)) return true;
  const st = String(requisicao?.status || '');
  if (st !== 'APEADOS') return false;
  if (!requisicao?.devolucao_tra_gerada_em) return false;
  return Boolean(
    String(requisicao?.tra_numero || '').trim() ||
      String(requisicao?.devolucao_tra_apeados_numero || '').trim()
  );
}

function formatDateBR(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function sanitizeSeriaisEntradaFilePart(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'x';
}

/** Ex.: codigo RIC + descrição AVE04 → RIC_AVE04 (para nome do ficheiro). */
function equipaSlugSeriaisEntrada(requisicao) {
  const cod = sanitizeSeriaisEntradaFilePart(requisicao.armazem_destino_codigo);
  const desc = String(requisicao.armazem_destino_descricao || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 24);
  if (cod && desc) return `${cod}_${desc}`;
  if (cod) return cod;
  return desc || 'equipa';
}

async function serialsRecolhidosRequisicaoItem(poolConn, requisicaoItemId, ri) {
  try {
    const snRows = await poolConn.query(
      `SELECT TRIM(serialnumber) AS sn
       FROM requisicoes_itens_seriais
       WHERE requisicao_item_id = $1
       ORDER BY ordem, id`,
      [requisicaoItemId]
    );
    const fromTable = (snRows.rows || []).map((r) => String(r.sn || '').trim()).filter(Boolean);
    if (fromTable.length) return fromTable;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  try {
    const b = await poolConn.query(
      `SELECT TRIM(serialnumber) AS sn
       FROM requisicoes_itens_bobinas
       WHERE requisicao_item_id = $1
         AND serialnumber IS NOT NULL
         AND TRIM(serialnumber) <> ''`,
      [requisicaoItemId]
    );
    const fromBob = (b.rows || []).map((r) => String(r.sn || '').trim()).filter(Boolean);
    if (fromBob.length) return fromBob;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  return serialsNormalizadosList(ri.serialnumber);
}

async function serialsComApeadoRequisicaoItem(poolConn, requisicaoItemId, ri) {
  try {
    const snRows = await poolConn.query(
      `SELECT TRIM(serialnumber) AS sn, COALESCE(apeado, false) AS apeado
       FROM requisicoes_itens_seriais
       WHERE requisicao_item_id = $1
       ORDER BY ordem, id`,
      [requisicaoItemId]
    );
    const fromTable = (snRows.rows || [])
      .map((r) => ({ sn: String(r.sn || '').trim(), apeado: Boolean(r.apeado) }))
      .filter((r) => r.sn);
    if (fromTable.length) return fromTable;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  const serials = await serialsRecolhidosRequisicaoItem(poolConn, requisicaoItemId, ri);
  const qtdApeados = Math.max(0, parseInt(ri?.quantidade_apeados ?? 0, 10) || 0);
  return (serials || []).map((sn, idx) => ({ sn: String(sn || '').trim(), apeado: idx < qtdApeados }));
}

/** Mapa serial (UPPER TRIM) → código da caixa (`stock_caixas.codigo_caixa`) quando o serial está ligado via `stock_caixa_seriais`. */
async function mapCodigoCaixaPorSerialStock(poolConn, itemId, armazemId, serials) {
  const map = new Map();
  const list = (serials || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!itemId || !list.length) return map;
  const armNum = Number(armazemId);
  const armFilter = Number.isFinite(armNum) && armNum > 0 ? armNum : null;
  try {
    const r = await poolConn.query(
      `SELECT UPPER(TRIM(ss.serialnumber)) AS sn_key,
              TRIM(c.codigo_caixa) AS codigo_caixa
       FROM stock_serial ss
       LEFT JOIN stock_caixa_seriais scs ON scs.stock_serial_id = ss.id
       LEFT JOIN stock_caixas c ON c.id = scs.caixa_id
       WHERE ss.item_id = $1
         AND ($2::int IS NULL OR ss.armazem_id = $2)
         AND UPPER(TRIM(ss.serialnumber)) = ANY(
           SELECT UPPER(TRIM(u.x)) FROM unnest($3::text[]) AS u(x)
         )`,
      [itemId, armFilter, list]
    );
    for (const row of r.rows || []) {
      const k = row.sn_key;
      const cod = row.codigo_caixa != null ? String(row.codigo_caixa).trim() : '';
      if (k && cod) map.set(k, cod);
    }
  } catch (e) {
    if (e.code === '42P01') return map;
    throw e;
  }
  return map;
}

// ZIP com um Excel por linha S/N (modelo stock-entry-serial-numbers): coluna A = número de série; coluna B = N.º caixa (se existir em stock).
router.get('/:id/export-seriais-entrada', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!requisicao.separacao_confirmada) {
      return res.status(400).json({ error: 'Só disponível após confirmar a separação.' });
    }
    if (!['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) {
      return res.status(400).json({ error: 'Requisição deve estar preparada / confirmada para exportar seriais.' });
    }

    const templateCandidates = [
      path.join(__dirname, '..', 'docExemplo', 'stock-entry-serial-numbers.2026-04-16.xlsx'),
      path.join(__dirname, '..', 'stock-entry-serial-numbers.2026-04-16.xlsx'),
    ];
    const templatePath = templateCandidates.find((p) => fs.existsSync(p));
    if (!templatePath) {
      return res.status(500).json({ error: 'Modelo Excel de entrada de seriais não encontrado no servidor.' });
    }

    const reqIdNum = parseInt(id, 10);
    const equipa = equipaSlugSeriaisEntrada(requisicao);
    const files = [];

    for (const ri of requisicao.itens || []) {
      if (!isTipoControloSerial(String(ri.tipocontrolo || '').toUpperCase())) continue;
      // eslint-disable-next-line no-await-in-loop
      const serials = await serialsRecolhidosRequisicaoItem(pool, ri.id, ri);
      if (!serials.length) continue;

      // eslint-disable-next-line no-await-in-loop
      const caixaBySerial = await mapCodigoCaixaPorSerialStock(
        pool,
        ri.item_id,
        requisicao.armazem_origem_id,
        serials
      );

      // eslint-disable-next-line no-await-in-loop
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line no-await-in-loop
      await wb.xlsx.readFile(templatePath);
      const ws = wb.worksheets[0];
      if (!ws) continue;
      ws.getCell(1, 2).value = 'N.º caixa';
      let rowNum = 2;
      for (const sn of serials) {
        ws.getCell(rowNum, 1).value = sn;
        const codCaixa = caixaBySerial.get(String(sn || '').trim().toUpperCase()) || '';
        ws.getCell(rowNum, 2).value = codCaixa || null;
        rowNum += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      const buf = await wb.xlsx.writeBuffer();
      const base = `${sanitizeSeriaisEntradaFilePart(ri.item_codigo)}_${equipa}_${reqIdNum}`;
      files.push({ name: `${base}.xlsx`, buffer: Buffer.from(buf) });
    }

    if (!files.length) {
      return res.status(400).json({ error: 'Não há itens S/N com serial preenchido nesta requisição.' });
    }

    if (files.length === 1) {
      const only = files[0];
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${only.name}"`);
      return res.send(only.buffer);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="seriais_requisicao_${reqIdNum}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('Erro ao gerar ZIP de seriais entrada:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message || 'Erro ao compactar ficheiros' });
    });
    archive.pipe(res);
    for (const f of files) {
      archive.append(f.buffer, { name: f.name });
    }
    await archive.finalize();
  } catch (error) {
    console.error('Erro ao exportar seriais entrada:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao exportar seriais', details: error.message });
    }
  }
});

// TRFL — Só quando armazém de origem é geral (central). Destino = localização de expedição do armazém de origem.
router.get('/:id/export-trfl', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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
    const fluxoDevolucao = isFluxoDevolucaoParaCentral(tipoOrigem, tipoDestino);

    if (!fluxoDevolucao && tipoOrigem !== 'central') {
      return res.status(400).json({ error: 'TRFL só é gerado quando o armazém de origem é um armazém geral (central). Esta requisição tem origem em armazém viatura (use primeiro a TRA de devolução, depois esta TRFL).' });
    }

    // Devolução: movimento interno no central (recebimento → zona final FERR / normal).
    if (fluxoDevolucao) {
      if (!requisicao.armazem_id) {
        return res.status(400).json({ error: 'Requisição sem armazém de destino.' });
      }
      if (!requisicao.devolucao_tra_gerada_em) {
        return res.status(400).json({
          error: 'Gere primeiro a TRA de devolução (entrada no armazém destino na localização de recebimento).'
        });
      }

      const armDestRow = await pool.query('SELECT id, codigo FROM armazens WHERE id = $1', [requisicao.armazem_id]);
      if (armDestRow.rows.length === 0) {
        return res.status(400).json({ error: 'Armazém de destino não encontrado.' });
      }
      const ad = armDestRow.rows[0];
      let locRec = await localizacaoArmazemPorTipoConn(pool, ad.id, 'recebimento');
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
        if (!itemTemSaidaTrflTra(ri)) continue;
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

        if (!itemTemSaidaTrflTra(ri)) continue;
        const qty = Math.floor(quantidadePreparadaEfetiva(ri));
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

      const cTrflDev = await pool.connect();
      try {
        await cTrflDev.query('BEGIN');
        let lockTrflD;
        try {
          lockTrflD = await cTrflDev.query(
            'SELECT devolucao_tra_gerada_em, devolucao_trfl_gerada_em FROM requisicoes WHERE id = $1 FOR UPDATE',
            [id]
          );
        } catch (docErr) {
          if (docErr.code === '42703') {
            await cTrflDev.query('ROLLBACK');
            cTrflDev.release();
            return res.status(503).json({
              error: 'Colunas de documentos de devolução em falta.',
              details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
            });
          }
          throw docErr;
        }
        if (!lockTrflD.rows[0]?.devolucao_tra_gerada_em) {
          await cTrflDev.query('ROLLBACK');
          cTrflDev.release();
          return res.status(400).json({
            error: 'Gere primeiro a TRA de devolução (entrada no armazém destino na localização de recebimento).'
          });
        }
        if (!lockTrflD.rows[0]?.devolucao_trfl_gerada_em && usuarioTemPermissaoControloStock(req)) {
          try {
            await aplicarStockTrflDevolucaoInterno(cTrflDev, {
              centralId: ad.id,
              locRec,
              localizacaoFERR,
              localizacaoNormal,
              itensComFerramenta,
              bobinas,
            });
          } catch (st) {
            if (st.code !== '42P01') throw st;
          }
        }
        await cTrflDev.query(
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
        await cTrflDev.query('COMMIT');
      } catch (upErr) {
        await cTrflDev.query('ROLLBACK').catch(() => {});
        if (upErr.isStockPrepBiz) {
          return res.status(upErr.status).json(upErr.payload);
        }
        if (upErr.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw upErr;
      } finally {
        cTrflDev.release();
      }

      buildExcelTransferencia(rows, res, `TRFL_requisicao_${id}_devolucao_${new Date().toISOString().slice(0, 10)}.xlsx`);
      schedulePersistMovimentosHistoricoForRequisicoes([Number(id)], 'export-devolucao-trfl');
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

    const reqIdNum = parseInt(id, 10);
    if (usuarioTemPermissaoControloStock(req)) {
      const cTrfl = await pool.connect();
      try {
        await cTrfl.query('BEGIN');
        try {
          await aplicarStockTrflSePendenteNormais(cTrfl, {
            requisicaoId: reqIdNum,
            armazemOrigemId: requisicao.armazem_origem_id,
            itens: requisicao.itens || [],
            bobinas,
          });
          await cTrfl.query('COMMIT');
        } catch (innerTrfl) {
          await cTrfl.query('ROLLBACK').catch(() => {});
          if (innerTrfl.code === '42P01' || innerTrfl.code === '42703') {
            /* módulo de stock ou colunas de tracking em falta */
          } else if (innerTrfl.isStockPrepBiz) {
            return res.status(innerTrfl.status).json(innerTrfl.payload);
          } else {
            throw innerTrfl;
          }
        }
      } finally {
        cTrfl.release();
      }
    }

    const rows = [];
    const locDestinoByReqItemId = new Map();
    const isCancelamentoExpedicao = String(requisicao.status || '') === 'EM EXPEDICAO' && Boolean(requisicao.cancelada_em_expedicao);

    // Linhas por bobina (cada bobina = uma linha)
    for (const b of bobinas) {
      const rowItem = requisicao.itens.find(it => it.item_id === b.item_id);
      if (!itemTemSaidaTrflTra(rowItem)) continue;
      const localOrigSeparacao = rowItem?.localizacao_origem || '';
      const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : localOrigSeparacao;
      const destinationLocation = isCancelamentoExpedicao ? localOrigSeparacao : localizacaoExpedicao;
      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: originLocation,
        Article: String(b.item_codigo || ''),
        Quatity: Number(b.metros) || 0,
        SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoOrigem,
        DestinationLocation: destinationLocation,
        ProjectCode: '',
        Batch: b.lote || ''
      });
    }

    // Itens sem bobinas (controle por quantidade / S/N, etc.)
    for (const ri of requisicao.itens || []) {
      const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
      const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
      if (tipoControlo === 'LOTE' && temBobinas) continue;

      if (!itemTemSaidaTrflTra(ri)) continue;
      const qty = Math.floor(quantidadePreparadaEfetiva(ri));
      if (isTipoControloSerial(tipoControlo)) {
        const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : (ri.localizacao_origem || '');
        const destinationLocation = isCancelamentoExpedicao ? (ri.localizacao_origem || '') : localizacaoExpedicao;
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: originLocation,
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoOrigem,
          DestinationLocation: destinationLocation,
          ProjectCode: '',
          Batch: ri.lote || ''
        });
        continue;
      }
      const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : (ri.localizacao_origem || '');
      const destinationLocation = isCancelamentoExpedicao ? (ri.localizacao_origem || '') : localizacaoExpedicao;
      rows.push({
        Date: dateStr,
        OriginWarehouse: codigoOrigem,
        OriginLocation: originLocation,
        Article: String(ri.item_codigo || ''),
        Quatity: qty,
        SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
        DestinationWarehouse: codigoOrigem,
        DestinationLocation: destinationLocation,
        ProjectCode: '',
        Batch: ri.lote || ''
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'Não há linhas com quantidade preparada > 0 para gerar TRFL (itens preparados com 0 não entram no ficheiro).',
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

      if (usuarioTemPermissaoControloStock(req)) {
        const cTrflM = await pool.connect();
        try {
          await cTrflM.query('BEGIN');
          try {
            await aplicarStockTrflSePendenteNormais(cTrflM, {
              requisicaoId: id,
              armazemOrigemId: requisicao.armazem_origem_id,
              itens: requisicao.itens || [],
              bobinas,
            });
            await cTrflM.query('COMMIT');
          } catch (innerTrflM) {
            await cTrflM.query('ROLLBACK').catch(() => {});
            if (innerTrflM.code === '42P01' || innerTrflM.code === '42703') {
              /* sem módulo de stock ou colunas */
            } else if (innerTrflM.isStockPrepBiz) {
              return res.status(innerTrflM.status).json(innerTrflM.payload);
            } else {
              throw innerTrflM;
            }
          }
        } finally {
          cTrflM.release();
        }
      }

      const rows = [];
      const isCancelamentoExpedicao = String(requisicao.status || '') === 'EM EXPEDICAO' && Boolean(requisicao.cancelada_em_expedicao);

      for (const b of bobinas) {
        const rowItem = requisicao.itens.find(it => it.item_id === b.item_id);
        if (!itemTemSaidaTrflTra(rowItem)) continue;
        const localOrigSeparacao = rowItem?.localizacao_origem || '';
        const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : localOrigSeparacao;
        const destinationLocation = isCancelamentoExpedicao ? localOrigSeparacao : localizacaoExpedicao;
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: originLocation,
          Article: String(b.item_codigo || ''),
          Quatity: Number(b.metros) || 0,
          SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoOrigem,
          DestinationLocation: destinationLocation,
          ProjectCode: '',
          Batch: b.lote || ''
        });
      }

      for (const ri of requisicao.itens || []) {
        const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
        const temBobinas = bobinas.some(b => b.item_id === ri.item_id);
        if (tipoControlo === 'LOTE' && temBobinas) continue;
        if (!itemTemSaidaTrflTra(ri)) continue;
        const qty = Math.floor(quantidadePreparadaEfetiva(ri));
        if (isTipoControloSerial(tipoControlo)) {
          const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : (ri.localizacao_origem || '');
          const destinationLocation = isCancelamentoExpedicao ? (ri.localizacao_origem || '') : localizacaoExpedicao;
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoOrigem,
            OriginLocation: originLocation,
            Article: String(ri.item_codigo || ''),
            Quatity: qty,
            SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoOrigem,
            DestinationLocation: destinationLocation,
            ProjectCode: '',
            Batch: ri.lote || ''
          });
          continue;
        }

        const originLocation = isCancelamentoExpedicao ? localizacaoExpedicao : (ri.localizacao_origem || '');
        const destinationLocation = isCancelamentoExpedicao ? (ri.localizacao_origem || '') : localizacaoExpedicao;
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: originLocation,
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: ri.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoOrigem,
          DestinationLocation: destinationLocation,
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
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
    const fluxoDevolucaoTra = isFluxoDevolucaoParaCentral(tipoOrigNorm, tipoDestNorm);
    const fluxoCentralApeado = tipoOrigNorm === 'central' && tipoDestNorm === 'apeado';
    const fluxoCentralCentral = tipoOrigNorm === 'central' && tipoDestNorm === 'central';

    if (!requisicao.separacao_confirmada) {
      if (!fluxoCentralCentral) {
        return res.status(400).json({ error: 'TRA só está disponível após confirmar a separação da requisição.' });
      }
      // Fluxo central->central: após confirmar receção no destino, a origem pode gerar TRA
      // mesmo sem separacao_confirmada clássica.
      const recebQ = await pool.query(
        `SELECT id
         FROM requisicoes
         WHERE UPPER(COALESCE(observacoes, '')) LIKE UPPER($1)
           AND UPPER(COALESCE(observacoes, '')) LIKE UPPER($2)
         ORDER BY id DESC
         LIMIT 1`,
        [`${RECEBIMENTO_TRANSFERENCIA_MARKER}%`, `%AUTO_FROM_REQ:${Number(id)}% | DELIVERY_CONFIRMED:1%`]
      );
      if (!recebQ.rows.length) {
        return res.status(400).json({
          error:
            'TRA da transferência central só está disponível após confirmar o recebimento no armazém destino.'
        });
      }
    }

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
      const locRecQ = await localizacaoArmazemPorTipoConn(pool, requisicao.armazem_id, 'recebimento');
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

      await attachSeriaisToRequisicaoItens(pool, itensComFerramenta);

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
      const rows = [];

      for (const b of bobinas) {
        const riMeta = itensComFerramenta.find((it) => it.item_id === b.item_id) || {};
        if (!itemTemSaidaTrflTra(riMeta)) continue;
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

        if (!itemTemSaidaTrflTra(ri)) continue;
        const qty = Math.floor(quantidadePreparadaEfetiva(ri));
        if (isTipoControloSerial(tipoControlo)) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoViatura,
            OriginLocation: ri.localizacao_origem || '',
            Article: String(ri.item_codigo || ''),
            Quatity: qty,
            SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: locRec,
            ProjectCode: '',
            Batch: ri.lote || ''
          });
          continue;
        }

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

      const cDev = await pool.connect();
      try {
        await cDev.query('BEGIN');
        let lockDev;
        try {
          lockDev = await cDev.query(
            'SELECT devolucao_tra_gerada_em FROM requisicoes WHERE id = $1 FOR UPDATE',
            [id]
          );
        } catch (e) {
          if (e.code === '42703') {
            await cDev.query('ROLLBACK');
            cDev.release();
            return res.status(503).json({
              error: 'Colunas de documentos de devolução em falta.',
              details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
            });
          }
          throw e;
        }
        if (!lockDev.rows[0]?.devolucao_tra_gerada_em && usuarioTemPermissaoControloStock(req)) {
          try {
            await aplicarStockDevolucaoEntradaRecebimento(cDev, {
              centralId: requisicao.armazem_id,
              locRec,
              itensComFerramenta,
              bobinas,
            });
          } catch (st) {
            if (st.code !== '42P01') throw st;
          }
        }
        await cDev.query(
          `UPDATE requisicoes
           SET devolucao_tra_gerada_em = COALESCE(devolucao_tra_gerada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );
        await cDev.query('COMMIT');
      } catch (eDev) {
        await cDev.query('ROLLBACK').catch(() => {});
        if (eDev.isStockPrepBiz) {
          return res.status(eDev.status).json(eDev.payload);
        }
        if (eDev.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw eDev;
      } finally {
        cDev.release();
      }

      buildExcelTransferencia(rows, res, `DEV_requisicao_${id}_devolucao_${new Date().toISOString().slice(0, 10)}.xlsx`);
      schedulePersistMovimentosHistoricoForRequisicoes([Number(id)], 'export-devolucao-dev');
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
      const locRecDestino = await localizacaoArmazemPorTipoConn(pool, armazemDestinoId, 'recebimento');
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
      if (!itemTemSaidaTrflTra(ri)) continue;
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

      if (!itemTemSaidaTrflTra(ri)) continue;
      const qty = Math.floor(quantidadePreparadaEfetiva(ri));
      if (isTipoControloSerial(tipoControlo)) {
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoOrigem,
          OriginLocation: fluxoCentralApeado ? (ri.localizacao_origem || '') : localizacaoOrigemTRA,
          Article: String(ri.item_codigo || ''),
          Quatity: qty,
          SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
          DestinationWarehouse: codigoDestino,
          DestinationLocation:
            tipoDestNorm === 'central'
              ? localizacaoDestinoRecebimento
              : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
          ProjectCode: '',
          Batch: ri.lote || ''
        });
        continue;
      }

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

    const cTra = await pool.connect();
    try {
      await cTra.query('BEGIN');
      if (usuarioTemPermissaoControloStock(req)) {
        try {
          await baixarStockTraExpedicaoSePendenteNormais(cTra, {
            requisicaoId: parseInt(id, 10),
            armazemOrigemId: requisicao.armazem_origem_id,
            armazemDestinoId,
            tipoDestinoNorm: tipoDestNorm,
            itens: itensComFerramenta,
            bobinas,
            localizacaoRecebimentoDestino: tipoDestNorm === 'central' ? localizacaoDestinoRecebimento : null,
          });
        } catch (seTra) {
          if (seTra.code !== '42P01' && seTra.code !== '42703') throw seTra;
        }
      }
      // Consumo definitivo dos seriais reservados para esta requisição (idempotente).
      // Isto é rastreabilidade do serial e deve ocorrer mesmo sem controlo de stock ativo.
      const consumed = await cTra.query(
        `UPDATE stock_serial
         SET status = 'consumido',
             consumido_em = COALESCE(consumido_em, CURRENT_TIMESTAMP),
             atualizado_em = CURRENT_TIMESTAMP
         WHERE requisicao_id = $1
           AND status = 'reservado'
         RETURNING item_id, armazem_id, localizacao, lote, serialnumber, requisicao_item_id`,
        [id]
      );
      for (const row of consumed.rows || []) {
        // eslint-disable-next-line no-await-in-loop
        await logStockMovimento({
          tipo: 'consumo_tra',
          itemId: row.item_id,
          armazemId: row.armazem_id,
          localizacao: row.localizacao,
          lote: row.lote,
          serialnumber: row.serialnumber,
          quantidade: 1,
          requisicaoId: parseInt(id, 10),
          requisicaoItemId: row.requisicao_item_id,
          usuarioId: req.user?.id || null,
          payload: { origem: 'export-tra' },
        });
      }
      const lotesConsumir = await cTra.query(
        `SELECT b.lote, b.metros, ri.item_id, ri.localizacao_origem, ri.id AS requisicao_item_id, r.armazem_origem_id
         FROM requisicoes_itens_bobinas b
         INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
         INNER JOIN requisicoes r ON r.id = ri.requisicao_id
         WHERE ri.requisicao_id = $1`,
        [id]
      );
      for (const row of lotesConsumir.rows || []) {
        const metros = Number(row.metros) || 0;
        if (!row.lote || metros <= 0 || !row.localizacao_origem) continue;
        // eslint-disable-next-line no-await-in-loop
        await cTra.query(
          `UPDATE stock_lote
           SET quantidade_reservada = CASE WHEN quantidade_reservada >= $5 THEN quantidade_reservada - $5 ELSE 0 END,
               quantidade_consumida = quantidade_consumida + CASE WHEN quantidade_reservada >= $5 THEN $5 ELSE quantidade_reservada END,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE item_id = $1
             AND armazem_id = $2
             AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
             AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
          [row.item_id, row.armazem_origem_id, row.localizacao_origem, row.lote, metros]
        );
        // eslint-disable-next-line no-await-in-loop
        await logStockMovimento({
          db: cTra,
          tipo: 'consumo_tra_lote',
          itemId: row.item_id,
          armazemId: row.armazem_origem_id,
          localizacao: row.localizacao_origem,
          lote: row.lote,
          quantidade: metros,
          requisicaoId: parseInt(id, 10),
          requisicaoItemId: row.requisicao_item_id,
          usuarioId: req.user?.id || null,
          payload: { origem: 'export-tra' },
        });
      }
      await cTra.query(
        `UPDATE requisicoes
         SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id]
      );
      await cTra.query('COMMIT');
    } catch (eTra) {
      await cTra.query('ROLLBACK').catch(() => {});
      if (eTra.isStockPrepBiz) {
        return res.status(eTra.status).json(eTra.payload);
      }
      throw eTra;
    } finally {
      cTra.release();
    }

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'Não há linhas com quantidade preparada > 0 para gerar TRA (itens preparados com 0 não entram no ficheiro).',
      });
    }

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
    return res.status(410).json({
      error:
        'Fluxo próprio de TRA APEADOS foi descontinuado. Use tickets de transferência de localização a partir da Zona de receção.',
      code: 'APEADOS_FLOW_DEPRECATED',
    });
    const { id } = req.params;
    const destinoApeadoIdRaw = req.query.destino_apeado_id;
    const destinoApeadoId = parseInt(String(destinoApeadoIdRaw || ''), 10);
    if (!Number.isFinite(destinoApeadoId)) {
      return res.status(400).json({ error: 'Informe destino_apeado_id válido.' });
    }

    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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

    // Origem no stock / Excel: sempre da localização de recebimento do central que recebeu a devolução.
    const centralId = requisicao.armazem_id;
    if (!centralId) return res.status(400).json({ error: 'Requisição sem armazém central (destino da devolução).' });

    let locRecCentral = await localizacaoArmazemPorTipoConn(pool, centralId, 'recebimento');
    if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;

    const codigoCentralPre = String(requisicao.armazem_destino_codigo || '').trim();
    let locCentralRowsFerr = [];
    try {
      const lrF = await pool.query(
        'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
        [centralId]
      );
      locCentralRowsFerr = lrF.rows || [];
    } catch (_) {
      locCentralRowsFerr = [];
    }
    const codigoCentral =
      codigoCentralPre || (await pool.query('SELECT codigo FROM armazens WHERE id = $1', [centralId])).rows[0]?.codigo || 'E';
    const { localizacaoFERR } = computeDestLocFerrNormal(codigoCentral, locCentralRowsFerr);
    /** Regra operacional: APEADOS saem sempre da localização de recebimento do central. */
    const locOrigemApeados = locRecCentral;

    // Localização destino: recebimento do armazém APEADO (fallback para código do armazém).
    let locRecApeado = await localizacaoArmazemPorTipoConn(pool, destinoApeadoId, 'recebimento');
    if (!locRecApeado) locRecApeado = String(apeadoArmRow.codigo || '');
    if (!locRecApeado) return res.status(400).json({ error: 'Localização de recebimento do armazém APEADO não encontrada.' });

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
            OriginLocation: locOrigemApeados,
            Article: String(it.item_codigo || b.item_codigo || ''),
            Quatity: Number(b.metros) || 0,
            SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoApeado,
            DestinationLocation: locRecApeado,
            ProjectCode: '',
            Batch: b.lote || ''
          });
        }
      } else if (isTipoControloSerial(tipoControlo)) {
        const serials = serialsNormalizadosList(it.serialnumber);
        const apeadosSerials = serials.slice(0, apeadosQty);
        if (apeadosSerials.length > 0) {
          for (const sn of apeadosSerials) {
            rows.push({
              Date: dateStr,
              OriginWarehouse: codigoCentral,
              OriginLocation: locOrigemApeados,
              Article: String(it.item_codigo || ''),
              Quatity: 1,
              SerialNumber1: sn, SerialNumber2: '', MacAddress: '', CentroCusto: '',
              DestinationWarehouse: codigoApeado,
              DestinationLocation: locRecApeado,
              ProjectCode: '',
              Batch: it.lote || ''
            });
          }
        } else {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locOrigemApeados,
            Article: String(it.item_codigo || ''),
            Quatity: apeadosQty,
            SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoApeado,
            DestinationLocation: locRecApeado,
            ProjectCode: '',
            Batch: it.lote || ''
          });
        }
      } else {
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locOrigemApeados,
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

    const cApe = await pool.connect();
    try {
      await cApe.query('BEGIN');
      let lockApe;
      try {
        lockApe = await cApe.query(
          `SELECT devolucao_tra_gerada_em, devolucao_trfl_gerada_em, devolucao_tra_apeados_gerada_em, observacoes
           FROM requisicoes WHERE id = $1 FOR UPDATE`,
          [id]
        );
      } catch (e) {
        if (e.code === '42703') {
          await cApe.query('ROLLBACK');
          cApe.release();
          return res.status(503).json({
            error: 'Colunas de documentos pendentes em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
          });
        }
        throw e;
      }
      if (!lockApe.rows[0]?.devolucao_tra_gerada_em) {
        await cApe.query('ROLLBACK');
        cApe.release();
        return res.status(400).json({ error: 'Gere primeiro a TRA de devolução.' });
      }
      const obsComPendenciaStock = upsertMarkerFlag(
        lockApe.rows[0]?.observacoes,
        DEV_APEADOS_STOCK_PENDENTE_MARKER,
        true
      );
      await cApe.query(
        `UPDATE requisicoes
         SET devolucao_tra_apeados_gerada_em = COALESCE(devolucao_tra_apeados_gerada_em, CURRENT_TIMESTAMP),
             devolucao_apeado_destino_id = COALESCE(devolucao_apeado_destino_id, $2),
             tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP),
             observacoes = $3
         WHERE id = $1`,
        [id, destinoApeadoId, obsComPendenciaStock]
      );
      await cApe.query('COMMIT');
    } catch (eApe) {
      await cApe.query('ROLLBACK').catch(() => {});
      if (eApe.isStockPrepBiz) {
        return res.status(eApe.status).json(eApe.payload);
      }
      if (eApe.code === '42703') {
        return res.status(503).json({
          error: 'Colunas de documentos pendentes em falta.',
          details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
        });
      }
      throw eApe;
    } finally {
      cApe.release();
    }

    buildExcelTransferencia(rows, res, `TRA_apeados_devolucao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRA de APEADOS:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA de APEADOS', details: error.message });
  }
});

// TRFL pendente de armazenagem (devolução): origem = recebimento ou zona normal (se já houve TRFL interna) → localização escolhida
// Usa somente o saldo remanescente: quantidade_preparada - quantidade_apeados.
router.get('/:id/export-trfl-pendente-armazenagem', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    return res.status(410).json({
      error:
        'Fluxo de TRFL pendente de armazenagem foi descontinuado. Use tickets de transferência de localização a partir da Zona de receção.',
      code: 'DEV_PENDENTE_FLOW_DEPRECATED',
    });
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }

    const fluxoDevolucao = isFluxoDevolucaoParaCentral(requisicao.armazem_origem_tipo, requisicao.armazem_destino_tipo);
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
      `SELECT id, localizacao
         FROM armazens_localizacoes
        WHERE armazem_id = $1`,
      [centralId]
    );
    const locIdByLabel = new Map(
      (destLocRows.rows || [])
        .map((r) => [String(r.localizacao || '').trim().toUpperCase(), Number(r.id)])
        .filter(([label, id]) => Boolean(label) && Number.isFinite(id))
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

    let locRecCentral = await localizacaoArmazemPorTipoConn(pool, centralId, 'recebimento');
    if (!locRecCentral) locRecCentral = LOCALIZACAO_RECEBIMENTO_FALLBACK;

    const codigoCentral = String(requisicao.armazem_destino_codigo || '').trim() || 'E';
    const { localizacaoNormal } = computeDestLocFerrNormal(codigoCentral, destLocRows.rows || []);
    /** Remanescente no stock: após TRFL interna está na zona normal; antes ainda no recebimento. */
    const locOrigemPendente = requisicao.devolucao_trfl_gerada_em ? localizacaoNormal : locRecCentral;
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
    const locDestinoByReqItemId = new Map();
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
      locDestinoByReqItemId.set(Number(it.id), localizacaoDestino);

      const tipoControlo = String(it.tipocontrolo || '').toUpperCase();

      if (tipoControlo === 'LOTE') {
        const bobinas = bobinasByRequisicaoItemId.get(Number(it.id)) || [];
        const selecionadas = bobinas.slice(apeadosQty, apeadosQty + remQty);
        for (const b of selecionadas) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoCentral,
            OriginLocation: locOrigemPendente,
            Article: String(it.item_codigo || b.item_codigo || ''),
            Quatity: Number(b.metros) || 0,
            SerialNumber1: b.serialnumber || '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: localizacaoDestino,
            ProjectCode: '',
            Batch: b.lote || ''
          });
        }
      } else if (isTipoControloSerial(tipoControlo)) {
        const serials = String(it.serialnumber || '')
          .split(/\r?\n|;|\|/)
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const remSerials = serials.slice(apeadosQty, apeadosQty + remQty);
        rows.push({
          Date: dateStr,
          OriginWarehouse: codigoCentral,
          OriginLocation: locOrigemPendente,
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
          OriginLocation: locOrigemPendente,
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

    const cPend = await pool.connect();
    try {
      await cPend.query('BEGIN');
      let lockPend;
      try {
        lockPend = await cPend.query(
          `SELECT devolucao_trfl_pendente_gerada_em, devolucao_trfl_gerada_em, observacoes FROM requisicoes WHERE id = $1 FOR UPDATE`,
          [id]
        );
      } catch (e) {
        if (e.code === '42703') {
          await cPend.query('ROLLBACK');
          cPend.release();
          return res.status(503).json({
            error: 'Colunas de documentos pendentes em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
          });
        }
        throw e;
      }
      for (const it of requisicao.itens || []) {
        const rid = Number(it.id);
        if (!Number.isFinite(rid)) continue;
        const locDestino = String(locDestinoByReqItemId.get(rid) || '').trim();
        if (!locDestino) continue;
        // eslint-disable-next-line no-await-in-loop
        await cPend.query(
          `UPDATE requisicoes_itens
           SET observacoes = $2
           WHERE id = $1`,
          [rid, upsertTaggedValue(it.observacoes, TRFL_PENDENTE_LOC_TAG, locDestino)]
        );
      }
      const obsComPendenciaStock = upsertMarkerFlag(
        lockPend.rows[0]?.observacoes,
        DEV_TRFL_PENDENTE_STOCK_MARKER,
        true
      );
      await cPend.query(
        `UPDATE requisicoes
         SET devolucao_trfl_pendente_gerada_em = COALESCE(devolucao_trfl_pendente_gerada_em, CURRENT_TIMESTAMP),
             observacoes = $2
         WHERE id = $1`,
        [id, obsComPendenciaStock]
      );
      await cPend.query('COMMIT');
    } catch (ePend) {
      await cPend.query('ROLLBACK').catch(() => {});
      if (ePend.isStockPrepBiz) {
        return res.status(ePend.status).json(ePend.payload);
      }
      if (ePend.code === '42703') {
        return res.status(503).json({
          error: 'Colunas de documentos pendentes em falta.',
          details: 'Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes'
        });
      }
      throw ePend;
    } finally {
      cPend.release();
    }

    try {
      if (typeof armazemMovimentacaoInternaTableExists === 'function' && await armazemMovimentacaoInternaTableExists()) {
        const cTicket = await pool.connect();
        try {
          await cTicket.query('BEGIN');
          const origemLocId = Number(locIdByLabel.get(String(locOrigemPendente || '').trim().toUpperCase()) || 0);
          if (Number.isFinite(origemLocId) && origemLocId > 0) {
            for (const row of rows) {
              const itemCodigo = String(row.Article || '').trim();
              const destinoLabel = String(row.DestinationLocation || '').trim().toUpperCase();
              const destinoLocId = Number(locIdByLabel.get(destinoLabel) || 0);
              const qty = Number(row.Quatity || 0);
              if (!itemCodigo || !Number.isFinite(destinoLocId) || destinoLocId <= 0) continue;
              if (!Number.isFinite(qty) || qty <= 0) continue;

              // eslint-disable-next-line no-await-in-loop
              const itemQ = await cTicket.query(
                'SELECT id FROM itens WHERE UPPER(TRIM(codigo)) = UPPER(TRIM($1::text)) LIMIT 1',
                [itemCodigo]
              );
              const itemId = Number(itemQ.rows?.[0]?.id || 0);
              if (!Number.isFinite(itemId) || itemId <= 0) continue;

              // eslint-disable-next-line no-await-in-loop
              await cTicket.query(
                `INSERT INTO armazem_movimentacao_interna (
                   armazem_id, usuario_id, origem_localizacao_id, destino_localizacao_id, item_id, quantidade, trfl_gerada_em
                 ) VALUES ($1, $2, $3, $4, $5, $6::numeric, CURRENT_TIMESTAMP)`,
                [centralId, req.user.id, origemLocId, destinoLocId, itemId, qty]
              );
            }
          }
          await cTicket.query('COMMIT');
        } catch (eTicket) {
          await cTicket.query('ROLLBACK').catch(() => {});
          if (eTicket.code !== '42P01') throw eTicket;
        } finally {
          cTicket.release();
        }
      }
    } catch (eAutoTicket) {
      if (eAutoTicket.code !== '42P01') throw eAutoTicket;
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

      let tipoDestNormMulti = '';
      if (armazemDestinoId) {
        const trDm = await pool.query(
          'SELECT LOWER(TRIM(COALESCE(tipo, \'\'))) AS t FROM armazens WHERE id = $1',
          [armazemDestinoId]
        );
        tipoDestNormMulti = String(trDm.rows[0]?.t || '').toLowerCase();
      }
      let localizacaoDestinoRecebimentoMulti = localizacaoNormal;
      if (tipoDestNormMulti === 'central') {
        const locRecDestino = await localizacaoArmazemPorTipoConn(pool, armazemDestinoId, 'recebimento');
        if (locRecDestino) localizacaoDestinoRecebimentoMulti = locRecDestino;
      }

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

      const rows = [];

      for (const b of bobinas) {
        const ri = itensComFerramenta.find(it => it.item_id === b.item_id) || {};
        if (!itemTemSaidaTrflTra(ri)) continue;
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

        if (!itemTemSaidaTrflTra(ri)) continue;
        const qty = Math.floor(quantidadePreparadaEfetiva(ri));
        if (isTipoControloSerial(tipoControlo)) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoOrigem,
            OriginLocation: localizacaoOrigemTRA,
            Article: String(ri.item_codigo || ''),
            Quatity: qty,
            SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoDestino,
            DestinationLocation:
              tipoDestNormMulti === 'central'
                ? localizacaoDestinoRecebimentoMulti
                : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
            ProjectCode: '',
            Batch: ri.lote || ''
          });
          continue;
        }

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
        const cTraM = await pool.connect();
        try {
          await cTraM.query('BEGIN');
          if (usuarioTemPermissaoControloStock(req)) {
            try {
              await baixarStockTraExpedicaoSePendenteNormais(cTraM, {
                requisicaoId: id,
                armazemOrigemId: requisicao.armazem_origem_id,
                armazemDestinoId,
                tipoDestinoNorm: tipoDestNormMulti,
                itens: itensComFerramenta,
                bobinas,
                localizacaoRecebimentoDestino:
                  tipoDestNormMulti === 'central' ? localizacaoDestinoRecebimentoMulti : null,
              });
            } catch (seTraM) {
              if (seTraM.code !== '42P01' && seTraM.code !== '42703') throw seTraM;
            }
          }
          // Consumo definitivo dos seriais reservados para esta requisição (idempotente),
          // mesmo quando o utilizador não controla stock físico.
          const consumed = await cTraM.query(
            `UPDATE stock_serial
             SET status = 'consumido',
                 consumido_em = COALESCE(consumido_em, CURRENT_TIMESTAMP),
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE requisicao_id = $1
               AND status = 'reservado'
             RETURNING item_id, armazem_id, localizacao, lote, serialnumber, requisicao_item_id`,
            [id]
          );
          for (const row of consumed.rows || []) {
            // eslint-disable-next-line no-await-in-loop
            await logStockMovimento({
              tipo: 'consumo_tra',
              itemId: row.item_id,
              armazemId: row.armazem_id,
              localizacao: row.localizacao,
              lote: row.lote,
              serialnumber: row.serialnumber,
              quantidade: 1,
              requisicaoId: id,
              requisicaoItemId: row.requisicao_item_id,
              usuarioId: req.user?.id || null,
              payload: { origem: 'export-tra-multi' },
            });
          }
          const lotesConsumir = await cTraM.query(
            `SELECT b.lote, b.metros, ri.item_id, ri.localizacao_origem, ri.id AS requisicao_item_id, r.armazem_origem_id
             FROM requisicoes_itens_bobinas b
             INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
             INNER JOIN requisicoes r ON r.id = ri.requisicao_id
             WHERE ri.requisicao_id = $1`,
            [id]
          );
          for (const row of lotesConsumir.rows || []) {
            const metros = Number(row.metros) || 0;
            if (!row.lote || metros <= 0 || !row.localizacao_origem) continue;
            // eslint-disable-next-line no-await-in-loop
            await cTraM.query(
              `UPDATE stock_lote
               SET quantidade_reservada = CASE WHEN quantidade_reservada >= $5 THEN quantidade_reservada - $5 ELSE 0 END,
                   quantidade_consumida = quantidade_consumida + CASE WHEN quantidade_reservada >= $5 THEN $5 ELSE quantidade_reservada END,
                   atualizado_em = CURRENT_TIMESTAMP
               WHERE item_id = $1
                 AND armazem_id = $2
                 AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
                 AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
              [row.item_id, row.armazem_origem_id, row.localizacao_origem, row.lote, metros]
            );
            // eslint-disable-next-line no-await-in-loop
            await logStockMovimento({
              db: cTraM,
              tipo: 'consumo_tra_lote',
              itemId: row.item_id,
              armazemId: row.armazem_origem_id,
              localizacao: row.localizacao_origem,
              lote: row.lote,
              quantidade: metros,
              requisicaoId: id,
              requisicaoItemId: row.requisicao_item_id,
              usuarioId: req.user?.id || null,
              payload: { origem: 'export-tra-multi' },
            });
          }
          await cTraM.query(
            `UPDATE requisicoes
             SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
             WHERE id = $1`,
            [id]
          );
          await cTraM.query('COMMIT');
        } catch (eTraM) {
          await cTraM.query('ROLLBACK').catch(() => {});
          if (eTraM.isStockPrepBiz) {
            return res.status(eTraM.status).json(eTraM.payload);
          }
          throw eTraM;
        } finally {
          cTraM.release();
        }
        allRows = allRows.concat(rows);
      }
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma requisição válida para exportar TRA combinado.' });
    }

    buildExcelTransferencia(allRows, res, `TRA_multi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar TRA multi:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA combinado', details: error.message });
  }
});

// DEV combinado — várias devoluções (viatura -> central) num único ficheiro
router.post('/export-dev-multi', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Envie um array de IDs de devoluções.' });
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

      const tipoOrigNorm = String(requisicao?.armazem_origem_tipo || '').trim().toLowerCase();
      const tipoDestNorm = String(requisicao?.armazem_destino_tipo || '').trim().toLowerCase();
      if (!isFluxoDevolucaoParaCentral(tipoOrigNorm, tipoDestNorm)) continue;
      if (!['separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue', 'FINALIZADO'].includes(requisicao.status)) continue;
      if (!requisicao.armazem_id) continue;

      let locRec = LOCALIZACAO_RECEBIMENTO_FALLBACK;
      const locRecQ = await localizacaoArmazemPorTipoConn(pool, requisicao.armazem_id, 'recebimento');
      if (locRecQ) locRec = locRecQ;

      const codigoViatura = requisicao.armazem_origem_codigo || 'E';
      const codigoCentral = requisicao.armazem_destino_codigo || '';

      let itensComFerramenta = [];
      try {
        const itensResult = await pool.query(
          `SELECT ri.*, i.codigo as item_codigo, i.tipocontrolo,
            EXISTS (
              SELECT 1 FROM itens_setores is2
              WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
            ) as is_ferramenta
          FROM requisicoes_itens ri
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1
          ORDER BY ri.id`,
          [id]
        );
        itensComFerramenta = itensResult.rows;
      } catch (_) {
        itensComFerramenta = (requisicao.itens || []).map((ri) => ({ ...ri, is_ferramenta: false }));
      }

      let bobinas = [];
      try {
        const bobinasResult = await pool.query(
          `SELECT b.*, ri.item_id, i.codigo as item_codigo
          FROM requisicoes_itens_bobinas b
          INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
          INNER JOIN itens i ON ri.item_id = i.id
          WHERE ri.requisicao_id = $1`,
          [id]
        );
        bobinas = bobinasResult.rows;
      } catch (_) {
        bobinas = [];
      }

      await attachSeriaisToRequisicaoItens(pool, itensComFerramenta);

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
      const rows = [];

      for (const b of bobinas) {
        const riMeta = itensComFerramenta.find((it) => it.item_id === b.item_id) || {};
        if (!itemTemSaidaTrflTra(riMeta)) continue;
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

        if (!itemTemSaidaTrflTra(ri)) continue;
        const qty = Math.floor(quantidadePreparadaEfetiva(ri));

        if (isTipoControloSerial(tipoControlo)) {
          rows.push({
            Date: dateStr,
            OriginWarehouse: codigoViatura,
            OriginLocation: ri.localizacao_origem || '',
            Article: String(ri.item_codigo || ''),
            Quatity: qty,
            SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
            DestinationWarehouse: codigoCentral,
            DestinationLocation: locRec,
            ProjectCode: '',
            Batch: ri.lote || ''
          });
          continue;
        }

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

      if (!rows.length) continue;

      const cDevM = await pool.connect();
      try {
        await cDevM.query('BEGIN');
        let lockDev;
        try {
          lockDev = await cDevM.query(
            'SELECT devolucao_tra_gerada_em FROM requisicoes WHERE id = $1 FOR UPDATE',
            [id]
          );
        } catch (e) {
          if (e.code === '42703') {
            await cDevM.query('ROLLBACK');
            return res.status(503).json({
              error: 'Colunas de documentos de devolução em falta.',
              details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
            });
          }
          throw e;
        }

        if (!lockDev.rows[0]?.devolucao_tra_gerada_em && usuarioTemPermissaoControloStock(req)) {
          try {
            await aplicarStockDevolucaoEntradaRecebimento(cDevM, {
              centralId: requisicao.armazem_id,
              locRec,
              itensComFerramenta,
              bobinas,
            });
          } catch (st) {
            if (st.code !== '42P01') throw st;
          }
        }

        await cDevM.query(
          `UPDATE requisicoes
           SET devolucao_tra_gerada_em = COALESCE(devolucao_tra_gerada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );
        await cDevM.query('COMMIT');
      } catch (eDevM) {
        await cDevM.query('ROLLBACK').catch(() => {});
        if (eDevM.isStockPrepBiz) return res.status(eDevM.status).json(eDevM.payload);
        if (eDevM.code === '42703') {
          return res.status(503).json({
            error: 'Colunas de documentos de devolução em falta.',
            details: 'Execute: npm run db:migrate:requisicoes-devolucao-docs'
          });
        }
        throw eDevM;
      } finally {
        cDevM.release();
      }

      allRows = allRows.concat(rows);
    }

    if (allRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma devolução válida para exportar DEV combinado.' });
    }

    buildExcelTransferencia(allRows, res, `DEV_multi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    console.error('Erro ao exportar DEV multi:', error);
    res.status(500).json({ error: 'Erro ao exportar DEV combinado', details: error.message });
  }
});

// Clog — saída de armazém (quantidades negativas) baseado na TRA gerada
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
  traNumero,
  localizacaoOrigemTRA,
  localizacaoFERR,
  localizacaoNormal,
  itensComFerramenta,
  bobinas,
  opts = {}
) {
  const isDevolucao = Boolean(opts?.isDevolucao);
  const isApeados = Boolean(opts?.isApeados);
  const qtySign = isDevolucao ? 1 : -1;
  const traDev = String(traNumero || '').trim();
  const traApeados = formatarNumeroTraApeados(opts?.traApeadosNumero || '');
  const devolucaoDestinoLoc = String(opts?.devolucaoDestinoLoc || '').trim();
  const newLocDevolucao = devolucaoDestinoLoc || LOCALIZACAO_RECEBIMENTO_FALLBACK;
  const destinoTipo = String(opts?.destinoTipo || '').trim().toLowerCase();
  const destinoTraLoc = String(opts?.destinoTraLoc || '').trim();
  const isDestinoCentral = destinoTipo === 'central';
  const apeadoDestinoCodigo = String(opts?.apeadoDestinoCodigo || '').trim();
  const apeadoDestinoLoc = String(opts?.apeadoDestinoLoc || '').trim();
  const apeadosOrigemLoc = String(opts?.apeadosOrigemLoc || '').trim();
  const reqId = Number(opts?.reqId) || 0;
  const reqUserId = Number(opts?.reqUserId) || 0;
  const armazemOrigemId = Number(opts?.armazemOrigemId) || 0;
  const armazemDestinoId = Number(opts?.armazemDestinoId) || 0;
  const origemTipo = String(opts?.origemTipo || '').trim().toLowerCase();
  const destinoTipoNorm = String(opts?.destinoTipo || '').trim().toLowerCase();
  const origemCodigo = String(opts?.origemCodigo || '').trim();
  const origemDescricao = String(opts?.origemDescricao || '').trim();
  const isCentralApeado =
    (origemTipo === 'central' && (destinoTipoNorm === 'apeado' || destinoTipoNorm === 'apeados')) ||
    ((origemTipo === 'apeado' || origemTipo === 'apeados') && destinoTipoNorm === 'central');
  const tipoMovimento = isDevolucao
    ? tipoMovimentoClogParaDevolucao(origemTipo, destinoTipoNorm, origemCodigo, origemDescricao)
    : (isCentralApeado ? 'Transf. Apeado' : 'Saida de Armazem');
  const rows = [];
  const itemByItemId = new Map(itensComFerramenta.map((it) => [it.item_id, it]));
  const itemIdsComBobina = new Set(bobinas.map((b) => b.item_id));
  const apeadosQtyByItemId = new Map(
    (itensComFerramenta || []).map((it) => [Number(it.item_id), Math.max(0, parseInt(it.quantidade_apeados ?? 0, 10) || 0)])
  );
  const apeadosCountByItemId = new Map();

  for (const b of bobinas) {
    const itemMeta = itemByItemId.get(b.item_id) || {};
    if (!itemTemSaidaTrflTra(itemMeta)) continue;
    const qty = qtySign * (Number(b.metros) || 0);
    if (qty === 0) continue;

    rows.push({
      requisicao_id: reqId,
      usuario_id: reqUserId,
      armazem_origem_id: armazemOrigemId,
      armazem_id: armazemDestinoId,
      armazem_origem_tipo: origemTipo,
      armazem_destino_tipo: destinoTipoNorm,
      mov_id: `req:${reqId}:bob:${Number(b.id || 0)}:item:${Number(b.item_id || 0)}:base`,
      __ordem_movimento: 1,
      'Tipo de Movimento': tipoMovimento,
      'Dt_Recepção': dateStr,
      'REF.': String(b.item_codigo || ''),
      DESCRIPTION: String(b.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: clogLocInicial(isDevolucao, localizacaoOrigemTRA, itemMeta),
      'S/N': b.serialnumber || '',
      Lote: b.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': traDev,
      'New Localização': isDevolucao
        ? newLocDevolucao
        : (isDestinoCentral ? (destinoTraLoc || localizacaoNormal) : (itemMeta.is_ferramenta ? localizacaoFERR : localizacaoNormal)),
      DEP: '',
      Observações: colaboradorObs
    });

    if (isApeados && isDevolucao) {
      const itemId = Number(b.item_id);
      const apeadosQty = apeadosQtyByItemId.get(itemId) ?? 0;
      const current = apeadosCountByItemId.get(itemId) ?? 0;
      const next = current + 1;
      apeadosCountByItemId.set(itemId, next);
      if (next <= apeadosQty) {
        rows.push({
          requisicao_id: reqId,
          usuario_id: reqUserId,
          armazem_origem_id: armazemOrigemId,
          armazem_id: armazemDestinoId,
          armazem_origem_tipo: origemTipo,
          armazem_destino_tipo: destinoTipoNorm,
          mov_id: `req:${reqId}:bob:${Number(b.id || 0)}:item:${Number(b.item_id || 0)}:apeados:${next}`,
          __ordem_movimento: 2,
          'Tipo de Movimento': 'Transf. Apeado',
          'Dt_Recepção': dateStr,
          'REF.': String(b.item_codigo || ''),
          DESCRIPTION: String(b.item_descricao || ''),
          QTY: -Math.abs(qty),
          Loc_Inicial: apeadosOrigemLoc || clogLocInicial(isDevolucao, localizacaoOrigemTRA, itemMeta),
          'S/N': b.serialnumber || '',
          Lote: b.lote || '',
          'Novo Armazém': apeadoDestinoCodigo || codigoDestino,
          'TRA / DEV': traApeados || traDev,
          'New Localização': apeadoDestinoLoc || apeadoDestinoCodigo || '',
          DEP: '',
          Observações: colaboradorObs
        });
      }
    }
  }

  for (const ri of itensComFerramenta) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    if (tipoControlo === 'LOTE' && itemIdsComBobina.has(ri.item_id)) continue;

    if (!itemTemSaidaTrflTra(ri)) continue;
    const qty = qtySign * quantidadePreparadaEfetiva(ri);
    if (qty === 0) continue;
    const serialsItem = isTipoControloSerial(tipoControlo) ? serialsNormalizadosList(ri.serialnumber) : [];
    /** Uma linha por artigo: S/N agregados (newline), alinhado com ConsultaMovimentos.parseSeriaisMovimento. */
    if (serialsItem.length > 0) {
      const maxSerialRows = Math.min(serialsItem.length, Math.max(1, Math.floor(Math.abs(Number(qtyBase) || 0))));
      const serialsUsados = serialsItem
        .slice(0, maxSerialRows)
        .map((s) => String(s || '').trim())
        .filter(Boolean);
      const snCell = serialsUsados.join('\n');
      rows.push({
        requisicao_id: reqId,
        usuario_id: reqUserId,
        armazem_origem_id: armazemOrigemId,
        armazem_id: armazemDestinoId,
        armazem_origem_tipo: origemTipo,
        armazem_destino_tipo: destinoTipoNorm,
        mov_id: `req:${reqId}:ri:${Number(ri.id || 0)}:item:${Number(ri.item_id || 0)}:base`,
        __ordem_movimento: 1,
        'Tipo de Movimento': tipoMovimento,
        'Dt_Recepção': dateStr,
        'REF.': String(ri.item_codigo || ''),
        DESCRIPTION: String(ri.item_descricao || ''),
        QTY: qty,
        Loc_Inicial: clogLocInicial(isDevolucao, localizacaoOrigemTRA, ri),
        'S/N': snCell,
        Lote: ri.lote || '',
        'Novo Armazém': codigoDestino,
        'TRA / DEV': traDev,
        'New Localização': isDevolucao
          ? newLocDevolucao
          : (isDestinoCentral ? (destinoTraLoc || localizacaoNormal) : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal)),
        DEP: '',
        Observações: colaboradorObs
      });
      continue;
    }

    rows.push({
      requisicao_id: reqId,
      usuario_id: reqUserId,
      armazem_origem_id: armazemOrigemId,
      armazem_id: armazemDestinoId,
      armazem_origem_tipo: origemTipo,
      armazem_destino_tipo: destinoTipoNorm,
      mov_id: `req:${reqId}:ri:${Number(ri.id || 0)}:item:${Number(ri.item_id || 0)}:base`,
      __ordem_movimento: 1,
      'Tipo de Movimento': tipoMovimento,
      'Dt_Recepção': dateStr,
      'REF.': String(ri.item_codigo || ''),
      DESCRIPTION: String(ri.item_descricao || ''),
      QTY: qty,
      Loc_Inicial: clogLocInicial(isDevolucao, localizacaoOrigemTRA, ri),
      'S/N': ri.serialnumber || '',
      Lote: ri.lote || '',
      'Novo Armazém': codigoDestino,
      'TRA / DEV': traDev,
      'New Localização': isDevolucao
        ? newLocDevolucao
        : (isDestinoCentral ? (destinoTraLoc || localizacaoNormal) : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal)),
      DEP: '',
      Observações: colaboradorObs
    });

    if (isApeados && isDevolucao) {
      const apeadosQtyRaw = Math.max(0, parseInt(ri.quantidade_apeados ?? 0, 10) || 0);
      const apeadosQty = Math.max(0, Math.min(Math.abs(Number(qtyBase) || 0), apeadosQtyRaw));
      if (apeadosQty > 0) {
        rows.push({
          requisicao_id: reqId,
          usuario_id: reqUserId,
          armazem_origem_id: armazemOrigemId,
          armazem_id: armazemDestinoId,
          armazem_origem_tipo: origemTipo,
          armazem_destino_tipo: destinoTipoNorm,
          mov_id: `req:${reqId}:ri:${Number(ri.id || 0)}:item:${Number(ri.item_id || 0)}:apeados`,
          __ordem_movimento: 2,
          'Tipo de Movimento': 'Transf. Apeado',
          'Dt_Recepção': dateStr,
          'REF.': String(ri.item_codigo || ''),
          DESCRIPTION: String(ri.item_descricao || ''),
          QTY: -Math.abs(apeadosQty),
          Loc_Inicial: apeadosOrigemLoc || clogLocInicial(isDevolucao, localizacaoOrigemTRA, ri),
          'S/N': ri.serialnumber || '',
          Lote: ri.lote || '',
          'Novo Armazém': apeadoDestinoCodigo || codigoDestino,
          'TRA / DEV': traApeados || traDev,
          'New Localização': apeadoDestinoLoc || apeadoDestinoCodigo || '',
          DEP: '',
          Observações: colaboradorObs
        });
      }
    }
  }

  const origemMeta = {};
  if (origemCodigo) origemMeta.armazem_origem_codigo = origemCodigo;
  if (origemDescricao) origemMeta.armazem_origem_descricao = origemDescricao;
  if (!Object.keys(origemMeta).length) return rows;
  return rows.map((row) => ({ ...row, ...origemMeta }));
}

let _cacheMovimentosOverridesTable = null;
let _cacheMovimentosHistoricoTable = null;
let _cacheMovimentosHistoricoDetachedSchema = null;
async function movimentosOverridesTableExists() {
  if (_cacheMovimentosOverridesTable === true) return true;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'requisicoes_movimentos_overrides'
       LIMIT 1`
    );
    if (r.rows.length > 0) {
      _cacheMovimentosOverridesTable = true;
      return true;
    }
  } catch (_) {}
  return false;
}

async function applyMovimentosOverrides(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  if (!(await movimentosOverridesTableExists())) return rows;
  const keys = [...new Set(rows.map((r) => String(r.mov_id || '').trim()).filter(Boolean))];
  if (!keys.length) return rows;
  const ov = await pool.query(
    `SELECT mov_key, patch, deleted
     FROM requisicoes_movimentos_overrides
     WHERE mov_key = ANY($1::text[])`,
    [keys]
  );
  const byKey = new Map(ov.rows.map((x) => [String(x.mov_key), x]));
  const out = [];
  for (const row of rows) {
    const key = String(row.mov_id || '').trim();
    const hit = key ? byKey.get(key) : null;
    if (hit?.deleted) continue;
    const patch = hit && hit.patch && typeof hit.patch === 'object' ? hit.patch : null;
    out.push(patch ? { ...row, ...patch } : row);
  }
  return out;
}

/**
 * Igual a applyMovimentosOverrides, mas mantém alinhamento 1:1 com a lista de entrada:
 * entradas null ou linhas marcadas como apagadas em overrides → null na mesma posição.
 * Usado na paginação do histórico (cursor = OFFSET na tabela, por linha persistida).
 */
async function applyMovimentosOverridesPreserveLength(rowsMaybeNull) {
  if (!Array.isArray(rowsMaybeNull) || rowsMaybeNull.length === 0) return rowsMaybeNull || [];
  if (!(await movimentosOverridesTableExists())) {
    return rowsMaybeNull.map((r) => (r && typeof r === 'object' ? r : null));
  }
  const keys = [
    ...new Set(
      rowsMaybeNull
        .map((r) => (r && typeof r === 'object' ? String(r.mov_id || '').trim() : ''))
        .filter(Boolean)
    ),
  ];
  let byKey = new Map();
  if (keys.length > 0) {
    const ov = await pool.query(
      `SELECT mov_key, patch, deleted
       FROM requisicoes_movimentos_overrides
       WHERE mov_key = ANY($1::text[])`,
      [keys]
    );
    byKey = new Map(ov.rows.map((x) => [String(x.mov_key), x]));
  }
  return rowsMaybeNull.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const key = String(row.mov_id || '').trim();
    const hit = key ? byKey.get(key) : null;
    if (hit?.deleted) return null;
    const patch = hit && hit.patch && typeof hit.patch === 'object' ? hit.patch : null;
    return patch ? { ...row, ...patch } : row;
  });
}

async function movimentosHistoricoTableExists() {
  if (_cacheMovimentosHistoricoTable === true) return true;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'requisicoes_movimentos_historico'
       LIMIT 1`
    );
    if (r.rows.length > 0) {
      _cacheMovimentosHistoricoTable = true;
      return true;
    }
  } catch (_) {}
  return false;
}

async function ensureMovimentosHistoricoDetachedSchema() {
  if (_cacheMovimentosHistoricoDetachedSchema === true) return;
  if (!(await movimentosHistoricoTableExists())) return;
  try {
    // Remove qualquer FK de historico -> requisicoes (independente do nome da constraint).
    const fks = await pool.query(
      `SELECT c.conname AS name
       FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid = 'requisicoes_movimentos_historico'::regclass
         AND c.confrelid = 'requisicoes'::regclass`
    );
    for (const row of fks.rows || []) {
      const name = String(row?.name || '').trim();
      if (!name) continue;
      await pool.query(`ALTER TABLE requisicoes_movimentos_historico DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    // Permite manter histórico mesmo sem referência à requisição original.
    await pool.query(
      `ALTER TABLE requisicoes_movimentos_historico
       ALTER COLUMN requisicao_id DROP NOT NULL`
    );
    _cacheMovimentosHistoricoDetachedSchema = true;
  } catch (e) {
    console.warn('[movimentos_historico] não foi possível garantir schema detached:', e.message);
  }
}

async function upsertMovimentosHistorico(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (!(await movimentosHistoricoTableExists())) return;
  const valid = rows.filter((r) => String(r?.mov_id || '').trim() && Number.isFinite(Number(r?.requisicao_id)));
  if (!valid.length) return;
  for (const row of valid) {
    const movKey = String(row.mov_id).trim();
    const reqId = Number(row.requisicao_id);
    const payload = { ...row };
    await pool.query(
      `INSERT INTO requisicoes_movimentos_historico (mov_key, requisicao_id, row_data, updated_at)
       VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (mov_key)
       DO UPDATE SET
         requisicao_id = EXCLUDED.requisicao_id,
         row_data = EXCLUDED.row_data,
         updated_at = CURRENT_TIMESTAMP`,
      [movKey, reqId, JSON.stringify(payload)]
    );
  }
}

async function fetchMovimentosHistoricoByReqIds(reqIds) {
  if (!Array.isArray(reqIds) || reqIds.length === 0) return [];
  if (!(await movimentosHistoricoTableExists())) return [];
  const r = await pool.query(
    `SELECT mov_key, requisicao_id, row_data
     FROM requisicoes_movimentos_historico
     WHERE requisicao_id = ANY($1::int[])`,
    [reqIds]
  );
  return (r.rows || [])
    .map((x) => {
      const data = x.row_data && typeof x.row_data === 'object' ? x.row_data : null;
      if (!data) return null;
      return {
        ...data,
        mov_id: String(data.mov_id || x.mov_key || '').trim(),
        requisicao_id: Number(data.requisicao_id || x.requisicao_id || 0),
      };
    })
    .filter(Boolean);
}

/** Várias requisições: ~4–5 queries em vez de ~5N (muito mais rápido para Clog multi). */
async function buildClogRowsForRequisicaoIds(idsClean, dateStr, opts = {}) {
  if (!idsClean.length) return [];

  const idsUnique = [...new Set(idsClean)];
  const reqRes = await pool.query(`
    SELECT r.*,
      a.codigo as armazem_destino_codigo,
      a.descricao as armazem_destino_descricao,
      a.tipo as armazem_destino_tipo,
      ao.codigo as armazem_origem_codigo,
      ao.descricao as armazem_origem_descricao,
      ao.tipo as armazem_origem_tipo,
      aa.codigo as devolucao_apeado_destino_codigo
    FROM requisicoes r
    INNER JOIN armazens a ON r.armazem_id = a.id
    LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
    LEFT JOIN armazens aa ON r.devolucao_apeado_destino_id = aa.id
    WHERE r.id = ANY($1::int[])
  `, [idsUnique]);

  const byId = new Map(reqRes.rows.map((r) => [r.id, r]));
  const candidatas = idsClean
    .map((id) => byId.get(id))
    .filter(Boolean)
    .filter((r) => podeExportarClog(r) && r.armazem_origem_id);
  if (candidatas.length === 0) return [];

  const origemIds = [...new Set(candidatas.map((r) => r.armazem_origem_id))];
  const armRes = await pool.query(
    'SELECT id, codigo, tipo FROM armazens WHERE id = ANY($1::int[])',
    [origemIds]
  );
  const armById = new Map(armRes.rows.map((a) => [a.id, a]));

  const elegiveis = candidatas.filter((r) => Boolean(armById.get(r.armazem_origem_id)));
  if (elegiveis.length === 0) return [];

  const requisicaoIdsCentral = [...new Set(elegiveis.map((r) => r.id))];
  const origemIdsCentral = [
    ...new Set(
      elegiveis.flatMap((r) =>
        hasRecebimentoMarker(r) ? [r.armazem_origem_id, r.armazem_id] : [r.armazem_origem_id]
      )
    ),
  ];
  const destArmIds = [
    ...new Set(
      elegiveis.map((r) => (hasRecebimentoMarker(r) ? r.armazem_origem_id : r.armazem_id))
    ),
  ];
  const apeadoDestinoIds = [
    ...new Set(
      elegiveis
        .map((r) => Number(r.devolucao_apeado_destino_id))
        .filter(Number.isFinite)
    ),
  ];

  const [expRes, allLocsRes, itensRes, bobRes, locApeadoRes] = await Promise.all([
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
    ,
    apeadoDestinoIds.length > 0
      ? pool.query(
          `SELECT DISTINCT ON (armazem_id) armazem_id, localizacao
           FROM armazens_localizacoes
           WHERE armazem_id = ANY($1::int[])
             AND LOWER(COALESCE(tipo_localizacao, '')) = 'recebimento'
           ORDER BY armazem_id, id`,
          [apeadoDestinoIds]
        )
      : Promise.resolve({ rows: [] })
  ]);

  // Reidrata seriais (tabela requisicoes_itens_seriais) no campo legado `serialnumber`
  // para que a montagem do Clog reflita os S/N preparados.
  await attachSeriaisToRequisicaoItens(pool, itensRes.rows || []);

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
  const recByApeadoId = new Map(
    (locApeadoRes.rows || []).map((r) => [Number(r.armazem_id), String(r.localizacao || '').trim()])
  );

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
    const dateForReq = typeof dateStr === 'function'
      ? String(dateStr(r) || '')
      : String(dateStr || '');
    const isRecMerc = hasRecebimentoMarker(r);
    const codigoDestino = isRecMerc
      ? String(r.armazem_origem_codigo || '')
      : String(r.armazem_destino_codigo || '');
    const localizacaoOrigemTRA = isRecMerc
      ? (expByArm.get(r.armazem_id) || LOCALIZACAO_EXPEDICAO_FALLBACK)
      : (expByArm.get(r.armazem_origem_id) || LOCALIZACAO_EXPEDICAO_FALLBACK);
    const locArmDestinoLogico = isRecMerc ? r.armazem_origem_id : r.armazem_id;
    const locRows = locsByDestArm.get(locArmDestinoLogico) || [];
    const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(codigoDestino, locRows);
    const itens = itensByReq.get(id) || [];
    const bobinas = bobByReq.get(id) || [];
    const isDevolucao = isFluxoDevolucaoParaCentralClog(
      isRecMerc
        ? {
            armazem_origem_tipo: r.armazem_destino_tipo,
            armazem_destino_tipo: r.armazem_origem_tipo,
            armazem_origem_codigo: r.armazem_destino_codigo,
            armazem_origem_descricao: r.armazem_destino_descricao,
          }
        : {
            armazem_origem_tipo: r.armazem_origem_tipo,
            armazem_destino_tipo: r.armazem_destino_tipo,
            armazem_origem_codigo: r.armazem_origem_codigo,
            armazem_origem_descricao: r.armazem_origem_descricao,
          }
    );
    const obsClog = (() => {
      if (isRecMerc) {
        const tipoD = String(r.armazem_origem_tipo || '').toLowerCase();
        const cod = String(r.armazem_origem_codigo || '').toUpperCase();
        const desc = String(r.armazem_origem_descricao || '').toUpperCase();
        const epi = tipoD === 'epi' || cod.includes('EPI') || desc.includes('EPI');
        return epi ? observacoesClogEpiSomenteColaborador(r.observacoes) : r.observacoes || '';
      }
      return requisicaoComColaboradorEpi(r)
        ? observacoesClogEpiSomenteColaborador(r.observacoes)
        : r.observacoes || '';
    })();
    const numeroTraDev = String(r.tra_numero || r.devolucao_tra_apeados_numero || '').trim();
    const rows = clogRowsFromItemData(
      dateForReq || formatDateBR(new Date()),
      codigoDestino,
      obsClog,
      numeroTraDev,
      localizacaoOrigemTRA,
      localizacaoFERR,
      localizacaoNormal,
      itens,
      bobinas,
      {
        reqId: r.id,
        reqUserId: r.usuario_id,
        armazemOrigemId: isRecMerc ? r.armazem_id : r.armazem_origem_id,
        armazemDestinoId: isRecMerc ? r.armazem_origem_id : r.armazem_id,
        origemTipo: isRecMerc ? r.armazem_destino_tipo : r.armazem_origem_tipo,
        destinoTipo: isRecMerc ? r.armazem_origem_tipo : r.armazem_destino_tipo,
        origemCodigo: isRecMerc ? r.armazem_destino_codigo : r.armazem_origem_codigo,
        origemDescricao: isRecMerc ? r.armazem_destino_descricao : r.armazem_origem_descricao,
        isDevolucao,
        isApeados:
          (itens || []).some((it) => (parseInt(it.quantidade_apeados ?? 0, 10) || 0) > 0) &&
          (
            (
              Boolean(r.devolucao_tra_apeados_gerada_em) &&
              Boolean(String(r.devolucao_tra_apeados_numero || '').trim())
            ) ||
            Boolean(r.devolucao_trfl_gerada_em)
          ),
        apeadoDestinoCodigo: String(r.devolucao_apeado_destino_codigo || '').trim(),
        traApeadosNumero: String(r.devolucao_tra_apeados_numero || '').trim(),
        apeadoDestinoLoc: recByApeadoId.get(Number(r.devolucao_apeado_destino_id)) || '',
        apeadosOrigemLoc: r.devolucao_trfl_gerada_em
          ? localizacaoFERR
          : (recByDestArm.get(locArmDestinoLogico) || LOCALIZACAO_RECEBIMENTO_FALLBACK),
        devolucaoDestinoLoc: recByDestArm.get(locArmDestinoLogico) || LOCALIZACAO_RECEBIMENTO_FALLBACK,
        destinoTraLoc: recByDestArm.get(locArmDestinoLogico) || localizacaoNormal
      }
    );
    const reqSortTs = (() => {
      const d = new Date(r.updated_at || r.tra_gerada_em || r.created_at || Date.now());
      const t = d.getTime();
      return Number.isNaN(t) ? 0 : t;
    })();
    allRows.push(...rows.map((row) => ({ ...row, __req_sort_ts: reqSortTs })));
  }

  if (opts?.withOverrides === false) {
    return allRows.map(normalizarTipoMovimentoClogDevolucao);
  }
  const withOverrides = await applyMovimentosOverrides(allRows);
  return withOverrides.map(normalizarTipoMovimentoClogDevolucao);
}

/** Limite de requisições distintas por lote ao reidratar S/N e Lote (evita picos com scans muito largos). */
const MAX_REQ_IDS_ENRICH_CLOG_RASTREIO = 200;

/**
 * Snapshots antigos do Clog usam `mov_id` …`:base` (quantidade agregada). O Clog atual para S/N gera
 * várias linhas `…:sn:1`, `…:sn:2`. Junta os S/N dessas linhas para preencher a linha agregada.
 */
function agregarSeriaisClogLiveParaMovBase(histMovId, liveList) {
  const key = String(histMovId || '').trim();
  if (!key.endsWith(':base')) return '';
  const prefix = key.slice(0, -':base'.length);
  const indexed = [];
  for (const lr of liveList || []) {
    const mk = String(lr.mov_id || '').trim();
    if (!mk.startsWith(`${prefix}:sn:`)) continue;
    const m = /:sn:(\d+)$/.exec(mk);
    const ord = m ? parseInt(m[1], 10) : 0;
    const sn = String(lr['S/N'] || '').trim();
    if (!sn) continue;
    indexed.push({ ord, sn });
  }
  indexed.sort((a, b) => a.ord - b.ord);
  return indexed.map((x) => x.sn).join('\n');
}

/** Extrai `requisicao_item.id` do `mov_id` padrão do Clog (`req:…:ri:…:item:…`). */
function requisicaoItemIdDoMovIdClog(movIdRaw) {
  const m = /^req:\d+:ri:(\d+):item:\d+:/.exec(String(movIdRaw || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Último recurso: S/N ainda vazio após recalcular o Clog — lê `requisicoes_itens_seriais` e depois `stock_serial`.
 */
async function enriquecerSeriaisClogDesdeTabelaSeriais(poolConn, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const riToRows = new Map();
  for (const row of rows) {
    if (String(row['S/N'] || '').trim()) continue;
    const riId = requisicaoItemIdDoMovIdClog(row.mov_id);
    if (!riId) continue;
    if (!riToRows.has(riId)) riToRows.set(riId, []);
    riToRows.get(riId).push(row);
  }
  if (!riToRows.size) return rows;
  const riIds = [...riToRows.keys()];
  const serialsByRi = new Map();
  try {
    const r1 = await poolConn.query(
      `SELECT requisicao_item_id, serialnumber
       FROM requisicoes_itens_seriais
       WHERE requisicao_item_id = ANY($1::int[])
       ORDER BY requisicao_item_id, ordem, id`,
      [riIds]
    );
    for (const x of r1.rows || []) {
      const rid = Number(x.requisicao_item_id);
      const sn = String(x.serialnumber || '').trim();
      if (!Number.isFinite(rid) || !sn) continue;
      if (!serialsByRi.has(rid)) serialsByRi.set(rid, []);
      serialsByRi.get(rid).push(sn);
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  const needStock = riIds.filter((id) => !(serialsByRi.get(id) || []).length);
  if (needStock.length) {
    try {
      const r2 = await poolConn.query(
        `SELECT requisicao_item_id, serialnumber
         FROM stock_serial
         WHERE requisicao_item_id = ANY($1::int[])
           AND TRIM(COALESCE(serialnumber, '')) <> ''
         ORDER BY requisicao_item_id, id`,
        [needStock]
      );
      for (const x of r2.rows || []) {
        const rid = Number(x.requisicao_item_id);
        const sn = String(x.serialnumber || '').trim();
        if (!Number.isFinite(rid) || !sn) continue;
        if (!serialsByRi.has(rid)) serialsByRi.set(rid, []);
        serialsByRi.get(rid).push(sn);
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
  }
  for (const [riId, targets] of riToRows) {
    const list = serialsByRi.get(riId);
    if (!list || !list.length) continue;
    const joined = list.join('\n');
    for (const row of targets) {
      if (!String(row['S/N'] || '').trim()) row['S/N'] = joined;
    }
  }
  return rows;
}

/**
 * O histórico (`requisicoes_movimentos_historico`) guarda um snapshot; seriais podem estar só em
 * `requisicoes_itens_seriais`. Preenche `S/N` e `Lote` vazios a partir do cálculo atual do Clog.
 */
async function enriquecerClogRastreioVazioComDadosAoVivo(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const reqIds = [
    ...new Set(rows.map((r) => Number(r?.requisicao_id || 0)).filter((n) => Number.isFinite(n) && n > 0)),
  ];
  let liveRows = [];
  if (reqIds.length && reqIds.length <= MAX_REQ_IDS_ENRICH_CLOG_RASTREIO) {
    try {
      liveRows =
        (await buildClogRowsForRequisicaoIds(
          reqIds,
          (r) => formatDateBR(new Date(r.tra_gerada_em || r.updated_at || r.created_at || Date.now())),
          { withOverrides: false }
        )) || [];
    } catch (e) {
      console.warn('[movimentos_clog] enriquecer rastreio (Clog ao vivo):', e.message);
      liveRows = [];
    }
  } else if (reqIds.length > MAX_REQ_IDS_ENRICH_CLOG_RASTREIO) {
    console.warn(
      `[movimentos_clog] recalcular Clog omitido no lote: ${reqIds.length} requisições (máx ${MAX_REQ_IDS_ENRICH_CLOG_RASTREIO}); a usar só BD de seriais.`
    );
  }
  const byMov = new Map(
    (liveRows || []).map((r) => [String(r.mov_id || '').trim(), r]).filter(([k]) => k)
  );
  const mapped = rows.map((row) => {
    const key = String(row?.mov_id || '').trim();
    if (!key) return { ...row };
    const sn = String(row['S/N'] || '').trim();
    const lo = String(row.Lote || '').trim();
    const next = { ...row };
    const live = byMov.get(key);
    if (live) {
      const liveSn = String(live['S/N'] || '').trim();
      const liveLo = String(live.Lote || '').trim();
      if (!sn && liveSn) next['S/N'] = live['S/N'];
      if (!lo && liveLo) next.Lote = live.Lote;
      return next;
    }
    if (!sn) {
      const aggSn = agregarSeriaisClogLiveParaMovBase(key, liveRows);
      if (aggSn) next['S/N'] = aggSn;
    }
    return next;
  });
  return enriquecerSeriaisClogDesdeTabelaSeriais(pool, mapped);
}

/**
 * Antes de apagar o histórico, guarda `Dt_Recepção` já persistido por requisição
 * para o recálculo não substituir datas por `tra_gerada_em`/`updated_at` recentes.
 * Se houver várias datas distintas no snapshot antigo, usa a mais antiga (dd/mm/aaaa).
 */
async function fetchPreservedDtRecepcaoPorRequisicao(reqIds) {
  const map = new Map();
  if (!Array.isArray(reqIds) || reqIds.length === 0) return map;
  if (!(await movimentosHistoricoTableExists())) return map;
  const r = await pool.query(
    `SELECT requisicao_id, row_data
     FROM requisicoes_movimentos_historico
     WHERE requisicao_id = ANY($1::int[])`,
    [reqIds]
  );
  const parseBrToTime = (s) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
    if (!m) return NaN;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    const t = d.getTime();
    return Number.isNaN(t) ? NaN : t;
  };
  const byReq = new Map();
  for (const row of r.rows || []) {
    const rid = Number(row.requisicao_id);
    if (!Number.isFinite(rid) || rid <= 0) continue;
    const data = row.row_data && typeof row.row_data === 'object' ? row.row_data : null;
    if (!data) continue;
    const dt = String(data['Dt_Recepção'] ?? '').trim();
    if (!dt) continue;
    if (!byReq.has(rid)) byReq.set(rid, new Set());
    byReq.get(rid).add(dt);
  }
  for (const [rid, set] of byReq) {
    const arr = [...set];
    if (arr.length === 1) {
      map.set(rid, arr[0]);
      continue;
    }
    arr.sort((a, b) => {
      const ta = parseBrToTime(a);
      const tb = parseBrToTime(b);
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      if (Number.isFinite(ta)) return -1;
      if (Number.isFinite(tb)) return 1;
      return String(a).localeCompare(String(b));
    });
    map.set(rid, arr[0]);
  }
  return map;
}

async function persistMovimentosHistoricoForRequisicoes(ids) {
  const idsClean = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (!idsClean.length) return;
  if (!(await movimentosHistoricoTableExists())) return;
  const preservedDtRecepcao = await fetchPreservedDtRecepcaoPorRequisicao(idsClean);
  const rows = await buildClogRowsForRequisicaoIds(
    idsClean,
    (r) => {
      const rid = Number(r.id);
      const kept = preservedDtRecepcao.get(rid);
      if (kept) return kept;
      return formatDateBR(
        new Date(
          r.devolucao_tra_gerada_em ||
            r.tra_gerada_em ||
            r.updated_at ||
            r.created_at ||
            Date.now()
        )
      );
    },
    { withOverrides: false }
  );
  if (!rows.length) return;
  /** Evita linhas órfãs (ex.: `mov_id` ...`:base` vs ...`:sn:N`) quando o Clog é recalculado. */
  await pool.query(
    `DELETE FROM requisicoes_movimentos_historico WHERE requisicao_id = ANY($1::int[])`,
    [idsClean]
  );
  await upsertMovimentosHistorico(rows);
}

/**
 * Agenda persistência do snapshot de movimentos sem bloquear a resposta HTTP.
 * `buildClogRowsForRequisicaoIds` + `upsertMovimentosHistorico` podem demorar muito (ex.: muitos S/N).
 */
function schedulePersistMovimentosHistoricoForRequisicoes(ids, contextLabel = '') {
  const idsClean = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (!idsClean.length) return;
  setImmediate(() => {
    persistMovimentosHistoricoForRequisicoes(idsClean).catch((e) => {
      const tag = contextLabel ? ` (${contextLabel})` : '';
      console.warn(`[movimentos_historico] falha ao persistir snapshot assíncrono${tag}:`, e?.message || e);
    });
  });
}

  const { registerDomainRouters } = require('./requisicoes/registerDomainRouters');
  registerDomainRouters(router, {
    pool,
    requisicaoAuth,
    denyNonAdmin,
    stockImportUpload,
    isAdmin,
    requisicaoArmazemOrigemAcessoPermitido,
    denyBackofficeOperations,
    separadorImpedeAcao,
    respostaBloqueioSeparador,
    hasRecebimentoMarker,
    getRequisicaoComItens,
    attachSeriaisToRequisicaoItens,
    reservarMetrosStockLote,
    liberarMetrosStockLotePorRequisicaoItem,
    liberarReservasLotePorRequisicaoItem,
    logStockMovimento,
    quantidadeNecessariaStockPreparacao,
    isTipoControloSerial,
    serialsNormalizadosList,
    obterCompartilhaStockSerialArmazem,
    armazemControlaSerialNumbers,
    caixaPorSerialFromSerialnumberBlob,
    schedulePersistMovimentosHistoricoForRequisicoes,
    movimentosHistoricoTableExists,
    STOCK_STATUS,
    adminPodeCorrigirPreparacaoItemSeparada,
    adminPodeRemoverLinhaRequisicao,
    makeStockPrepBizError: makeStockPrepBizErrorSvc,
    denyOperador,
    liberarReservasLotePorRequisicao,
    ensureMovimentosHistoricoDetachedSchema,
    persistMovimentosHistoricoForRequisicoes,
    extractPdfText,
    buildExcelTransferencia,
    SQL_CRIADOR_NOME,
    SQL_CRIADOR_COM_EMAIL,
    usuarioEscopadoSemArmazensAtribuidos,
    denyOnlyOperador,
    excelUploadRequisicoes,
    authenticateToken,
    requisicaoScopeMiddleware,
    markerFlagAtivo,
    upsertMarkerFlag,
    getTaggedValue,
    getAutoFromReqId,
    usuarioTemPermissaoControloStock,
    aplicarStockDevolucaoEntradaRecebimento,
    aplicarStockTraApeadosDevolucao,
    aplicarStockTrflPendenteDevolucao,
    localizacaoArmazemPorTipoConn,
    computeDestLocFerrNormal,
    mergeRequisicaoItensSeriaisFromChildTable,
    logStockMovimento,
    extractSeriaisLinhasFromItemBody,
    dedupeSeriaisLinhasPorSerial,
    armazemMovimentacaoInternaTableExists,
    buildExcelReporte,
    buildRecebimentoMercadoriaReporteRows,
    buildRecebimentoMercadoriaReporteRowsDetalhado,
    formatarNumeroTraDev,
    LOCALIZACAO_RECEBIMENTO_FALLBACK,
    RECEBIMENTO_TRANSFERENCIA_MARKER,
    DEV_RECEBIMENTO_STOCK_APLICADO_MARKER,
    DEV_APEADOS_STOCK_PENDENTE_MARKER: DEV_APEADOS_STOCK_PENDENTE_MARKER,
    DEV_TRFL_PENDENTE_STOCK_MARKER: DEV_TRFL_PENDENTE_STOCK_MARKER,
    TRFL_PENDENTE_LOC_TAG: TRFL_PENDENTE_LOC_TAG,
    RECEBIMENTO_MONITOR_CLEAR_TEST_MARKER,
    SQL_LISTA_CRIADOR_E_SEPARADOR,
    isFluxoDevolucaoViaturaCentral,
    RECEBIMENTO_TRANSFERENCIA_MARKER,
  });



router.get('/movimentos-clog/consulta', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
  try {
    const roleNorm = String(req.user?.role || '').trim().toLowerCase();
    const roleTemAcessoDashboardOp = roleNorm === 'admin' || roleNorm === 'backoffice_operations';
    if (!usuarioTemPermissaoConsultaMovimentos(req) && !roleTemAcessoDashboardOp) {
      return res.status(403).json({ error: 'Sem permissão para consultar movimentos.' });
    }
    const q = String(req.query?.q || '').trim().toLowerCase();
    const dataInicio = String(req.query?.data_inicio || '').trim();
    const dataFim = String(req.query?.data_fim || '').trim();
    const tipoMovimento = String(req.query?.tipo_movimento || '').trim().toLowerCase();
    const traNumero = String(req.query?.tra_numero || '').trim().toLowerCase();
    const ref = String(req.query?.ref || '').trim().toLowerCase();
    const description = String(req.query?.description || '').trim().toLowerCase();
    const serial = String(req.query?.serial || '').trim().toLowerCase();
    const lote = String(req.query?.lote || '').trim().toLowerCase();
    const armazem = String(req.query?.armazem || '').trim().toLowerCase();
    const armazemIdFiltroRaw = Number(req.query?.armazem_id || 0);
    const armazemIdFiltro = Number.isFinite(armazemIdFiltroRaw) && armazemIdFiltroRaw > 0
      ? armazemIdFiltroRaw
      : null;
    const localizacao = String(req.query?.localizacao || '').trim().toLowerCase();
    const apenasMinhas = String(req.query?.minhas || '').trim() === '1';
    const pageSizeRaw = parseInt(String(req.query?.page_size || '40'), 10);
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.max(1, Math.min(pageSizeRaw, 40)) : 40;
    const startOffsetRaw = parseInt(String(req.query?.offset || '0'), 10);
    const startOffset = Number.isFinite(startOffsetRaw) ? Math.max(0, startOffsetRaw) : 0;
    const reqBatchSize = 200;
    const maxBatches = 25;
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'Observações', 'DEP'];
    const allowedScopeIds = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];

    const anexarDescricaoArmazens = async (rowsIn) => {
      const rowsList = Array.isArray(rowsIn) ? rowsIn : [];
      if (!rowsList.length) return { rows: rowsList, metaByReqId: new Map() };
      const reqIds = [...new Set(
        rowsList
          .map((r) => Number(r?.requisicao_id || 0))
          .filter((n) => Number.isFinite(n) && n > 0)
      )];
      if (!reqIds.length) return { rows: rowsList, metaByReqId: new Map() };
      const metaQ = await pool.query(
        `SELECT r.id,
                r.status,
                r.observacoes,
                r.tra_gerada_em,
                r.tra_numero,
                r.devolucao_tra_gerada_em,
                r.armazem_origem_id,
                r.armazem_id,
                ao.codigo AS armazem_origem_codigo,
                ao.descricao AS armazem_origem_descricao,
                ao.tipo AS armazem_origem_tipo,
                ad.codigo AS armazem_destino_codigo,
                ad.descricao AS armazem_destino_descricao,
                ad.tipo AS armazem_destino_tipo
         FROM requisicoes r
         LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
         LEFT JOIN armazens ad ON ad.id = r.armazem_id
         WHERE r.id = ANY($1::int[])`,
        [reqIds]
      );
      const byReqId = new Map((metaQ.rows || []).map((m) => [Number(m.id), m]));
      const armIds = [...new Set(
        rowsList
          .flatMap((r) => [Number(r?.armazem_origem_id || 0), Number(r?.armazem_id || 0)])
          .filter((n) => Number.isFinite(n) && n > 0)
      )];
      let byArmId = new Map();
      if (armIds.length) {
        const armQ = await pool.query(
          `SELECT id, codigo, descricao
           FROM armazens
           WHERE id = ANY($1::int[])`,
          [armIds]
        );
        byArmId = new Map((armQ.rows || []).map((a) => [Number(a.id), a]));
      }
      const enriched = rowsList.map((row) => {
        const rid = Number(row?.requisicao_id || 0);
        const meta = byReqId.get(rid);
        const obsRow = String(row?.Observações || meta?.observacoes || '').toUpperCase();
        const isRecebMerc = obsRow.startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
        const rowOrigemId = Number(row?.armazem_origem_id || 0);
        const rowDestinoId = Number(row?.armazem_id || 0);
        let origemId = rowOrigemId;
        let destinoId = rowDestinoId;
        if (!origemId || !destinoId) {
          if (isRecebMerc && meta) {
            origemId = origemId || Number(meta.armazem_id || 0);
            destinoId = destinoId || Number(meta.armazem_origem_id || 0);
          } else if (meta) {
            origemId = origemId || Number(meta.armazem_origem_id || 0);
            destinoId = destinoId || Number(meta.armazem_id || 0);
          }
        }
        const armOrigem = origemId ? byArmId.get(origemId) : null;
        const armDestino = destinoId ? byArmId.get(destinoId) : null;
        const codigoOrigem =
          String(armOrigem?.codigo || '').trim() ||
          String(row?.armazem_origem_codigo || '').trim() ||
          (isRecebMerc ? String(meta?.armazem_destino_codigo || '').trim() : String(meta?.armazem_origem_codigo || '').trim());
        const codigoDestino =
          String(armDestino?.codigo || '').trim() ||
          String(row?.armazem_destino_codigo || '').trim() ||
          (isRecebMerc ? String(meta?.armazem_origem_codigo || '').trim() : String(meta?.armazem_destino_codigo || '').trim());
        const descricaoOrigem =
          String(armOrigem?.descricao || '').trim() ||
          (isRecebMerc ? String(meta?.armazem_destino_descricao || '').trim() : String(meta?.armazem_origem_descricao || '').trim());
        const descricaoDestino =
          String(armDestino?.descricao || '').trim() ||
          (isRecebMerc ? String(meta?.armazem_origem_descricao || '').trim() : String(meta?.armazem_destino_descricao || '').trim());
        const withTipos = {
          ...row,
          armazem_origem_id: origemId || null,
          armazem_id: destinoId || null,
          armazem_origem_codigo: codigoOrigem,
          armazem_destino_codigo: codigoDestino,
          armazem_origem_descricao: descricaoOrigem,
          armazem_destino_descricao: descricaoDestino,
          armazem_origem_tipo: String(
            row.armazem_origem_tipo ||
              (meta
                ? isRecebMerc
                  ? meta.armazem_destino_tipo
                  : meta.armazem_origem_tipo
                : '') ||
              ''
          ).trim(),
          armazem_destino_tipo: String(
            row.armazem_destino_tipo ||
              (meta
                ? isRecebMerc
                  ? meta.armazem_origem_tipo
                  : meta.armazem_destino_tipo
                : '') ||
              ''
          ).trim(),
        };
        return normalizarTipoMovimentoClogDevolucao(withTipos);
      });
      return { rows: enriched, metaByReqId: byReqId };
    };

    if (!isAdmin(req.user?.role) && armazemIdFiltro && !allowedScopeIds.includes(armazemIdFiltro)) {
      return res.status(403).json({ error: 'Armazém fora do escopo do utilizador.' });
    }

    const rowMatchesArmazemFiltro = (row) => {
      if (!armazemIdFiltro) return true;
      const origemId = Number(row?.armazem_origem_id);
      const destinoId = Number(row?.armazem_id);
      return origemId === armazemIdFiltro || destinoId === armazemIdFiltro;
    };

    const normalizarTransferenciaCentralCentral = (row) => {
      if (!row || typeof row !== 'object') return row;
      const origemTipo = String(row?.armazem_origem_tipo || '').toLowerCase();
      const destinoTipo = String(row?.armazem_destino_tipo || '').toLowerCase();
      if (origemTipo !== 'central' || destinoTipo !== 'central') return row;
      const tipoAtual = String(row?.['Tipo de Movimento'] || '').trim().toLowerCase();
      if (
        tipoAtual === 'devolucao de carrinha' ||
        tipoAtual === 'devolucao epi' ||
        tipoAtual === 'apeados'
      ) {
        return row;
      }
      let qty = Number(row?.QTY);
      if (!Number.isFinite(qty)) qty = 0;
      if (armazemIdFiltro) {
        const origemId = Number(row?.armazem_origem_id);
        const destinoId = Number(row?.armazem_id);
        if (destinoId === armazemIdFiltro && origemId !== armazemIdFiltro) {
          qty = Math.abs(qty);
        } else if (origemId === armazemIdFiltro && destinoId !== armazemIdFiltro) {
          qty = -Math.abs(qty);
        }
      }
      return {
        ...row,
        'Tipo de Movimento': 'Transferencia',
        QTY: qty,
      };
    };

    // Histórico persistido (independente da tabela requisicoes) é a fonte primária quando existir.
    if (await movimentosHistoricoTableExists()) {
      const passesScopeHistorico = (row) => {
        if (isAdmin(req.user?.role)) return true;
        if (allowedScopeIds.length === 0) return false;
        const origemId = Number(row?.armazem_origem_id);
        const destinoId = Number(row?.armazem_id);
        const origemTipo = String(row?.armazem_origem_tipo || '').toLowerCase();
        const destinoTipo = String(row?.armazem_destino_tipo || '').toLowerCase();
        const observacoesRow = String(row?.Observações || '').toUpperCase();
        const isRecebimentoTransfer = observacoesRow.startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
        const devolucaoParaCentral =
          isFluxoDevolucaoParaCentral(origemTipo, destinoTipo) ||
          (String(destinoTipo).toLowerCase() === 'central' &&
            armazemOrigemEhEpi(
              origemTipo,
              row?.armazem_origem_codigo,
              row?.armazem_origem_descricao
            ));
        if (devolucaoParaCentral) {
          return Number.isFinite(destinoId) && allowedScopeIds.includes(destinoId);
        }
        // Recebimento de transferência: o armazém "lógico" do utilizador pode estar em armazem_id.
        if (isRecebimentoTransfer && Number.isFinite(destinoId)) {
          return allowedScopeIds.includes(destinoId);
        }
        if (Number.isFinite(origemId)) return allowedScopeIds.includes(origemId);
        // Compatibilidade com snapshots antigos (sem metadados de escopo):
        // não bloquear para evitar "sumir" após apagar a requisição original.
        return true;
      };

      const passesRowFilter = (row) => {
        const tipoOk = !tipoMovimento || String(row['Tipo de Movimento'] || '').toLowerCase().includes(tipoMovimento);
        const refOk = !ref || String(row['REF.'] || '').toLowerCase().includes(ref);
        const descOk = !description || String(row.DESCRIPTION || '').toLowerCase().includes(description);
        const serialOk = !serial || String(row['S/N'] || '').toLowerCase().includes(serial);
        const loteOk = !lote || String(row.Lote || '').toLowerCase().includes(lote);
        const armOk = !armazem || String(row['Novo Armazém'] || '').toLowerCase().includes(armazem);
        const armIdOk = rowMatchesArmazemFiltro(row);
        const locOk =
          !localizacao ||
          String(row.Loc_Inicial || '').toLowerCase().includes(localizacao) ||
          String(row['New Localização'] || '').toLowerCase().includes(localizacao);
        const traOk = !traNumero || String(row['TRA / DEV'] || '').toLowerCase().includes(traNumero);
        const dtOk = (() => {
          if (!dataInicio && !dataFim) return true;
          const s = String(row['Dt_Recepção'] || '').trim();
          const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
          if (!m) return false;
          const iso = `${m[3]}-${m[2]}-${m[1]}`;
          if (dataInicio && iso < dataInicio) return false;
          if (dataFim && iso > dataFim) return false;
          return true;
        })();
        const minhasOk = !apenasMinhas || Number(row?.usuario_id) === Number(req.user?.id);
        const qOk =
          !q ||
          [
            row['Tipo de Movimento'],
            row['Dt_Recepção'],
            row['REF.'],
            row.DESCRIPTION,
            row.QTY,
            row.Loc_Inicial,
            row['S/N'],
            row.Lote,
            row['Novo Armazém'],
            row['TRA / DEV'],
            row['New Localização'],
            row.DEP,
            row.Observações,
          ].some((v) => String(v || '').toLowerCase().includes(q));
        return Boolean(tipoOk && refOk && descOk && serialOk && loteOk && armOk && armIdOk && locOk && traOk && dtOk && minhasOk && qOk);
      };

      const outRows = [];
      let histOffset = startOffset;
      let reachedEnd = false;
      let batches = 0;
      const histBatchSize = 1200;
      while (outRows.length < pageSize && !reachedEnd && batches < maxBatches) {
        const hr = await pool.query(
          `SELECT row_data
           FROM requisicoes_movimentos_historico
           ORDER BY
             (
               CASE
                 WHEN TRIM(COALESCE(row_data->>'Dt_Recepção', '')) ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                 THEN to_date(TRIM(row_data->>'Dt_Recepção'), 'DD/MM/YYYY')
                 ELSE NULL
               END
             ) DESC NULLS LAST,
             id DESC
           LIMIT $1 OFFSET $2`,
          [histBatchSize, histOffset]
        );
        const batch = Array.isArray(hr.rows) ? hr.rows : [];
        if (!batch.length) {
          reachedEnd = true;
          break;
        }
        const parsedSlots = batch.map((x) =>
          x.row_data && typeof x.row_data === 'object' ? x.row_data : null
        );
        const mergedSlots = await applyMovimentosOverridesPreserveLength(parsedSlots);
        const indexedNorm = [];
        for (let i = 0; i < mergedSlots.length; i++) {
          const slot = mergedSlots[i];
          const normRow =
            slot && typeof slot === 'object'
              ? normalizarTipoMovimentoClogDevolucao(normalizarTransferenciaCentralCentral(slot))
              : null;
          if (normRow) indexedNorm.push({ idx: i, row: normRow });
        }
        const enrichedList =
          indexedNorm.length > 0
            ? await enriquecerClogRastreioVazioComDadosAoVivo(indexedNorm.map((x) => x.row))
            : [];
        const batchStart = histOffset;
        let filledPageThisBatch = false;
        for (let j = 0; j < indexedNorm.length; j++) {
          const { idx, row: baseRow } = indexedNorm[j];
          const row = enrichedList[j] || baseRow;
          if (!passesScopeHistorico(row)) continue;
          if (!passesRowFilter(row)) continue;
          outRows.push(row);
          if (outRows.length >= pageSize) {
            histOffset = batchStart + idx + 1;
            filledPageThisBatch = true;
            break;
          }
        }
        if (!filledPageThisBatch) {
          histOffset = batchStart + batch.length;
          if (batch.length < histBatchSize) reachedEnd = true;
        }
        batches += 1;
      }

      const parseDateBr = (v) => {
        const s = String(v || '').trim();
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
        if (!m) return 0;
        const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
      };
      outRows.sort((a, b) => {
        const tipoTxtA = String(a['Tipo de Movimento'] || '').trim().toLowerCase();
        const tipoTxtB = String(b['Tipo de Movimento'] || '').trim().toLowerCase();
        const isParDevolucaoApeado =
          (tipoTxtA === 'transf. apeado' &&
            (tipoTxtB === 'devolucao de carrinha' || tipoTxtB === 'devolucao epi')) ||
          ((tipoTxtA === 'devolucao de carrinha' || tipoTxtA === 'devolucao epi') &&
            tipoTxtB === 'transf. apeado');
        if (isParDevolucaoApeado) {
          const reqA = Number(a.requisicao_id || 0);
          const reqB = Number(b.requisicao_id || 0);
          if (reqA === reqB) {
            return tipoTxtA === 'transf. apeado' ? -1 : 1;
          }
        }
        const dA = parseDateBr(a['Dt_Recepção']);
        const dB = parseDateBr(b['Dt_Recepção']);
        if (dA !== dB) return dB - dA;
        const tsA = Number(a.__req_sort_ts || 0);
        const tsB = Number(b.__req_sort_ts || 0);
        if (tsA !== tsB) return tsB - tsA;
        const traA = String(a['TRA / DEV'] || '');
        const traB = String(b['TRA / DEV'] || '');
        const traCmp = traB.localeCompare(traA);
        if (traCmp !== 0) return traCmp;
        const tipoA = ordemTipoMovimentoClog(a['Tipo de Movimento']);
        const tipoB = ordemTipoMovimentoClog(b['Tipo de Movimento']);
        if (tipoA !== tipoB) return tipoA - tipoB;
        const ordA = Number(a.__ordem_movimento || 9);
        const ordB = Number(b.__ordem_movimento || 9);
        if (ordA !== ordB) return ordA - ordB;
        const refA = String(a['REF.'] || '');
        const refB = String(b['REF.'] || '');
        const refCmp = refA.localeCompare(refB);
        if (refCmp !== 0) return refCmp;
        const reqA = Number(a.requisicao_id || 0);
        const reqB = Number(b.requisicao_id || 0);
        if (reqA !== reqB) return reqB - reqA;
        return 0;
      });
      const { rows: outRowsComMeta, metaByReqId } = await anexarDescricaoArmazens(outRows);
      const outRowsTraFiltradas = filtrarLinhasMovimentoConsulta(outRowsComMeta, metaByReqId);
      const outRowsComTraApeados = await normalizarTraDevTransfApeado(outRowsTraFiltradas);
      const outRowsClean = (await normalizarObservacoesConsultaMovimentos(outRowsComTraApeados)).map(
        ({
          __ordem_movimento,
          mov_id,
          requisicao_id,
          __req_sort_ts,
          ...rest
        }) => {
          return {
            ...rest,
            mov_id,
            requisicao_id,
          };
        }
      );
      const nextOffset = reachedEnd || outRows.length < pageSize ? null : histOffset;
      return res.json({
        columns,
        rows: outRowsClean,
        total: outRowsClean.length,
        offset: startOffset,
        next_offset: nextOffset,
        has_more: nextOffset !== null,
      });
    }

    const where = [];
    const params = [];
    let idx = 1;
    const add = (sqlPart, value) => {
      where.push(sqlPart.replace('?', `$${idx}`));
      params.push(value);
      idx += 1;
    };

    // Requisições aptas para Clog na consulta.
    // Devoluções podem não ter tra_numero clássico; usar marcador DEV como elegível.
    where.push(`(
      COALESCE(TRIM(r.tra_numero), '') <> ''
      OR r.devolucao_tra_gerada_em IS NOT NULL
    )`);
    where.push(`(
      r.status = 'FINALIZADO'
      OR (r.status = 'Entregue' AND (r.tra_gerada_em IS NOT NULL OR r.devolucao_tra_gerada_em IS NOT NULL))
      OR (
        r.status = 'APEADOS'
        AND r.devolucao_tra_gerada_em IS NOT NULL
        AND r.devolucao_tra_apeados_gerada_em IS NOT NULL
        AND COALESCE(TRIM(r.devolucao_tra_apeados_numero), '') <> ''
      )
    )`);

    if (apenasMinhas && Number.isFinite(Number(req.user?.id))) {
      add('r.usuario_id = ?', Number(req.user.id));
    }
    if (dataInicio) {
      add(`COALESCE(r.tra_gerada_em, r.updated_at, r.created_at)::date >= ?::date`, dataInicio);
    }
    if (dataFim) {
      add(`COALESCE(r.tra_gerada_em, r.updated_at, r.created_at)::date <= ?::date`, dataFim);
    }
    if (traNumero) {
      add(`LOWER(COALESCE(r.tra_numero, '')) LIKE ?`, `%${traNumero}%`);
    }

    if (!isAdmin(req.user?.role)) {
      if (allowedScopeIds.length === 0) {
        return res.json({
          columns,
          rows: [],
          total: 0,
          offset: startOffset,
          next_offset: null,
          has_more: false,
        });
      }
      // Mesmo scope das listagens de requisições:
      // - regra base: armazém de origem atribuído ao utilizador
      // - devolução viatura/EPI -> central: scope pelo armazém central destino (r.armazem_id)
      where.push(`(
        (r.armazem_origem_id IS NOT NULL AND r.armazem_origem_id = ANY($${idx}::int[]))
        OR (
          EXISTS (SELECT 1 FROM armazens ao WHERE ao.id = r.armazem_origem_id AND LOWER(TRIM(COALESCE(ao.tipo, ''))) = 'viatura')
          AND EXISTS (SELECT 1 FROM armazens ad WHERE ad.id = r.armazem_id AND LOWER(TRIM(COALESCE(ad.tipo, ''))) = 'central')
          AND r.armazem_id = ANY($${idx + 1}::int[])
        )
        OR (
          EXISTS (
            SELECT 1 FROM armazens ao
            WHERE ao.id = r.armazem_origem_id
              AND (
                LOWER(TRIM(COALESCE(ao.tipo, ''))) = 'epi'
                OR UPPER(COALESCE(ao.codigo, '')) LIKE '%EPI%'
                OR UPPER(COALESCE(ao.descricao, '')) LIKE '%EPI%'
              )
          )
          AND EXISTS (SELECT 1 FROM armazens ad WHERE ad.id = r.armazem_id AND LOWER(TRIM(COALESCE(ad.tipo, ''))) = 'central')
          AND r.armazem_id = ANY($${idx + 1}::int[])
        )
      )`);
      params.push(allowedScopeIds, allowedScopeIds);
      idx += 2;
    }

    const passesRowFilter = (row) => {
      const tipoOk = !tipoMovimento || String(row['Tipo de Movimento'] || '').toLowerCase().includes(tipoMovimento);
      const refOk = !ref || String(row['REF.'] || '').toLowerCase().includes(ref);
      const descOk = !description || String(row.DESCRIPTION || '').toLowerCase().includes(description);
      const serialOk = !serial || String(row['S/N'] || '').toLowerCase().includes(serial);
      const loteOk = !lote || String(row.Lote || '').toLowerCase().includes(lote);
      const armOk = !armazem || String(row['Novo Armazém'] || '').toLowerCase().includes(armazem);
      const armIdOk = rowMatchesArmazemFiltro(row);
      const locOk =
        !localizacao ||
        String(row.Loc_Inicial || '').toLowerCase().includes(localizacao) ||
        String(row['New Localização'] || '').toLowerCase().includes(localizacao);
      const qOk =
        !q ||
        [
          row['Tipo de Movimento'],
          row['Dt_Recepção'],
          row['REF.'],
          row.DESCRIPTION,
          row.QTY,
          row.Loc_Inicial,
          row['S/N'],
          row.Lote,
          row['Novo Armazém'],
          row['TRA / DEV'],
          row['New Localização'],
          row.DEP,
          row.Observações,
        ].some((v) => String(v || '').toLowerCase().includes(q));
      return Boolean(tipoOk && refOk && descOk && serialOk && loteOk && armOk && armIdOk && locOk && qOk);
    };

    const outRows = [];
    let reqOffset = startOffset;
    let reachedEnd = false;
    let batches = 0;

    while (outRows.length < pageSize && !reachedEnd && batches < maxBatches) {
      const reqSql = `
        SELECT r.id, r.tra_gerada_em, r.updated_at, r.created_at
        FROM requisicoes r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(r.tra_gerada_em, r.updated_at, r.created_at) DESC, r.id DESC
        LIMIT ${reqBatchSize} OFFSET ${reqOffset}
      `;
      const reqRows = await pool.query(reqSql, params);
      const reqBatch = Array.isArray(reqRows.rows) ? reqRows.rows : [];
      if (reqBatch.length === 0) {
        reachedEnd = true;
        break;
      }

      const ids = reqBatch.map((r) => Number(r.id)).filter(Number.isFinite);
      const dateById = new Map(
        reqBatch.map((r) => [
          Number(r.id),
          formatDateBR(new Date(r.tra_gerada_em || r.updated_at || r.created_at || Date.now())),
        ])
      );

      const histRows = await fetchMovimentosHistoricoByReqIds(ids);
      const histReqIds = new Set(histRows.map((x) => Number(x.requisicao_id)).filter(Number.isFinite));
      const missingIds = ids.filter((rid) => !histReqIds.has(Number(rid)));

      let rowsMissing = [];
      if (missingIds.length > 0) {
        rowsMissing = await buildClogRowsForRequisicaoIds(
          missingIds,
          (r) => dateById.get(Number(r?.id)) || formatDateBR(new Date()),
          { withOverrides: false }
        );
        await upsertMovimentosHistorico(rowsMissing);
      }

      let rows = [...histRows, ...rowsMissing];
      rows = (await applyMovimentosOverrides(rows))
        .map((r) => ({
          ...r,
          Observações: r?.Observações == null ? '' : r.Observações,
        }))
        .map((r) => normalizarTipoMovimentoClogDevolucao(normalizarTransferenciaCentralCentral(r)));
      rows = await enriquecerClogRastreioVazioComDadosAoVivo(rows);
      for (const row of rows) {
        if (!passesRowFilter(row)) continue;
        outRows.push(row);
        if (outRows.length >= pageSize) break;
      }

      reqOffset += reqBatch.length;
      if (reqBatch.length < reqBatchSize) reachedEnd = true;
      batches += 1;
    }

    const parseDateBr = (v) => {
      const s = String(v || '').trim();
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
      if (!m) return 0;
      const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
    };
    outRows.sort((a, b) => {
      const tipoTxtA = String(a['Tipo de Movimento'] || '').trim().toLowerCase();
      const tipoTxtB = String(b['Tipo de Movimento'] || '').trim().toLowerCase();
      const isParDevolucaoApeado =
        (tipoTxtA === 'transf. apeado' &&
          (tipoTxtB === 'devolucao de carrinha' || tipoTxtB === 'devolucao epi')) ||
        ((tipoTxtA === 'devolucao de carrinha' || tipoTxtA === 'devolucao epi') &&
          tipoTxtB === 'transf. apeado');
      if (isParDevolucaoApeado) {
        const reqA = Number(a.requisicao_id || 0);
        const reqB = Number(b.requisicao_id || 0);
        if (reqA === reqB) {
          return tipoTxtA === 'transf. apeado' ? -1 : 1;
        }
      }
      const dA = parseDateBr(a['Dt_Recepção']);
      const dB = parseDateBr(b['Dt_Recepção']);
      if (dA !== dB) return dB - dA;
      const tsA = Number(a.__req_sort_ts || 0);
      const tsB = Number(b.__req_sort_ts || 0);
      if (tsA !== tsB) return tsB - tsA;
      const traA = String(a['TRA / DEV'] || '');
      const traB = String(b['TRA / DEV'] || '');
      const traCmp = traB.localeCompare(traA);
      if (traCmp !== 0) return traCmp;
      const tipoA = ordemTipoMovimentoClog(a['Tipo de Movimento']);
      const tipoB = ordemTipoMovimentoClog(b['Tipo de Movimento']);
      if (tipoA !== tipoB) return tipoA - tipoB;
      const ordA = Number(a.__ordem_movimento || 9);
      const ordB = Number(b.__ordem_movimento || 9);
      if (ordA !== ordB) return ordA - ordB;
      const refA = String(a['REF.'] || '');
      const refB = String(b['REF.'] || '');
      const refCmp = refA.localeCompare(refB);
      if (refCmp !== 0) return refCmp;
      const reqA = Number(a.requisicao_id || 0);
      const reqB = Number(b.requisicao_id || 0);
      if (reqA !== reqB) return reqB - reqA;
      return 0;
    });
    const { rows: outRowsComMeta, metaByReqId } = await anexarDescricaoArmazens(outRows);
    const outRowsTraFiltradas = filtrarLinhasMovimentoConsulta(outRowsComMeta, metaByReqId);
    const outRowsComTraApeados = await normalizarTraDevTransfApeado(outRowsTraFiltradas);
    const outRowsClean = (await normalizarObservacoesConsultaMovimentos(outRowsComTraApeados)).map(
      ({ __ordem_movimento, __req_sort_ts, ...rest }) => rest
    );

    const nextOffset = reachedEnd || outRows.length < pageSize ? null : reqOffset;
    return res.json({
      columns,
      rows: outRowsClean,
      total: outRowsClean.length,
      offset: startOffset,
      next_offset: nextOffset,
      has_more: nextOffset !== null,
    });
  } catch (error) {
    console.error('Erro ao consultar movimentos Clog:', error);
    return res.status(500).json({ error: 'Erro ao consultar movimentos', details: error.message });
  }
});

router.patch('/movimentos-clog/linha', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ error: 'Apenas admin pode editar linhas de movimento.' });
    }
    if (!(await movimentosOverridesTableExists())) {
      return res.status(503).json({
        error: 'Tabela de overrides de movimentos em falta.',
        details: 'Execute: npm run db:migrate:requisicoes-movimentos-overrides'
      });
    }
    const movId = String(req.body?.mov_id || '').trim();
    const patchIn = req.body?.patch;
    if (!movId) return res.status(400).json({ error: 'mov_id é obrigatório.' });
    if (!patchIn || typeof patchIn !== 'object' || Array.isArray(patchIn)) {
      return res.status(400).json({ error: 'patch inválido.' });
    }
    const allowed = new Set([
      'Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N',
      'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'Observações', 'DEP'
    ]);
    const cleanPatch = {};
    for (const [k, v] of Object.entries(patchIn)) {
      if (!allowed.has(k)) continue;
      cleanPatch[k] = v == null ? '' : v;
    }
    await pool.query(
      `INSERT INTO requisicoes_movimentos_overrides (mov_key, patch, deleted, updated_by, updated_at)
       VALUES ($1, $2::jsonb, false, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (mov_key)
       DO UPDATE SET
         patch = COALESCE(requisicoes_movimentos_overrides.patch, '{}'::jsonb) || EXCLUDED.patch,
         deleted = false,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [movId, JSON.stringify(cleanPatch), req.user?.id || null]
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao editar linha de movimento', details: error.message });
  }
});

router.post('/movimentos-clog/linha', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const roleNorm = String(req.user?.role || '').trim().toLowerCase();
    const podeCriarLinhaManual = isAdmin(req.user?.role) || roleNorm === 'supervisor_armazem';
    if (!podeCriarLinhaManual) {
      return res.status(403).json({ error: 'Apenas admin e supervisor de armazém podem adicionar linhas.' });
    }
    if (!(await movimentosHistoricoTableExists())) {
      return res.status(503).json({
        error: 'Tabela de histórico de movimentos em falta.',
        details: 'Execute: npm run db:migrate:requisicoes-movimentos-historico'
      });
    }

    const parseDateBr = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return '';
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
      const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
      if (br) return `${br[1]}/${br[2]}/${br[3]}`;
      return '';
    };
    const normalizeTipoMov = (raw) => {
      const t = String(raw || '').trim().toLowerCase();
      if (!t) return { tipo: '', sign: 1 };
      if (t === 'saida' || t === 'saída' || t === 'saida de armazem' || t === 'saída de armazém') {
        return { tipo: 'Saida de Armazem', sign: -1 };
      }
      if (t === 'transferencia' || t === 'transferência') {
        return { tipo: 'Transferencia', sign: 1 };
      }
      if (t === 'transf. apeado' || t === 'transf apeado' || t === 'apeado') {
        return { tipo: 'Transf. Apeado', sign: 1 };
      }
      if (t === 'devolucao epi' || t === 'devolução epi') {
        return { tipo: CLOG_TIPO_DEVOLUCAO_EPI, sign: 1 };
      }
      if (t === 'devolucao de carrinha' || t === 'devolução de carrinha') {
        return { tipo: CLOG_TIPO_DEVOLUCAO_CARRINHA, sign: 1 };
      }
      if (t === 'devolucao' || t === 'devolução') {
        return { tipo: CLOG_TIPO_DEVOLUCAO_CARRINHA, sign: 1 };
      }
      return { tipo: '', sign: 1 };
    };
    const formatTraDevByTipo = (rawValue, tipoMovimentoCanonical) => {
      const tipo = String(tipoMovimentoCanonical || '').trim().toLowerCase();
      const prefix =
        tipo === 'devolucao de carrinha' || tipo === 'devolucao epi' ? 'DEV' : 'TRA';
      const raw = String(rawValue || '').trim();
      if (!raw) return '';
      const semPrefixo = raw.replace(/^(TRA|DEV)\s*/i, '').trim();
      const year = String(new Date().getFullYear());
      const onlyDigits = semPrefixo.replace(/[^\d]/g, '');
      if (!semPrefixo) return '';
      if (/^\d+$/.test(semPrefixo)) return `${prefix} ${semPrefixo}/${year}`;
      if (/^\d+\/\d{4}$/.test(semPrefixo)) return `${prefix} ${semPrefixo}`;
      if (onlyDigits) return `${prefix} ${onlyDigits}/${year}`;
      return `${prefix} ${semPrefixo}`;
    };

    const tipoIn = req.body?.tipo_movimento;
    const dataIn = req.body?.data_movimento;
    const itemId = Number(req.body?.item_id || 0);
    const qtdIn = Number(req.body?.quantidade);
    const armazemOrigemId = Number(req.body?.armazem_origem_id || 0);
    const locInicial = String(req.body?.loc_inicial || '').trim();
    const serial = String(req.body?.serial || '').trim();
    const lote = String(req.body?.lote || '').trim();
    const armazemDestinoId = Number(req.body?.novo_armazem_id || 0);
    const traDevRaw = String(req.body?.tra_dev || '').trim();
    const newLocalizacao = String(req.body?.new_localizacao || '').trim();
    const observacoes = String(req.body?.observacoes || '').trim();
    const dep = String(req.body?.dep || '').trim();

    const { tipo: tipoMovimento, sign: tipoSign } = normalizeTipoMov(tipoIn);
    if (!tipoMovimento) {
      return res.status(400).json({ error: 'Tipo de movimento inválido.' });
    }
    const dtRecepcao = parseDateBr(dataIn);
    if (!dtRecepcao) {
      return res.status(400).json({ error: 'Data inválida. Use YYYY-MM-DD ou DD/MM/YYYY.' });
    }
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Artigo inválido.' });
    }
    if (!Number.isFinite(qtdIn) || qtdIn === 0) {
      return res.status(400).json({ error: 'Quantidade inválida.' });
    }
    if (!Number.isFinite(armazemOrigemId) || armazemOrigemId <= 0) {
      return res.status(400).json({ error: 'Armazém de origem é obrigatório.' });
    }
    if (!locInicial) {
      return res.status(400).json({ error: 'Loc inicial é obrigatória.' });
    }
    if (!Number.isFinite(armazemDestinoId) || armazemDestinoId <= 0) {
      return res.status(400).json({ error: 'Novo armazém é obrigatório.' });
    }
    const traDev = formatTraDevByTipo(traDevRaw, tipoMovimento);
    if (!traDev) {
      return res.status(400).json({ error: 'TRA / DEV é obrigatório.' });
    }
    if (!newLocalizacao) {
      return res.status(400).json({ error: 'Nova localização é obrigatória.' });
    }

    if (!isAdmin(req.user?.role)) {
      const allowedScopeIds = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
      if (!allowedScopeIds.includes(armazemOrigemId)) {
        return res.status(403).json({ error: 'Armazém de origem fora do escopo do utilizador.' });
      }
      if (!allowedScopeIds.includes(armazemDestinoId)) {
        return res.status(403).json({ error: 'Armazém fora do escopo do utilizador.' });
      }
    }

    const itemQ = await pool.query(
      `SELECT id, codigo, descricao, tipocontrolo
       FROM itens
       WHERE id = $1
       LIMIT 1`,
      [itemId]
    );
    if (itemQ.rows.length === 0) {
      return res.status(404).json({ error: 'Artigo não encontrado.' });
    }
    const item = itemQ.rows[0];
    const tipoControlo = String(item?.tipocontrolo || '').trim().toUpperCase();
    if (tipoControlo === 'SERIAL' && !serial) {
      return res.status(400).json({ error: 'S/N é obrigatório para artigo de controlo serial.' });
    }
    if (tipoControlo === 'LOTE' && !lote) {
      return res.status(400).json({ error: 'Lote é obrigatório para artigo de controlo lote.' });
    }

    const armOrigemQ = await pool.query(
      `SELECT id, codigo, descricao, tipo
       FROM armazens
       WHERE id = $1
       LIMIT 1`,
      [armazemOrigemId]
    );
    if (armOrigemQ.rows.length === 0) {
      return res.status(404).json({ error: 'Armazém de origem não encontrado.' });
    }
    const armOrigem = armOrigemQ.rows[0];

    const armQ = await pool.query(
      `SELECT id, codigo, descricao, tipo
       FROM armazens
       WHERE id = $1
       LIMIT 1`,
      [armazemDestinoId]
    );
    if (armQ.rows.length === 0) {
      return res.status(404).json({ error: 'Novo armazém não encontrado.' });
    }
    const arm = armQ.rows[0];
    const qtyFinal = tipoSign < 0 ? -Math.abs(qtdIn) : Math.abs(qtdIn);
    const movId = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const rowData = {
      mov_id: movId,
      mov_manual: true,
      usuario_id: req.user?.id || null,
      requisicao_id: null,
      'Tipo de Movimento': tipoMovimento,
      'Dt_Recepção': dtRecepcao,
      'REF.': String(item?.codigo || '').trim(),
      DESCRIPTION: String(item?.descricao || '').trim(),
      QTY: qtyFinal,
      Loc_Inicial: locInicial,
      'S/N': serial,
      Lote: lote,
      'Novo Armazém': String(arm?.codigo || arm?.descricao || '').trim(),
      'TRA / DEV': traDev,
      'New Localização': newLocalizacao,
      Observações: observacoes,
      DEP: dep,
      armazem_origem_id: Number(armOrigem.id),
      armazem_origem_codigo: String(armOrigem?.codigo || '').trim(),
      armazem_origem_descricao: String(armOrigem?.descricao || '').trim(),
      armazem_origem_tipo: String(armOrigem?.tipo || '').trim().toLowerCase(),
      armazem_id: Number(arm.id),
      armazem_destino_codigo: String(arm?.codigo || '').trim(),
      armazem_destino_descricao: String(arm?.descricao || '').trim(),
      armazem_destino_tipo: String(arm?.tipo || '').trim().toLowerCase(),
    };

    await pool.query(
      `INSERT INTO requisicoes_movimentos_historico (mov_key, requisicao_id, row_data, updated_at)
       VALUES ($1, NULL, $2::jsonb, CURRENT_TIMESTAMP)`,
      [movId, JSON.stringify(rowData)]
    );

    return res.status(201).json({ ok: true, row: rowData });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao adicionar linha de movimento', details: error.message });
  }
});

router.delete('/movimentos-clog/linha', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ error: 'Apenas admin pode apagar linhas de movimento.' });
    }
    if (!(await movimentosOverridesTableExists())) {
      return res.status(503).json({
        error: 'Tabela de overrides de movimentos em falta.',
        details: 'Execute: npm run db:migrate:requisicoes-movimentos-overrides'
      });
    }
    const movId = String(req.body?.mov_id || '').trim();
    if (!movId) return res.status(400).json({ error: 'mov_id é obrigatório.' });
    await pool.query(
      `INSERT INTO requisicoes_movimentos_overrides (mov_key, patch, deleted, updated_by, updated_at)
       VALUES ($1, '{}'::jsonb, true, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (mov_key)
       DO UPDATE SET
         deleted = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [movId, req.user?.id || null]
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao apagar linha de movimento', details: error.message });
  }
});

router.post('/movimentos-clog/backfill-historico', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ error: 'Apenas admin pode executar backfill de movimentos.' });
    }
    if (!(await movimentosHistoricoTableExists())) {
      return res.status(503).json({
        error: 'Tabela de histórico de movimentos em falta.',
        details: 'Execute: npm run db:migrate:requisicoes-movimentos-historico'
      });
    }

    const modo = String(req.body?.modo || 'padrao').trim().toLowerCase();
    if (modo && modo !== 'padrao' && modo !== 'finalizados') {
      return res.status(400).json({ error: 'modo inválido. Omita o campo ou use "padrao" ou "finalizados".' });
    }
    const batchSize = 400;
    let offset = 0;
    let totalReq = 0;
    let lotes = 0;

    if (modo === 'finalizados') {
      /**
       * Reconstrói snapshot de movimentos para requisições FINALIZADO (transferências, devoluções, etc.),
       * sem exigir Nº TRA nem janela temporal por omissão. Opcional: `meses` > 0 limita à última janela.
       * Requer armazéns para o JOIN usado em buildClogRowsForRequisicaoIds.
       */
      const mesesOptRaw = req.body?.meses;
      const mesesOptParsed = parseInt(String(mesesOptRaw ?? ''), 10);
      const comFiltroData = Number.isFinite(mesesOptParsed) && mesesOptParsed > 0;
      const mesesFiltro = comFiltroData ? Math.max(1, Math.min(mesesOptParsed, 600)) : null;
      const maxLotesRaw = parseInt(String(req.body?.max_lotes ?? ''), 10);
      const maxLotes = Number.isFinite(maxLotesRaw) && maxLotesRaw > 0 ? Math.min(maxLotesRaw, 100000) : null;

      while (true) {
        if (maxLotes != null && lotes >= maxLotes) break;
        const r = comFiltroData
          ? await pool.query(
              `
              SELECT r.id
              FROM requisicoes r
              WHERE r.status = 'FINALIZADO'
                AND r.armazem_origem_id IS NOT NULL
                AND r.armazem_id IS NOT NULL
                AND COALESCE(r.tra_gerada_em, r.updated_at, r.created_at)
                  >= (CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 month'))
              ORDER BY r.id DESC
              LIMIT $2 OFFSET $3
              `,
              [mesesFiltro, batchSize, offset]
            )
          : await pool.query(
              `
              SELECT r.id
              FROM requisicoes r
              WHERE r.status = 'FINALIZADO'
                AND r.armazem_origem_id IS NOT NULL
                AND r.armazem_id IS NOT NULL
              ORDER BY r.id DESC
              LIMIT $1 OFFSET $2
              `,
              [batchSize, offset]
            );
        const ids = (r.rows || []).map((x) => Number(x.id)).filter(Number.isFinite);
        if (!ids.length) break;
        await persistMovimentosHistoricoForRequisicoes(ids);
        totalReq += ids.length;
        lotes += 1;
        offset += batchSize;
      }

      return res.json({
        ok: true,
        modo: 'finalizados',
        filtro_data: comFiltroData,
        meses: comFiltroData ? mesesFiltro : null,
        max_lotes: maxLotes,
        requisicoes_processadas: totalReq,
        lotes,
      });
    }

    const mesesRaw = parseInt(String(req.body?.meses || '12'), 10);
    const meses = Number.isFinite(mesesRaw) ? Math.max(1, Math.min(mesesRaw, 24)) : 12;

    while (true) {
      const r = await pool.query(
        `
        SELECT r.id
        FROM requisicoes r
        WHERE (
            COALESCE(r.tra_numero, '') <> ''
            OR r.devolucao_tra_gerada_em IS NOT NULL
          )
          AND (
            r.status = 'FINALIZADO'
            OR (r.status = 'Entregue' AND (r.tra_gerada_em IS NOT NULL OR r.devolucao_tra_gerada_em IS NOT NULL))
            OR (
              r.status = 'APEADOS'
              AND r.devolucao_tra_gerada_em IS NOT NULL
              AND r.devolucao_tra_apeados_gerada_em IS NOT NULL
              AND COALESCE(TRIM(r.devolucao_tra_apeados_numero), '') <> ''
            )
          )
          AND COALESCE(r.tra_gerada_em, r.updated_at, r.created_at) >= (CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 month'))
        ORDER BY r.id DESC
        LIMIT $2 OFFSET $3
        `,
        [meses, batchSize, offset]
      );
      const ids = (r.rows || []).map((x) => Number(x.id)).filter(Number.isFinite);
      if (!ids.length) break;
      await persistMovimentosHistoricoForRequisicoes(ids);
      totalReq += ids.length;
      lotes += 1;
      offset += batchSize;
    }

    return res.json({
      ok: true,
      modo: 'padrao',
      meses,
      requisicoes_processadas: totalReq,
      lotes,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro no backfill do histórico de movimentos', details: error.message });
  }
});

async function buildClogRowsFromRequisicao(requisicao, dateStr) {
  if (!requisicao?.armazem_origem_id) return { rows: [], eligible: false, reason: 'Requisição sem armazém de origem.' };
  const numeroTraDev = String(requisicao?.tra_numero || requisicao?.devolucao_tra_apeados_numero || '').trim();
  if (!numeroTraDev && !requisicao?.devolucao_tra_gerada_em) {
    return { rows: [], eligible: false, reason: 'Guarde o Nº TRA antes de gerar/abrir o Clog.' };
  }

  const isRecMerc = hasRecebimentoMarker(requisicao);
  /** Recebimento mercadoria: armazem_origem_id = onde se recebe; armazem_id = origem do envio. */
  const armazemIdExpedicao = isRecMerc ? requisicao.armazem_id : requisicao.armazem_origem_id;
  const armazemIdDestinoLogico = isRecMerc ? requisicao.armazem_origem_id : requisicao.armazem_id;

  const armazemOrigem = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
  if (armazemOrigem.rows.length === 0) {
    return { rows: [], eligible: false, reason: 'Armazém de origem não encontrado.' };
  }
  const tipoOrigemRow = (armazemOrigem.rows[0].tipo || '').toLowerCase();
  const fluxoDevolucao = isFluxoDevolucaoParaCentral(
    isRecMerc ? requisicao.armazem_destino_tipo : tipoOrigemRow,
    isRecMerc ? requisicao.armazem_origem_tipo : requisicao.armazem_destino_tipo
  );

  const codigoDestino = isRecMerc
    ? String(requisicao.armazem_origem_codigo || '')
    : String(requisicao.armazem_destino_codigo || '');

  let localizacaoOrigemTRA = LOCALIZACAO_EXPEDICAO_FALLBACK;
  if (armazemIdExpedicao) {
    const locExp = await pool.query(
      `SELECT localizacao
       FROM armazens_localizacoes
       WHERE armazem_id = $1 AND LOWER(COALESCE(tipo_localizacao, '')) = 'expedicao'
       ORDER BY id
       LIMIT 1`,
      [armazemIdExpedicao]
    );
    if (locExp.rows.length > 0 && locExp.rows[0].localizacao) {
      localizacaoOrigemTRA = locExp.rows[0].localizacao;
    }
  }

  let locResultRows = [];
  try {
    const locResult = await pool.query(
      'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
      [armazemIdDestinoLogico]
    );
    locResultRows = locResult.rows;
  } catch (_) {
    locResultRows = [];
  }
  const { localizacaoFERR, localizacaoNormal } = computeDestLocFerrNormal(codigoDestino, locResultRows);
  let localizacaoRecebimentoDestino = null;
  try {
    localizacaoRecebimentoDestino = await localizacaoArmazemPorTipoConn(pool, armazemIdDestinoLogico, 'recebimento');
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

  const colaboradorObs = (() => {
    if (isRecMerc) {
      const tipoD = String(requisicao.armazem_origem_tipo || '').toLowerCase();
      const cod = String(requisicao.armazem_origem_codigo || '').toUpperCase();
      const desc = String(requisicao.armazem_origem_descricao || '').toUpperCase();
      const epi =
        tipoD === 'epi' || cod.includes('EPI') || desc.includes('EPI');
      return epi ? observacoesClogEpiSomenteColaborador(requisicao.observacoes) : requisicao.observacoes || '';
    }
    return isDestinoEPI(requisicao)
      ? observacoesClogEpiSomenteColaborador(requisicao.observacoes)
      : requisicao.observacoes || '';
  })();
  let apeadoDestinoCodigoClog = '';
  let apeadoDestinoLocClog = '';
  try {
    const apeadoDestinoId = Number(requisicao?.devolucao_apeado_destino_id);
    if (Number.isFinite(apeadoDestinoId)) {
      const apeQ = await pool.query('SELECT codigo FROM armazens WHERE id = $1', [apeadoDestinoId]);
      apeadoDestinoCodigoClog = String(apeQ.rows?.[0]?.codigo || '').trim();
      const locApe = await localizacaoArmazemPorTipoConn(pool, apeadoDestinoId, 'recebimento');
      apeadoDestinoLocClog = String(locApe || '').trim();
    }
  } catch (_) {}

  const rows = clogRowsFromItemData(
    dateStr,
    codigoDestino,
    colaboradorObs,
    numeroTraDev,
    localizacaoOrigemTRA,
    localizacaoFERR,
    localizacaoNormal,
    itensComFerramenta,
    bobinas,
    {
      reqId: requisicao.id,
      reqUserId: requisicao.usuario_id,
      armazemOrigemId: isRecMerc ? requisicao.armazem_id : requisicao.armazem_origem_id,
      armazemDestinoId: isRecMerc ? requisicao.armazem_origem_id : requisicao.armazem_id,
      origemTipo: isRecMerc ? requisicao.armazem_destino_tipo : requisicao.armazem_origem_tipo,
      destinoTipo: isRecMerc ? requisicao.armazem_origem_tipo : requisicao.armazem_destino_tipo,
      isDevolucao: fluxoDevolucao,
      isApeados:
        String(requisicao?.status || '') === 'APEADOS' &&
        Boolean(requisicao?.devolucao_tra_apeados_gerada_em) &&
        Boolean(String(requisicao?.devolucao_tra_apeados_numero || '').trim()),
      apeadoDestinoCodigo: apeadoDestinoCodigoClog,
      apeadoDestinoLoc: apeadoDestinoLocClog,
      apeadosOrigemLoc: localizacaoRecebimentoDestino || LOCALIZACAO_RECEBIMENTO_FALLBACK,
      devolucaoDestinoLoc: localizacaoRecebimentoDestino || LOCALIZACAO_RECEBIMENTO_FALLBACK,
      destinoTraLoc: localizacaoRecebimentoDestino || localizacaoNormal
    }
  );
  const rowsNorm = (await applyMovimentosOverrides(rows)).map(normalizarTipoMovimentoClogDevolucao);
  return { rows: rowsNorm, eligible: true };
}

router.get('/:id/export-clog', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id, false);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarClog(requisicao)) {
      return res.status(400).json({ error: 'Clog disponível após TRA/DEV (Entregue), em Finalizado, ou em APEADOS quando DEV + Nº DEV estiverem guardados.' });
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
          'Nenhuma requisição elegível para gerar Clog (requer TRA/DEV em Entregue ou requisição finalizada).',
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarClog(requisicao)) {
      return res.status(400).json({ error: 'Clog disponível após TRA/DEV (Entregue), em Finalizado, ou em APEADOS quando DEV + Nº DEV estiverem guardados.' });
    }

    const dateStr = formatDateBR(new Date());
    const { rows, eligible, reason } = await buildClogRowsFromRequisicao(requisicao, dateStr);
    if (!eligible || rows.length === 0) {
      return res.status(400).json({ error: reason || 'Nenhuma linha elegível para Clog.' });
    }

    const rowsModal = (rows || []).map((r) => ({ ...r, Observações: '' }));
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'Observações', 'DEP'];
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
          'Nenhuma requisição elegível para Clog (requer TRA/DEV em Entregue ou requisição finalizada).',
      });
    }

    const rowsModal = (allRows || []).map((r) => ({ ...r, Observações: '' }));
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'Observações', 'DEP'];
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteRequisicao(requisicao)) {
      return res.status(400).json({
        error:
          'Ficheiro de reporte só está disponível após gerar a TRA (Entregue), quando a requisição estiver finalizada, durante devolução em EM EXPEDICAO, ou em EM EXPEDICAO com TRFL já gerada (exceto recebimento de mercadoria).',
      });
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
    const isDevolucaoViaturaCentral = isFluxoDevolucaoParaCentral(
      requisicao.armazem_origem_tipo,
      requisicao.armazem_destino_tipo
    );
    const ocultarSeriaisReporte = String(requisicao.armazem_origem_tipo || '').toLowerCase() === 'central' &&
      String(requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
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

    const comColabEpi = requisicaoComColaboradorEpi(requisicao);
    const colaboradorObs = comColabEpi ? observacoesReporteEpiColaborador(requisicao.observacoes) : '';
    const rows = [];
    for (const b of bobinas) {
      rows.push({
        Artigo: String(b.item_codigo || ''),
        'Descrição': String(b.item_descricao || ''),
        Quantidade: Number(b.metros) || 0,
        ORIGEM: origemReporte,
        'S/N': ocultarSeriaisReporte ? '' : (b.serialnumber || ''),
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
      if (qty < 0) continue;
      rows.push({
        Artigo: String(ri.item_codigo || ''),
        'Descrição': String(ri.item_descricao || ''),
        Quantidade: qty,
        ORIGEM: origemReporte,
        'S/N': ocultarSeriaisReporte ? '' : (ri.serialnumber || ''),
        LOTE: ri.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    await buildExcelReporte(
      rows,
      res,
      `REPORTE_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      { includeObservacoes: comColabEpi }
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (!podeExportarReporteRequisicao(requisicao)) {
      return res.status(400).json({
        error:
          'Dados do reporte só estão disponíveis após gerar a TRA (Entregue), quando a requisição estiver finalizada, durante devolução em EM EXPEDICAO, ou em EM EXPEDICAO com TRFL já gerada (exceto recebimento de mercadoria).',
      });
    }

    const comColabEpi = requisicaoComColaboradorEpi(requisicao);
    const colaboradorObs = comColabEpi ? observacoesReporteEpiColaborador(requisicao.observacoes) : '';

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
    const isDevolucaoViaturaCentral = isFluxoDevolucaoParaCentral(
      requisicao.armazem_origem_tipo,
      requisicao.armazem_destino_tipo
    );
    const ocultarSeriaisReporte = String(requisicao.armazem_origem_tipo || '').toLowerCase() === 'central' &&
      String(requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
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
        'S/N': ocultarSeriaisReporte ? '' : (b.serialnumber || ''),
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
      if (qty < 0) continue;

      rows.push({
        Artigo: String(ri.item_codigo || ''),
        'Descrição': String(ri.item_descricao || ''),
        Quantidade: qty,
        ORIGEM: origemReporte,
        'S/N': ocultarSeriaisReporte ? '' : (ri.serialnumber || ''),
        LOTE: ri.lote || '',
        DESTINO: codigoDestino,
        'Observações': colaboradorObs
      });
    }

    const columns = ['Artigo', 'Descrição', 'Quantidade', 'ORIGEM', 'S/N', 'LOTE', 'DESTINO'];
    if (comColabEpi) columns.push('Observações');

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
      if (!podeExportarReporteRequisicao(requisicao)) continue;

      const comColabEpi = requisicaoComColaboradorEpi(requisicao);
      if (comColabEpi) includeObservacoes = true;
      const colaboradorObs = comColabEpi ? observacoesReporteEpiColaborador(requisicao.observacoes) : '';

      // Linha de separação entre requisições
      allRows.push({
        Artigo: `--- Requisição #${id} ---`,
        'Descrição': '',
        Quantidade: '',
        ORIGEM: '',
        'S/N': '',
        LOTE: '',
        DESTINO: '',
        ...(comColabEpi ? { 'Observações': '' } : {})
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
      const isDevolucaoViaturaCentral = isFluxoDevolucaoParaCentral(
        requisicao.armazem_origem_tipo,
        requisicao.armazem_destino_tipo
      );
      const ocultarSeriaisReporte = String(requisicao.armazem_origem_tipo || '').toLowerCase() === 'central' &&
        String(requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
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
          'S/N': ocultarSeriaisReporte ? '' : (b.serialnumber || ''),
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
        if (qty < 0) continue;

        allRows.push({
          Artigo: String(ri.item_codigo || ''),
          'Descrição': String(ri.item_descricao || ''),
          Quantidade: qty,
          ORIGEM: origemReporte,
          'S/N': ocultarSeriaisReporte ? '' : (ri.serialnumber || ''),
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
      if (!podeExportarReporteRequisicao(requisicao)) continue;
      const comColabEpi = requisicaoComColaboradorEpi(requisicao);
      const colaboradorObs = comColabEpi ? observacoesReporteEpiColaborador(requisicao.observacoes) : '';
      if (comColabEpi) includeObservacoes = true;

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
      const isDevolucaoViaturaCentral = isFluxoDevolucaoParaCentral(
        requisicao.armazem_origem_tipo,
        requisicao.armazem_destino_tipo
      );
      const ocultarSeriaisReporte = String(requisicao.armazem_origem_tipo || '').toLowerCase() === 'central' &&
        String(requisicao.armazem_destino_tipo || '').toLowerCase() === 'central';
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
          'S/N': ocultarSeriaisReporte ? '' : (b.serialnumber || ''),
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
        if (qty < 0) continue;
        allRows.push({
          Artigo: String(ri.item_codigo || ''),
          'Descrição': String(ri.item_descricao || ''),
          Quantidade: qty,
          ORIGEM: origemReporte,
          'S/N': ocultarSeriaisReporte ? '' : (ri.serialnumber || ''),
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao buscar requisição:', error);
    res.status(500).json({ error: 'Erro ao buscar requisição', details: error.message });
  }
});

// Criar nova requisição (com múltiplos itens)
router.post('/', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
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
    const armazemCheck = await client.query('SELECT id, tipo FROM armazens WHERE id = $1 AND ativo = true', [
      armazem_id,
    ]);
    if (armazemCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Armazém destino não encontrado ou inativo' });
    }
    const tipoDestinoCriar = armazemCheck.rows[0].tipo;

    // Verificar armazém origem (se informado)
    let tipoOrigemCriar = null;
    if (armazem_origem_id) {
      const origCheck = await client.query('SELECT id, tipo FROM armazens WHERE id = $1 AND ativo = true', [
        armazem_origem_id,
      ]);
      if (origCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém origem não encontrado ou inativo' });
      }
      tipoOrigemCriar = origCheck.rows[0].tipo;
      if (!isTipoArmazemOrigemRequisicao(tipoOrigemCriar)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Armazém de origem não é um tipo válido (central, viatura, APEADO ou EPI).',
        });
      }
    }

    if (req.requisicaoArmazemOrigemIds && req.requisicaoArmazemOrigemIds.length > 0) {
      const orig = armazem_origem_id ? parseInt(armazem_origem_id, 10) : null;
      const dest = parseInt(armazem_id, 10);
      if (orig != null && isFluxoDevolucaoParaCentral(tipoOrigemCriar, tipoDestinoCriar)) {
        if (!req.requisicaoArmazemOrigemIds.includes(dest)) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error:
              'Só pode criar devoluções para armazéns centrais que tenha associados ao seu utilizador (requisições / armazéns de origem).',
          });
        }
      } else {
        if (orig == null || !req.requisicaoArmazemOrigemIds.includes(orig)) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Só pode criar requisições com origem num dos armazéns de origem atribuídos ao seu utilizador.',
          });
        }
      }
    }

    if (isFluxoDevolucaoEpiCentral(tipoOrigemCriar, tipoDestinoCriar)) {
      if (!armazem_origem_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Para devolução de EPI, selecione o armazém EPI de origem.' });
      }
      if (!observacoesTemColaboradorEpi(observacoes)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error:
            'Para devolução de EPI, preencha nome e número do colaborador (Colaborador: … | Nr. Colab.: …).',
        });
      }
      const origEpiId = parseInt(armazem_origem_id, 10);
      const destCentralId = parseInt(armazem_id, 10);
      let vincEpi;
      try {
        vincEpi = await client.query(
          `SELECT armazem_central_vinculado_id FROM armazens WHERE id = $1 AND ativo = true`,
          [origEpiId]
        );
      } catch (vincErr) {
        if (vincErr.code === '42703') {
          await client.query('ROLLBACK');
          return res.status(503).json({
            error: 'Vínculo central/EPI em falta na base de dados.',
            details: 'Execute: npm run db:migrate:armazens-vinculo-central',
          });
        }
        throw vincErr;
      }
      if (!vincEpi.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém EPI de origem não encontrado.' });
      }
      if (Number(vincEpi.rows[0].armazem_central_vinculado_id) !== destCentralId) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'O armazém EPI selecionado não está vinculado ao armazém central de destino.',
        });
      }
    }

    if (isFluxoDevolucaoViaturaCentral(tipoOrigemCriar, tipoDestinoCriar) && !armazem_origem_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Para devolução de viatura, selecione o armazém de origem.' });
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
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

    console.log(`✅ Requisição criada: ID ${requisicaoId} com ${itens.length} item(ns)`);
    res.status(201).json(requisicao);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.isStockPrepBiz) {
      return res.status(error.status).json(error.payload);
    }
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

    const scanTextSnapshot = (sheet) => {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const cells = [];
      for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = sheet[cellAddr];
          if (!cell || cell.v == null) continue;
          const raw = String(cell.v || '').trim();
          if (!raw) continue;
          cells.push(raw);
        }
      }
      const normalizedCells = cells.map((v) => normalizeText(v));
      const normalizedText = ` ${normalizedCells.join(' ')} `;
      const tokenSet = new Set(
        normalizedText
          .split(/[^a-z0-9]+/)
          .map((t) => t.trim())
          .filter(Boolean)
      );
      return { normalizedText, tokenSet };
    };

    const looksLikeEpiSheet = (sheet) => {
      const { normalizedText } = scanTextSnapshot(sheet);
      if (!normalizedText) return false;
      const hasEpiTitle =
        normalizedText.includes(' distribuicao de epi ') ||
        normalizedText.includes(' distribuicao epi ');
      const hasDecl =
        normalizedText.includes(' declaracao ') ||
        normalizedText.includes(' equipamentos de protecao individual ');
      const hasColaborador = normalizedText.includes(' colaborador ');
      return hasEpiTitle || (hasDecl && hasColaborador);
    };

    const extractEpiMetadata = (sheet) => {
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      if (!Array.isArray(rows) || rows.length === 0) {
        return { colaboradorNome: '', colaboradorNumero: '' };
      }

      const get = (r, c) => String((rows[r] && rows[r][c]) || '').trim();
      let colaboradorNome = '';
      let colaboradorNumero = '';

      for (let r = 0; r < rows.length; r++) {
        const row = Array.isArray(rows[r]) ? rows[r] : [];
        const normalizedCells = row.map((v) => normalizeText(v));
        for (let c = 0; c < row.length; c++) {
          const cellNorm = normalizedCells[c] || '';
          if (!colaboradorNome && (cellNorm.includes('colaborador') || cellNorm.includes('colaborador(a)'))) {
            const maybeName = get(r, c + 2) || get(r, c + 1);
            if (maybeName) colaboradorNome = maybeName;
          }
          if (!colaboradorNumero && (cellNorm.includes('nr. colab') || cellNorm === 'nr' || cellNorm.includes('numero colab'))) {
            const maybeNr = get(r, c + 1) || get(r + 1, c) || get(r + 1, c + 1);
            if (maybeNr) colaboradorNumero = maybeNr;
          }
        }
      }

      return { colaboradorNome, colaboradorNumero };
    };

    const resolveEpiDestinoVinculado = async (armazemOrigemIdValue) => {
      const origemArm = await pool.query(
        `SELECT id, LOWER(TRIM(COALESCE(tipo, ''))) AS tipo
         FROM armazens
         WHERE id = $1 AND ativo = true`,
        [armazemOrigemIdValue]
      );
      if (origemArm.rows.length === 0) {
        throw new Error('Armazém de origem não encontrado ou inativo.');
      }
      if (origemArm.rows[0].tipo !== 'central') {
        throw new Error('Para importação de EPI, o armazém de origem selecionado deve ser do tipo central.');
      }

      let destinos;
      try {
        destinos = await pool.query(
          `SELECT id, tipo
           FROM armazens
           WHERE ativo = true
             AND LOWER(TRIM(COALESCE(tipo, ''))) = 'epi'
             AND armazem_central_vinculado_id = $1
           ORDER BY id ASC`,
          [armazemOrigemIdValue]
        );
      } catch (e) {
        if (e.code === '42703') {
          throw new Error(
            'A base de dados não suporta vínculo central para EPI. Execute: npm run db:migrate:armazens-vinculo-central'
          );
        }
        throw e;
      }

      if (destinos.rows.length === 0) {
        throw new Error('Não existe armazém EPI ativo vinculado ao armazém central de origem selecionado.');
      }
      if (destinos.rows.length > 1) {
        throw new Error(
          'Existem múltiplos armazéns EPI vinculados a este central. Mantenha apenas um vínculo EPI por central para importar este modelo.'
        );
      }
      return destinos.rows[0];
    };

    const scanCodigoArmazemFromWarehouseColumn = (sheet) => {
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      if (!Array.isArray(rows) || rows.length === 0) return null;
      let targetCol = -1;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
          const h = normalizeText(row[c]);
          if (
            h === 'destinationwarehouse' ||
            h === 'destination warehouse' ||
            h === 'armazem destino' ||
            h === 'armazemdestino' ||
            h === 'destino'
          ) {
            targetCol = c;
            break;
          }
        }
        if (targetCol >= 0) break;
      }
      if (targetCol < 0) return null;
      for (const row of rows) {
        if (!Array.isArray(row) || targetCol >= row.length) continue;
        const raw = String(row[targetCol] || '').trim();
        if (!raw) continue;
        const m = /^([A-Z]\d*|V\d+)\b/i.exec(raw);
        if (m && m[1]) return String(m[1]).toUpperCase();
      }
      return null;
    };

    const resolveArmazemDestinoFromSheet = async (sheet) => {
      const codigoPorColuna = scanCodigoArmazemFromWarehouseColumn(sheet);
      const codigoV = scanCodigoV(sheet);
      const codigoPreferido = codigoPorColuna || codigoV;
      if (codigoPreferido) {
        const byCode = await pool.query(
          'SELECT id, tipo, codigo FROM armazens WHERE UPPER(codigo) = $1 AND ativo = true LIMIT 1',
          [codigoPreferido.toUpperCase()]
        );
        if (byCode.rows.length > 0) {
          return byCode.rows[0];
        }
      }

      // Fallback para transferências entre centrais: tentar reconhecer central por código/descrição no texto do Excel.
      const centrais = await pool.query(
        `SELECT id, tipo, codigo, descricao
         FROM armazens
         WHERE ativo = true AND LOWER(TRIM(COALESCE(tipo, ''))) = 'central'`
      );
      if (!centrais.rows.length) return null;

      const { normalizedText, tokenSet } = scanTextSnapshot(sheet);
      let best = null;
      for (const arm of centrais.rows) {
        const codigoNorm = normalizeText(arm.codigo || '');
        const descNorm = normalizeText(arm.descricao || '');
        let score = 0;

        // Códigos de 1 caractere (ex.: "A"): só considerar quando aparecem com delimitador de código.
        if (codigoNorm && codigoNorm.length <= 1) {
          const codeRegex = new RegExp(`(^|\\s)${codigoNorm}(\\s*-|\\s+wh\\b|\\s+warehouse\\b|\\s*$)`, 'i');
          if (codeRegex.test(normalizedText)) score = Math.max(score, 110);
        } else if (codigoNorm && tokenSet.has(codigoNorm)) {
          score = Math.max(score, 100);
        }
        if (codigoNorm && normalizedText.includes(` ${codigoNorm} `)) score = Math.max(score, 95);
        if (codigoNorm && descNorm && normalizedText.includes(` ${codigoNorm} ${descNorm} `)) score = Math.max(score, 90);
        if (descNorm && normalizedText.includes(` ${descNorm} `)) score = Math.max(score, 75);

        if (!score) continue;
        if (!best || score > best.score) {
          best = { ...arm, score };
        } else if (best && score === best.score) {
          // empate: evita escolher armazém errado
          best = { ...best, tie: true };
        }
      }

      if (!best || best.tie) return null;
      return best;
    };

    const resolveViaturaOrigemFromSheet = async (sheet) => {
      const codigoPorColuna = scanCodigoArmazemFromWarehouseColumn(sheet);
      const codigoV = scanCodigoV(sheet);
      const codigoPreferido = codigoPorColuna || codigoV;
      if (!codigoPreferido) {
        throw new Error(
          'Página 2 tem artigos (devolução), mas não foi possível identificar a viatura de origem no Excel (código Vxxx).'
        );
      }
      const byCode = await pool.query(
        'SELECT id, tipo, codigo FROM armazens WHERE UPPER(codigo) = $1 AND ativo = true LIMIT 1',
        [codigoPreferido.toUpperCase()]
      );
      if (!byCode.rows.length) {
        throw new Error(
          `Página 2 tem artigos (devolução), mas o armazém "${codigoPreferido}" não existe ou está inativo.`
        );
      }
      const tipo = String(byCode.rows[0]?.tipo || '').toLowerCase();
      if (tipo !== 'viatura') {
        throw new Error(
          `Página 2 tem artigos (devolução), mas o armazém identificado (${codigoPreferido}) não é do tipo viatura.`
        );
      }
      return byCode.rows[0];
    };

    const parseItensFromSheet = (sheet, { tolerarSemCabecalho }) => {
      const range = XLSX.utils.decode_range(sheet['!ref']);

      // Cabeçalho: Artigo | (Descrição) | Quantidade
      let headerRowNumber = null;
      let colArtigo = null;
      let colQuantidade = null;
      let colRisco = null;
      let colPosicao = null;

      for (let R = range.s.r; R <= range.e.r; R++) {
        let hasArtigo = false;
        let hasQuantidade = false;
        let hasDescricao = false;
        let detectedColArtigo = null;
        let detectedColQtd = null;
        let detectedColRisco = null;
        let detectedColPosicao = null;

        for (let C = range.s.c; C <= range.e.c; C++) {
          const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = sheet[cellAddr];
          if (!cell || cell.v == null) continue;

          const text = normalizeText(cell.v);
          if (text === 'artigo') {
            hasArtigo = true;
            detectedColArtigo = C;
          }
          if (text === 'quantidade' || text === 'qtd' || text === 'qtde') {
            hasQuantidade = true;
            detectedColQtd = C;
          }
          if (text.includes('descr')) {
            hasDescricao = true;
          }
          if (text.includes('risco')) {
            detectedColRisco = C;
          }
          if (text.includes('posicao') || text.includes('posição')) {
            detectedColPosicao = C;
          }
        }

        if (hasArtigo && hasQuantidade && hasDescricao) {
          headerRowNumber = R;
          colArtigo = detectedColArtigo;
          colQuantidade = detectedColQtd;
          colRisco = detectedColRisco;
          colPosicao = detectedColPosicao;
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
      const riscoPorCodigo = new Map();
      const posicaoPorCodigo = new Map();
      for (let R = headerRowNumber + 1; R <= range.e.r; R++) {
        const cellArtigo = sheet[XLSX.utils.encode_cell({ r: R, c: colArtigo })];
        const cellQtd = sheet[XLSX.utils.encode_cell({ r: R, c: colQuantidade })];
        const cellRisco = colRisco != null ? sheet[XLSX.utils.encode_cell({ r: R, c: colRisco })] : null;
        const cellPosicao = colPosicao != null ? sheet[XLSX.utils.encode_cell({ r: R, c: colPosicao })] : null;
        const codigo = cellArtigo && cellArtigo.v != null ? String(cellArtigo.v).trim() : '';
        const qtdStr = cellQtd && cellQtd.v != null ? String(cellQtd.v).trim() : '';
        const riscoStr = cellRisco && cellRisco.v != null ? String(cellRisco.v).trim() : '';
        const posicaoStr = cellPosicao && cellPosicao.v != null ? String(cellPosicao.v).trim() : '';
        if (!codigo || !qtdStr) continue;

        const quantidade = parseInt(String(qtdStr).replace(',', '.'), 10);
        if (!quantidade || quantidade <= 0) continue;
        quantidadePorCodigo.set(codigo, quantidade);
        if (riscoStr) {
          riscoPorCodigo.set(codigo, riscoStr);
        }
        if (posicaoStr) {
          posicaoPorCodigo.set(codigo, posicaoStr);
        }
      }

      const codigosUnicos = [...quantidadePorCodigo.keys()];
      if (codigosUnicos.length === 0) {
        return { itens: [] };
      }

      return { quantidadePorCodigo, codigosUnicos, riscoPorCodigo, posicaoPorCodigo };
    };

    const criarRequisicao = async ({
      client,
      itens,
      armazemOrigemIdReq,
      armazemDestinoId,
      observacoes
    }) => {
      await validarVinculoTransferenciaCentral(client, {
        armazemOrigemId: armazemOrigemIdReq,
        armazemDestinoId,
      });
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
      const observacoesItens = itens.map((i) => String(i?.observacoes || '').trim() || null);
      const lotesItens = itens.map((i) => String(i?.lote || '').trim() || null);
      const seriaisItens = itens.map((i) => String(i?.serialnumber || '').trim() || null);
      const hasObsItens = observacoesItens.some(Boolean);
      const hasRastreioItens = lotesItens.some(Boolean) || seriaisItens.some(Boolean);
      if (hasObsItens || hasRastreioItens) {
        await client.query('SAVEPOINT sp_requisicoes_itens_obs');
        try {
          await client.query(
            `
              INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade, observacoes, lote, serialnumber)
              SELECT
                $1::int,
                x.item_id,
                x.quantidade,
                NULLIF(TRIM(COALESCE(x.observacoes, '')), ''),
                NULLIF(TRIM(COALESCE(x.lote, '')), ''),
                NULLIF(TRIM(COALESCE(x.serialnumber, '')), '')
              FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[]) AS x(item_id, quantidade, observacoes, lote, serialnumber)
              ON CONFLICT (requisicao_id, item_id)
              DO UPDATE SET
                quantidade = EXCLUDED.quantidade,
                observacoes = COALESCE(EXCLUDED.observacoes, requisicoes_itens.observacoes),
                lote = COALESCE(EXCLUDED.lote, requisicoes_itens.lote),
                serialnumber = COALESCE(EXCLUDED.serialnumber, requisicoes_itens.serialnumber)
            `,
            [requisicaoId, itemIds, quantidades, observacoesItens, lotesItens, seriaisItens]
          );
          await client.query('RELEASE SAVEPOINT sp_requisicoes_itens_obs');
        } catch (insObsErr) {
          if (insObsErr.code === '42703') {
            await client.query('ROLLBACK TO SAVEPOINT sp_requisicoes_itens_obs');
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
            await client.query('RELEASE SAVEPOINT sp_requisicoes_itens_obs');
          } else {
            await client.query('ROLLBACK TO SAVEPOINT sp_requisicoes_itens_obs');
            await client.query('RELEASE SAVEPOINT sp_requisicoes_itens_obs');
            throw insObsErr;
          }
        }
      } else {
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
      }

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

        const { quantidadePorCodigo, codigosUnicos, posicaoPorCodigo } = parsed;
        if (!codigosUnicos || codigosUnicos.length === 0) {
          return { itens: [] };
        }

        const itensLookup = await pool.query(
          'SELECT id, codigo, tipocontrolo FROM itens WHERE codigo = ANY($1::text[])',
          [codigosUnicos]
        );
        const itemPorCodigo = new Map(itensLookup.rows.map((row) => [row.codigo, row]));

        const itens = [];
        for (const codigo of codigosUnicos) {
          const item = itemPorCodigo.get(codigo);
          if (!item || item.id == null) continue;
          const tipoControlo = String(item.tipocontrolo || '').toUpperCase();
          const posicao = String(posicaoPorCodigo?.get(codigo) || '').trim();
          itens.push({
            item_id: item.id,
            quantidade: quantidadePorCodigo.get(codigo),
            lote: tipoControlo === 'LOTE' && posicao ? posicao : null,
            serialnumber: isTipoControloSerial(tipoControlo) && posicao ? posicao : null,
          });
        }
        return { itens };
      }

      // Página 1 (requisição): modelo normal (TRFL/TRA) ou modelo EPI (destino vinculado ao central escolhido).
      // IMPORTANTE: se a página 1 vier vazia (sem artigos), não tentar resolver armazém aqui;
      // o fluxo pode seguir com devolução-only na página 2.
      const isEpiImport = looksLikeEpiSheet(sheet);
      const parsed = parseItensFromSheet(sheet, { tolerarSemCabecalho: true });
      if (!parsed || !Array.isArray(parsed.itens) && !parsed.codigosUnicos) {
        return { itens: [] };
      }

      if (parsed.itens) {
        return { itens: [] };
      }

      const { quantidadePorCodigo, codigosUnicos, riscoPorCodigo, posicaoPorCodigo } = parsed;
      if (!codigosUnicos || codigosUnicos.length === 0) {
        return { itens: [] };
      }

      let armazemDestino;
      if (isEpiImport) {
        armazemDestino = await resolveEpiDestinoVinculado(armazemOrigemId);
      } else {
        armazemDestino = await resolveArmazemDestinoFromSheet(sheet);
      }
      if (!armazemDestino) {
        throw new Error(
          isEpiImport
            ? 'Não foi possível resolver o armazém EPI vinculado ao central selecionado.'
            : 'Não foi possível identificar o armazém destino no Excel (código/descrição de central ou Vxxx).'
        );
      }
      const armazemDestinoId = armazemDestino.id;
      const armazemDestinoTipo = armazemDestino.tipo;

      const itensLookup = await pool.query(
        'SELECT id, codigo, tipocontrolo FROM itens WHERE codigo = ANY($1::text[])',
        [codigosUnicos]
      );
      const itemPorCodigo = new Map(itensLookup.rows.map((row) => [row.codigo, row]));

      const itens = [];
      for (const codigo of codigosUnicos) {
        const item = itemPorCodigo.get(codigo);
        if (!item || item.id == null) continue;
        const risco = (riscoPorCodigo && riscoPorCodigo.get(codigo)) || '';
        const posicao = String(posicaoPorCodigo?.get(codigo) || '').trim();
        const tipoControlo = String(item.tipocontrolo || '').toUpperCase();
        itens.push({
          item_id: item.id,
          quantidade: quantidadePorCodigo.get(codigo),
          observacoes: isEpiImport && risco ? `Risco associado: ${risco}` : null,
          lote: tipoControlo === 'LOTE' && posicao ? posicao : null,
          serialnumber: isTipoControloSerial(tipoControlo) && posicao ? posicao : null,
        });
      }

      const epiMeta = isEpiImport ? extractEpiMetadata(sheet) : null;
      return {
        itens,
        armazemDestinoId,
        armazemDestinoTipo,
        isEpiImport,
        epiMeta
      };
    };

    let parsedReq = null;
    try {
      parsedReq = await parseSheetForImport(sheet1, 'requisicao');
    } catch (e) {
      const msg = String(e?.message || '');
      const headerNaoEncontrado = msg.includes('Cabeçalho Artigo/Descrição/Quantidade não encontrado');
      if (!headerNaoEncontrado) {
        return res.status(400).json({ error: e.message || 'Erro ao interpretar página 1 do Excel.' });
      }
      parsedReq = { itens: [] };
    }

    let parsedDev = { itens: [] };
    if (sheet2) {
      try {
        parsedDev = await parseSheetForImport(sheet2, 'devolucao');
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Erro ao interpretar página 2 do Excel (devolução).' });
      }
    }

    const temItensReq = Boolean(parsedReq && Array.isArray(parsedReq.itens) && parsedReq.itens.length > 0);
    const temItensDev = Boolean(parsedDev && Array.isArray(parsedDev.itens) && parsedDev.itens.length > 0);
    if (!temItensReq && !temItensDev) {
      return res.status(400).json({
        error: 'Nenhum item válido encontrado no Excel (página 1 e página 2 sem artigos).'
      });
    }

    // Criar requisição (página 1) e/ou devolução (página 2)
    const client = await pool.connect();
    let requisicaoId = null;
    let devolucaoId = null;
    try {
      await client.query('BEGIN');
      if (temItensReq) {
        requisicaoId = await criarRequisicao({
          client,
          itens: parsedReq.itens,
          armazemOrigemIdReq: armazemOrigemId,
          armazemDestinoId: parsedReq.armazemDestinoId,
          observacoes:
            parsedReq.isEpiImport
              ? [
                  'Importada de Excel (EPI)',
                  parsedReq.epiMeta?.colaboradorNome ? `Colaborador: ${parsedReq.epiMeta.colaboradorNome}` : null,
                  parsedReq.epiMeta?.colaboradorNumero ? `Nr. Colab.: ${parsedReq.epiMeta.colaboradorNumero}` : null,
                  `Declaração: ${EPI_DISCLAIMER_PADRAO}`
                ].filter(Boolean).join(' | ')
              : 'Importada de Excel (página 1)'
        });
      }

      // Criar devolução (página 2) apenas se houver artigos listados
      if (temItensDev) {
        if (temItensReq) {
          // Regra original:
          //   - devolução armazem_origem = destino da requisição (página 1)
          //   - devolução armazem_destino = origem da requisição (selecionada no frontend)
          const armazemOrigemDevTipo = String(parsedReq?.armazemDestinoTipo || '').toLowerCase();
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
        } else {
          // Devolução-only (página 1 vazia):
          //   - origem da devolução = viatura identificada na página 2 (Vxxx)
          //   - destino da devolução = armazém origem selecionado no frontend (deve ser central)
          const armazemDestinoDevTipo = String(ao.rows[0]?.tipo || '').toLowerCase();
          if (armazemDestinoDevTipo !== 'central') {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error:
                'Página 2 tem artigos (devolução), mas o armazém selecionado no import não é central (destino da devolução).'
            });
          }
          const viaturaOrigem = await resolveViaturaOrigemFromSheet(sheet2);
          devolucaoId = await criarRequisicao({
            client,
            itens: parsedDev.itens,
            armazemOrigemIdReq: viaturaOrigem.id,
            armazemDestinoId: armazemOrigemId,
            observacoes: 'Importada de Excel (página 2 - Devolução sem página 1)'
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
router.put('/:id', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { armazem_origem_id, armazem_id, itens, status, localizacao, observacoes } = req.body;

    // Verificar se a requisição existe (tipos para escopo de devolução viatura → central)
    const checkReq = await client.query(
      `SELECT r.*, ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (checkReq.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, checkReq.rows[0].armazem_origem_id, {
        requisicao: checkReq.rows[0],
      })
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (
      req.user?.role === 'backoffice_operations' &&
      Number(checkReq.rows[0]?.usuario_id || 0) !== Number(req.user?.id || 0)
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Backoffice Operations só pode editar requisições criadas pelo próprio utilizador.',
        code: 'BACKOFFICE_OPERATIONS_OWN_ONLY',
      });
    }

    const statusAtual = String(checkReq.rows[0].status || '');
    const adminEditCabecalho = isAdmin(req.user?.role) && statusAtual !== 'pendente';
    if (statusAtual !== 'pendente' && !isAdmin(req.user?.role)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:
          'Só é possível editar requisições pendentes. Após o início da separação, a requisição não pode ser alterada.',
        code: 'REQUISICAO_NAO_EDITAVEL',
      });
    }
    if (adminEditCabecalho && itens !== undefined) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:
          'Admin só pode editar origem/destino/cabeçalho após o início da separação. Artigos só podem ser alterados em pendente.',
        code: 'REQUISICAO_ITENS_BLOQUEADOS',
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
        const destEff =
          armazem_id !== undefined
            ? parseInt(armazem_id, 10)
            : parseInt(checkReq.rows[0].armazem_id, 10);
        if (newOrig == null) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Não pode alterar o armazém de origem para fora dos armazéns permitidos.',
          });
        }
        const origT = await client.query('SELECT tipo FROM armazens WHERE id = $1', [newOrig]);
        const destT = await client.query('SELECT tipo FROM armazens WHERE id = $1', [destEff]);
        const tO = origT.rows[0]?.tipo;
        const tD = destT.rows[0]?.tipo;
        if (isFluxoDevolucaoParaCentral(tO, tD)) {
          if (!req.requisicaoArmazemOrigemIds.includes(destEff)) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              error:
                'Não pode guardar devolução com destino (central) fora dos armazéns associados ao seu utilizador.',
            });
          }
        } else if (!req.requisicaoArmazemOrigemIds.includes(newOrig)) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Não pode alterar o armazém de origem para fora dos armazéns permitidos.',
          });
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
    if (!adminEditCabecalho && itens && Array.isArray(itens)) {
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
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

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

// Deletar requisição
router.delete('/:id', ...requisicaoAuth, denyOnlyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || '';

    // Verificar se a requisição existe (tipos para escopo de devolução)
    const checkReq = await pool.query(
      `SELECT r.*, ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (checkReq.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    const requisicao = checkReq.rows[0];
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (
      req.user?.role === 'backoffice_operations' &&
      Number(requisicao?.usuario_id || 0) !== Number(req.user?.id || 0)
    ) {
      return res.status(403).json({
        error: 'Backoffice Operations só pode apagar requisições criadas pelo próprio utilizador.',
        code: 'BACKOFFICE_OPERATIONS_OWN_ONLY',
      });
    }
    const status = String(requisicao.status || '');
    const statusRestritosAdmin = ['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'];
    if (statusRestritosAdmin.includes(status) && userRole !== 'admin') {
      return res.status(403).json({
        error: 'A exclusão de requisições em separação, separadas, em expedição ou entregues é permitida apenas para ADMIN.'
      });
    }

    // Garantir snapshot no histórico antes de apagar.
    try {
      await ensureMovimentosHistoricoDetachedSchema();
      await persistMovimentosHistoricoForRequisicoes([Number(id)]);
    } catch (eh) {
      console.warn('[movimentos_historico] falha ao persistir snapshot no delete:', eh.message);
    }
    try {
      // Se a coluna já estiver nullable, desprende do FK antes do DELETE.
      await pool.query(
        `UPDATE requisicoes_movimentos_historico
         SET requisicao_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE requisicao_id = $1`,
        [id]
      );
    } catch (ed) {
      console.warn('[movimentos_historico] falha ao desprender requisicao_id no delete:', ed.message);
    }

    // Deletar requisição (itens serão deletados automaticamente por CASCADE)
    await pool.query(
      `UPDATE stock_serial
       SET status = 'disponivel',
           requisicao_id = NULL,
           requisicao_item_id = NULL,
           reservado_em = NULL,
           atualizado_em = CURRENT_TIMESTAMP
       WHERE requisicao_id = $1
         AND status = 'reservado'`,
      [id]
    );
    await liberarReservasLotePorRequisicao(pool, {
      requisicaoId: Number(id),
      usuarioId: req.user?.id || null,
      origem: 'delete-requisicao',
    });
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
