/**
 * Rotas /api/requisicoes — montar com app.use('/api/requisicoes', createRequisicoesRouter(deps))
 */
const express = require('express');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const pdfParseLib = require('pdf-parse');
const { buildExcelTransferencia } = require('../utils/buildExcelTransferencia');

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
} = require('../middleware/requisicoesScope');
const { usuarioTemPermissaoControloStock, usuarioTemPermissaoConsultaMovimentos } = require('../utils/usuarioDbColumns');

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

function makeStockPrepBizError(status, error, code, extra) {
  const err = new Error(error);
  err.isStockPrepBiz = true;
  err.status = status;
  err.payload = { error, ...(code ? { code } : {}), ...extra };
  return err;
}

function quantidadeNecessariaStockPreparacao({
  isZero,
  tipoControlo,
  quantidade_preparada,
  bobinas,
  serialsNormalizados,
}) {
  if (isZero) return 0;
  const t = (tipoControlo || '').toUpperCase();
  if (t === 'LOTE' && Array.isArray(bobinas) && bobinas.length > 0) {
    return bobinas.reduce((sum, b) => sum + (Number(b.metros) || 0), 0);
  }
  if (t === 'S/N' && Array.isArray(serialsNormalizados) && serialsNormalizados.length > 0) {
    return serialsNormalizados.length;
  }
  return Number(quantidade_preparada) || 0;
}

function serialsNormalizadosList(value) {
  return String(value || '')
    .split(/\r?\n|;|\|/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
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
    if (e.code === '42P01') return;
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
    return r.rows[0]?.id ?? null;
  } catch (e) {
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
  for (const b of bob) {
    if ((Number(b.metros) || 0) > 0) return true;
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
    if (qty > 0) return true;
  }
  return false;
}

/**
 * 1.ª geração de TRFL (fluxo normal central): retira de cada localização de preparação e soma em EXPEDICAO.
 * Idempotente via requisicoes.trfl_estoque_aplicado_em.
 */
async function aplicarStockTrflSePendenteNormais(client, { requisicaoId, armazemOrigemId, itens, bobinas }) {
  let doc;
  try {
    doc = await client.query(
      `SELECT trfl_estoque_aplicado_em FROM requisicoes WHERE id = $1 FOR UPDATE`,
      [requisicaoId]
    );
  } catch (e) {
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
    await moverParaExpedicao(ri.localizacao_origem, b.item_id, ri.item_codigo || b.item_codigo, Number(b.metros) || 0);
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
    if (qty <= 0) continue;
    await moverParaExpedicao(ri.localizacao_origem, ri.item_id, ri.item_codigo, qty);
  }

  try {
    await client.query(
      `UPDATE requisicoes SET trfl_estoque_aplicado_em = CURRENT_TIMESTAMP WHERE id = $1`,
      [requisicaoId]
    );
  } catch (e) {
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
  try {
    doc = await client.query(
      `SELECT tra_baixa_expedicao_aplicada_em FROM requisicoes WHERE id = $1 FOR UPDATE`,
      [requisicaoId]
    );
  } catch (e) {
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
    await baixaLinha(b.item_id, ri.item_codigo || b.item_codigo, Number(b.metros) || 0);
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
    if (qty <= 0) continue;
    await baixaLinha(ri.item_id, ri.item_codigo, qty);
  }

  try {
    await client.query(
      `UPDATE requisicoes SET tra_baixa_expedicao_aplicada_em = CURRENT_TIMESTAMP WHERE id = $1`,
      [requisicaoId]
    );
  } catch (e) {
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

/** DEV (devolução): crédito na localização de recebimento do central. */
async function aplicarStockDevolucaoEntradaRecebimento(client, { centralId, locRec, itensComFerramenta, bobinas }) {
  if (!centralId || !locRec) return;
  const list = itensComFerramenta || [];
  const bob = bobinas || [];
  for (const b of bob) {
    const metros = Number(b.metros) || 0;
    if (metros <= 0) continue;
    const ri = list.find((it) => it.item_id === b.item_id) || {};
    await creditarStockNaLocalizacaoArmazem(
      client,
      centralId,
      b.item_id,
      ri.item_codigo || b.item_codigo,
      locRec,
      metros
    );
  }
  for (const ri of list) {
    const tipoControlo = (ri.tipocontrolo || '').toUpperCase();
    const temBobinas = bob.some((x) => x.item_id === ri.item_id);
    if (tipoControlo === 'LOTE' && temBobinas) continue;
    const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
    if (qty <= 0) continue;
    await creditarStockNaLocalizacaoArmazem(client, centralId, ri.item_id, ri.item_codigo, locRec, qty);
  }
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
    const itemId = Number(b.item_id);
    const apeadosQty = apeadosQtyByItemId.get(itemId) ?? 0;
    const prevCount = apeadosCountByItemId.get(itemId) ?? 0;
    const nextCount = prevCount + 1;
    apeadosCountByItemId.set(itemId, nextCount);
    const destLoc = nextCount <= apeadosQty ? localizacaoFERR : localizacaoNormal;
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
    const qty = parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0;
    if (qty <= 0) continue;
    const apeadosQty = Math.max(0, Math.min(qty, parseInt(ri.quantidade_apeados ?? 0, 10) || 0));
    const normalQty = Math.max(0, qty - apeadosQty);
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
      const selecionadas = bobinas.slice(apeadosQty, apeadosQty + remQty);
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
    } else if (tipoControlo === 'S/N') {
      await moverStockMesmoArmazemPorLabels(
        client,
        centralId,
        it.item_id,
        it.item_codigo,
        locOrigemMovimento,
        localizacaoDestino,
        remQty
      );
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
      const selecionadas = bobinas.slice(0, apeadosQty);
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
    } else if (tipoControlo === 'S/N') {
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
  } = deps;

  const router = express.Router();

  const RECEBIMENTO_TRANSFERENCIA_MARKER = 'RECEBIMENTO_TRANSFERENCIA_V1';

  function hasRecebimentoMarker(requisicao) {
    const obs = String(requisicao?.observacoes || '');
    return obs.toUpperCase().startsWith(RECEBIMENTO_TRANSFERENCIA_MARKER);
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
      if (devolucoesViaturaCentral) {
        query += ` AND r.armazem_id = ANY($${paramCount++}::int[])`;
      } else {
        query += ` AND r.armazem_origem_id = ANY($${paramCount++}::int[])`;
      }
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
          if (devolucoesViaturaCentral) {
            fallbackQuery += ` AND r.armazem_id = ANY($${pc++}::int[])`;
          } else {
            fallbackQuery += ` AND r.armazem_origem_id = ANY($${pc++}::int[])`;
          }
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
          a.tipo AS armazem_destino_tipo,
          ao.codigo as armazem_origem_codigo,
          ao.tipo AS armazem_origem_tipo,
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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

/** Clog permite também devolução em APEADOS após DEV + Nº DEV guardado. */
function podeExportarClog(requisicao) {
  if (podeExportarReporteOuClog(requisicao)) return true;
  const st = String(requisicao?.status || '');
  if (st !== 'APEADOS') return false;
  if (!requisicao?.devolucao_tra_gerada_em) return false;
  return Boolean(String(requisicao?.tra_numero || '').trim());
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
    const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(tipoOrigem, tipoDestino);

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
      if (tipoControlo === 'S/N') {
        const serials = serialsNormalizadosList(ri.serialnumber);
        if (serials.length > 0) {
          for (const sn of serials) {
            rows.push({
              Date: dateStr,
              OriginWarehouse: codigoOrigem,
              OriginLocation: ri.localizacao_origem || '',
              Article: String(ri.item_codigo || ''),
              Quatity: 1,
              SerialNumber1: sn, SerialNumber2: '', MacAddress: '', CentroCusto: '',
              DestinationWarehouse: codigoOrigem,
              DestinationLocation: localizacaoExpedicao,
              ProjectCode: '',
              Batch: ri.lote || ''
            });
          }
          continue;
        }
      }
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
        if (tipoControlo === 'S/N') {
          const serials = serialsNormalizadosList(ri.serialnumber);
          if (serials.length > 0) {
            for (const sn of serials) {
              rows.push({
                Date: dateStr,
                OriginWarehouse: codigoOrigem,
                OriginLocation: ri.localizacao_origem || '',
                Article: String(ri.item_codigo || ''),
                Quatity: 1,
                SerialNumber1: sn, SerialNumber2: '', MacAddress: '', CentroCusto: '',
                DestinationWarehouse: codigoOrigem,
                DestinationLocation: localizacaoExpedicao,
                ProjectCode: '',
                Batch: ri.lote || ''
              });
            }
            continue;
          }
        }

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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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
        if (tipoControlo === 'S/N') {
          const serials = serialsNormalizadosList(ri.serialnumber);
          if (serials.length > 0) {
            for (const sn of serials) {
              rows.push({
                Date: dateStr,
                OriginWarehouse: codigoViatura,
                OriginLocation: ri.localizacao_origem || '',
                Article: String(ri.item_codigo || ''),
                Quatity: 1,
                SerialNumber1: sn, SerialNumber2: '', MacAddress: '', CentroCusto: '',
                DestinationWarehouse: codigoCentral,
                DestinationLocation: locRec,
                ProjectCode: '',
                Batch: ri.lote || ''
              });
            }
            continue;
          }
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
      if (tipoControlo === 'S/N') {
        const serials = serialsNormalizadosList(ri.serialnumber);
        if (serials.length > 0) {
          for (const sn of serials) {
            rows.push({
              Date: dateStr,
              OriginWarehouse: codigoOrigem,
              OriginLocation: fluxoCentralApeado ? (ri.localizacao_origem || '') : localizacaoOrigemTRA,
              Article: String(ri.item_codigo || ''),
              Quatity: 1,
              SerialNumber1: sn, SerialNumber2: '', MacAddress: '', CentroCusto: '',
              DestinationWarehouse: codigoDestino,
              DestinationLocation:
                tipoDestNorm === 'central'
                  ? localizacaoDestinoRecebimento
                  : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
              ProjectCode: '',
              Batch: ri.lote || ''
            });
          }
          continue;
        }
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
      } else if (tipoControlo === 'S/N') {
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
          `SELECT devolucao_tra_gerada_em, devolucao_trfl_gerada_em, devolucao_tra_apeados_gerada_em
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
      const locOrigemStock = locRecCentral;
      if (!lockApe.rows[0]?.devolucao_tra_apeados_gerada_em && usuarioTemPermissaoControloStock(req)) {
        try {
          await aplicarStockTraApeadosDevolucao(cApe, {
            centralId,
            locOrigemCentral: locOrigemStock,
            destinoApeadoId,
            locRecApeado,
            apeadosItens,
            bobinasByRequisicaoItemId,
          });
        } catch (st) {
          if (st.code !== '42P01') throw st;
        }
      }
      await cApe.query(
        `UPDATE requisicoes
         SET devolucao_tra_apeados_gerada_em = COALESCE(devolucao_tra_apeados_gerada_em, CURRENT_TIMESTAMP),
             devolucao_apeado_destino_id = COALESCE(devolucao_apeado_destino_id, $2),
             tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id, destinoApeadoId]
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
      } else if (tipoControlo === 'S/N') {
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
          `SELECT devolucao_trfl_pendente_gerada_em, devolucao_trfl_gerada_em FROM requisicoes WHERE id = $1 FOR UPDATE`,
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
      const locOrigemMovimento = lockPend.rows[0]?.devolucao_trfl_gerada_em ? localizacaoNormal : locRecCentral;
      if (!lockPend.rows[0]?.devolucao_trfl_pendente_gerada_em && usuarioTemPermissaoControloStock(req)) {
        try {
          await aplicarStockTrflPendenteDevolucao(cPend, {
            centralId,
            locOrigemMovimento,
            localizacaoDefault,
            itemLocalizacoes,
            itens: requisicao.itens || [],
            bobinasByRequisicaoItemId,
          });
        } catch (st) {
          if (st.code !== '42P01') throw st;
        }
      }
      await cPend.query(
        `UPDATE requisicoes
         SET devolucao_trfl_pendente_gerada_em = COALESCE(devolucao_trfl_pendente_gerada_em, CURRENT_TIMESTAMP)
         WHERE id = $1`,
        [id]
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
  const tipoMovimentoBase = isDevolucao ? 'Devolucao de carrinha' : 'Saida de Armazem';
  const tipoMovimento = tipoMovimentoBase;
  const qtySign = isDevolucao ? 1 : -1;
  const traDev = String(traNumero || '').trim();
  const devolucaoDestinoLoc = String(opts?.devolucaoDestinoLoc || '').trim();
  const newLocDevolucao = devolucaoDestinoLoc || LOCALIZACAO_RECEBIMENTO_FALLBACK;
  const apeadoDestinoCodigo = String(opts?.apeadoDestinoCodigo || '').trim();
  const apeadoDestinoLoc = String(opts?.apeadoDestinoLoc || '').trim();
  const apeadosOrigemLoc = String(opts?.apeadosOrigemLoc || '').trim();
  const rows = [];
  const itemByItemId = new Map(itensComFerramenta.map((it) => [it.item_id, it]));
  const itemIdsComBobina = new Set(bobinas.map((b) => b.item_id));
  const apeadosQtyByItemId = new Map(
    (itensComFerramenta || []).map((it) => [Number(it.item_id), Math.max(0, parseInt(it.quantidade_apeados ?? 0, 10) || 0)])
  );
  const apeadosCountByItemId = new Map();

  for (const b of bobinas) {
    const itemMeta = itemByItemId.get(b.item_id) || {};
    const qty = qtySign * (Number(b.metros) || 0);
    if (qty === 0) continue;

    rows.push({
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
      'New Localização': isDevolucao ? newLocDevolucao : (itemMeta.is_ferramenta ? localizacaoFERR : localizacaoNormal),
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
          __ordem_movimento: 2,
          'Tipo de Movimento': 'APEADOS',
          'Dt_Recepção': dateStr,
          'REF.': String(b.item_codigo || ''),
          DESCRIPTION: String(b.item_descricao || ''),
          QTY: -Math.abs(qty),
          Loc_Inicial: apeadosOrigemLoc || clogLocInicial(isDevolucao, localizacaoOrigemTRA, itemMeta),
          'S/N': b.serialnumber || '',
          Lote: b.lote || '',
          'Novo Armazém': apeadoDestinoCodigo || codigoDestino,
          'TRA / DEV': traDev,
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

    const qtyBase = ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
      ? ri.quantidade_preparada
      : ri.quantidade;
    const qty = qtySign * (Number(qtyBase) || 0);
    if (qty === 0) continue;

    rows.push({
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
      'New Localização': isDevolucao ? newLocDevolucao : (ri.is_ferramenta ? localizacaoFERR : localizacaoNormal),
      DEP: '',
      Observações: colaboradorObs
    });

    if (isApeados && isDevolucao) {
      const apeadosQtyRaw = Math.max(0, parseInt(ri.quantidade_apeados ?? 0, 10) || 0);
      const apeadosQty = Math.max(0, Math.min(Math.abs(Number(qtyBase) || 0), apeadosQtyRaw));
      if (apeadosQty > 0) {
        rows.push({
          __ordem_movimento: 2,
          'Tipo de Movimento': 'APEADOS',
          'Dt_Recepção': dateStr,
          'REF.': String(ri.item_codigo || ''),
          DESCRIPTION: String(ri.item_descricao || ''),
          QTY: -Math.abs(apeadosQty),
          Loc_Inicial: apeadosOrigemLoc || clogLocInicial(isDevolucao, localizacaoOrigemTRA, ri),
          'S/N': ri.serialnumber || '',
          Lote: ri.lote || '',
          'Novo Armazém': apeadoDestinoCodigo || codigoDestino,
          'TRA / DEV': traDev,
          'New Localização': apeadoDestinoLoc || apeadoDestinoCodigo || '',
          DEP: '',
          Observações: colaboradorObs
        });
      }
    }
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
      ao.tipo as armazem_origem_tipo,
      aa.codigo as devolucao_apeado_destino_codigo
    FROM requisicoes r
    INNER JOIN armazens a ON r.armazem_id = a.id
    LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
    LEFT JOIN armazens aa ON r.devolucao_apeado_destino_id = aa.id
    WHERE r.id = ANY($1::int[])
  `, [idsUnique]);

  const byId = new Map(reqRes.rows.map((r) => [r.id, r]));
  const candidatas = idsClean.map((id) => byId.get(id)).filter(Boolean)
    .filter((r) => podeExportarClog(r) && r.armazem_origem_id && String(r.tra_numero || '').trim());
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
  const origemIdsCentral = [...new Set(elegiveis.map((r) => r.armazem_origem_id))];
  const destArmIds = [...new Set(elegiveis.map((r) => r.armazem_id))];
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
      dateForReq || formatDateBR(new Date()),
      codigoDestino,
      r.observacoes || '',
      r.tra_numero || '',
      localizacaoOrigemTRA,
      localizacaoFERR,
      localizacaoNormal,
      itens,
      bobinas,
      {
        isDevolucao,
        isApeados:
          String(r.status || '') === 'APEADOS' &&
          Boolean(r.devolucao_tra_apeados_gerada_em) &&
          Boolean(String(r.devolucao_tra_apeados_numero || '').trim()),
        apeadoDestinoCodigo: String(r.devolucao_apeado_destino_codigo || '').trim(),
        apeadoDestinoLoc: recByApeadoId.get(Number(r.devolucao_apeado_destino_id)) || '',
        apeadosOrigemLoc: recByDestArm.get(r.armazem_id) || LOCALIZACAO_RECEBIMENTO_FALLBACK,
        devolucaoDestinoLoc: recByDestArm.get(r.armazem_id) || LOCALIZACAO_RECEBIMENTO_FALLBACK
      }
    );
    allRows.push(...rows);
  }

  return allRows;
}

router.get('/movimentos-clog/consulta', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    if (!usuarioTemPermissaoConsultaMovimentos(req)) {
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
    const localizacao = String(req.query?.localizacao || '').trim().toLowerCase();
    const apenasMinhas = String(req.query?.minhas || '').trim() === '1';
    const pageSizeRaw = parseInt(String(req.query?.page_size || '200'), 10);
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.max(50, Math.min(pageSizeRaw, 500)) : 200;
    const startOffsetRaw = parseInt(String(req.query?.offset || '0'), 10);
    const startOffset = Number.isFinite(startOffsetRaw) ? Math.max(0, startOffsetRaw) : 0;
    const reqBatchSize = 200;
    const maxBatches = 25;
    const columns = ['Tipo de Movimento', 'Dt_Recepção', 'REF.', 'DESCRIPTION', 'QTY', 'Loc_Inicial', 'S/N', 'Lote', 'Novo Armazém', 'TRA / DEV', 'New Localização', 'DEP', 'Observações'];

    const where = [];
    const params = [];
    let idx = 1;
    const add = (sqlPart, value) => {
      where.push(sqlPart.replace('?', `$${idx}`));
      params.push(value);
      idx += 1;
    };

    // Requisições aptas para Clog na consulta.
    where.push(`COALESCE(TRIM(r.tra_numero), '') <> ''`);
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
      const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
      if (allowed.length === 0) {
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
      // - devolução viatura->central: scope pelo armazém central destino (r.armazem_id)
      where.push(`(
        (r.armazem_origem_id IS NOT NULL AND r.armazem_origem_id = ANY($${idx}::int[]))
        OR (
          EXISTS (SELECT 1 FROM armazens ao WHERE ao.id = r.armazem_origem_id AND LOWER(TRIM(COALESCE(ao.tipo, ''))) = 'viatura')
          AND EXISTS (SELECT 1 FROM armazens ad WHERE ad.id = r.armazem_id AND LOWER(TRIM(COALESCE(ad.tipo, ''))) = 'central')
          AND r.armazem_id = ANY($${idx + 1}::int[])
        )
      )`);
      params.push(allowed, allowed);
      idx += 2;
    }

    const passesRowFilter = (row) => {
      const tipoOk = !tipoMovimento || String(row['Tipo de Movimento'] || '').toLowerCase().includes(tipoMovimento);
      const refOk = !ref || String(row['REF.'] || '').toLowerCase().includes(ref);
      const descOk = !description || String(row.DESCRIPTION || '').toLowerCase().includes(description);
      const serialOk = !serial || String(row['S/N'] || '').toLowerCase().includes(serial);
      const loteOk = !lote || String(row.Lote || '').toLowerCase().includes(lote);
      const armOk = !armazem || String(row['Novo Armazém'] || '').toLowerCase().includes(armazem);
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
      return Boolean(tipoOk && refOk && descOk && serialOk && loteOk && armOk && locOk && qOk);
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

      let rows = await buildClogRowsForRequisicaoIds(ids, (r) => dateById.get(Number(r?.id)) || formatDateBR(new Date()));
      rows = (rows || []).map((r) => ({ ...r, Observações: '' }));
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
      const dA = parseDateBr(a['Dt_Recepção']);
      const dB = parseDateBr(b['Dt_Recepção']);
      if (dA !== dB) return dB - dA;
      const traA = String(a['TRA / DEV'] || '');
      const traB = String(b['TRA / DEV'] || '');
      const traCmp = traB.localeCompare(traA);
      if (traCmp !== 0) return traCmp;
      const refA = String(a['REF.'] || '');
      const refB = String(b['REF.'] || '');
      const refCmp = refA.localeCompare(refB);
      if (refCmp !== 0) return refCmp;
      const ordA = Number(a.__ordem_movimento || 9);
      const ordB = Number(b.__ordem_movimento || 9);
      return ordA - ordB;
    });
    const outRowsClean = outRows.map(({ __ordem_movimento, ...rest }) => rest);

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

async function buildClogRowsFromRequisicao(requisicao, dateStr) {
  if (!requisicao?.armazem_origem_id) return { rows: [], eligible: false, reason: 'Requisição sem armazém de origem.' };
  if (!String(requisicao?.tra_numero || '').trim()) {
    return { rows: [], eligible: false, reason: 'Guarde o Nº TRA antes de gerar/abrir o Clog.' };
  }

  const armazemOrigem = await pool.query('SELECT id, codigo, tipo FROM armazens WHERE id = $1', [requisicao.armazem_origem_id]);
  if (armazemOrigem.rows.length === 0) {
    return { rows: [], eligible: false, reason: 'Armazém de origem não encontrado.' };
  }
  const tipoOrigem = (armazemOrigem.rows[0].tipo || '').toLowerCase();
  const tipoDestino = String(requisicao.armazem_destino_tipo || '').toLowerCase();
  const fluxoDevolucao = isFluxoDevolucaoViaturaCentral(tipoOrigem, tipoDestino);

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
    localizacaoRecebimentoDestino = await localizacaoArmazemPorTipoConn(pool, armazemDestinoId, 'recebimento');
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
    requisicao.tra_numero || '',
    localizacaoOrigemTRA,
    localizacaoFERR,
    localizacaoNormal,
    itensComFerramenta,
    bobinas,
    {
      isDevolucao: fluxoDevolucao,
      isApeados:
        String(requisicao?.status || '') === 'APEADOS' &&
        Boolean(requisicao?.devolucao_tra_apeados_gerada_em) &&
        Boolean(String(requisicao?.devolucao_tra_apeados_numero || '').trim()),
      apeadoDestinoCodigo: apeadoDestinoCodigoClog,
      apeadoDestinoLoc: apeadoDestinoLocClog,
      apeadosOrigemLoc: localizacaoRecebimentoDestino || LOCALIZACAO_RECEBIMENTO_FALLBACK,
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
          'Nenhuma requisição elegível para Clog (requer TRA/DEV em Entregue ou requisição finalizada).',
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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
    if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
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
      if (orig != null && isFluxoDevolucaoViaturaCentral(tipoOrigemCriar, tipoDestinoCriar)) {
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

      // Página 1 (requisição): reconhecer destino por Vxxx (viaturas) e também por código/descrição de central.
      const armazemDestino = await resolveArmazemDestinoFromSheet(sheet);
      if (!armazemDestino) {
        throw new Error('Não foi possível identificar o armazém destino no Excel (código/descrição de central ou Vxxx).');
      }

      const armazemDestinoId = armazemDestino.id;
      const armazemDestinoTipo = armazemDestino.tipo;

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
        if (isFluxoDevolucaoViaturaCentral(tO, tD)) {
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
    await client.query('BEGIN');
    let check;
    try {
      check = await client.query(
        `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
                ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
         FROM requisicoes r
         LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
         INNER JOIN armazens a ON r.armazem_id = a.id
         WHERE r.id = $1 FOR UPDATE OF r`,
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
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const stReq = String(check.rows[0].status || '');
    const ehRecebimentoTransfer = hasRecebimentoMarker(check.rows[0]);
    if (!isZero && !ehRecebimentoTransfer && !locOrigem) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Localização de saída (onde está saindo) é obrigatória quando há quantidade preparada.' });
    }
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
      `SELECT ri.*, i.tipocontrolo, i.codigo AS item_codigo,
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

    if (!ehRecebimentoTransfer && !isZero && check.rows[0].armazem_origem_id && check.rows[0].armazem_id) {
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

    let localizacaoDestinoFinal = null;
    if (!isZero) {
      if (ehRecebimentoTransfer) {
        localizacaoDestinoFinal =
          (await localizacaoArmazemPorTipoConn(client, check.rows[0].armazem_origem_id, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;
      } else {
        // Fluxo normal: destino automático em expedição
        localizacaoDestinoFinal = 'EXPEDICAO';
      }
    }

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
      isZero ? null : (ehRecebimentoTransfer ? null : locOrigem),
      isZero ? null : (lote || null),
      serialnumberFinal,
      quantidadeApeadosFinal,
      requisicao_item_id
    ];

    const needStockQty = quantidadeNecessariaStockPreparacao({
      isZero,
      tipoControlo,
      quantidade_preparada,
      bobinas: Array.isArray(bobinas) ? bobinas : [],
      serialsNormalizados,
    });

    try {
      if (!ehRecebimentoTransfer && usuarioTemPermissaoControloStock(req)) {
        await assertStockSuficientePreparacaoLocalizacao(client, {
          armazemOrigemId: check.rows[0].armazem_origem_id,
          itemId: item.item_id,
          itemCodigo: item.item_codigo || String(item.item_id),
          locLabel: isZero ? '' : locOrigem,
          needQty: needStockQty,
        });
      }

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
      if (e.isStockPrepBiz) {
        return res.status(e.status).json(e.payload);
      }
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
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [requisicaoId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
      `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
    const ehRecebimentoTransfer = hasRecebimentoMarker(check.rows[0]);
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [ehRecebimentoTransfer ? 'EM EXPEDICAO' : 'separado', id]
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
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
      `SELECT r.id, r.status, r.separacao_confirmada, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
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
         r.armazem_id,
         r.armazem_origem_id,
         r.separador_usuario_id,
         r.tra_gerada_em,
         r.tra_numero,
         r.devolucao_tra_gerada_em,
         r.devolucao_trfl_gerada_em,
         r.devolucao_tra_apeados_gerada_em,
         r.devolucao_tra_apeados_numero,
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
    const rowPre = check.rows[0];
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, rowPre.armazem_origem_id, {
        requisicao: {
          ...rowPre,
          armazem_origem_tipo: rowPre.origem_tipo,
          armazem_destino_tipo: rowPre.destino_tipo,
        },
      })
    ) {
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
      if (row.status !== 'APEADOS' || !row.devolucao_tra_gerada_em) {
        return res.status(400).json({
          error:
            'No fluxo de devolução, só é possível finalizar após Transferências pendentes (status APEADOS) e com DEV gerado.',
        });
      }
      let temApeados = false;
      let temPendenteArmazenagem = false;
      try {
        const agg = await pool.query(
          `SELECT
             COALESCE(quantidade_preparada, quantidade, 0) AS qprep,
             COALESCE(quantidade_apeados, 0)::int AS qape
           FROM requisicoes_itens
           WHERE requisicao_id = $1`,
          [id]
        );
        for (const ir of agg.rows || []) {
          const total = Math.max(0, Math.floor(Number(ir.qprep) || 0));
          const ape = Math.max(0, parseInt(ir.qape, 10) || 0);
          if (ape > 0) temApeados = true;
          if (Math.max(0, total - ape) > 0) temPendenteArmazenagem = true;
        }
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }

      let docsOk = false;
      if (!temApeados) {
        docsOk = Boolean(
          row.devolucao_trfl_gerada_em || row.devolucao_trfl_pendente_gerada_em
        );
      } else if (!temPendenteArmazenagem) {
        docsOk = Boolean(row.devolucao_tra_apeados_gerada_em);
      } else {
        docsOk =
          Boolean(row.devolucao_tra_apeados_gerada_em) &&
          Boolean(row.devolucao_trfl_pendente_gerada_em);
      }

      if (!docsOk) {
        return res.status(400).json({
          error:
            'No fluxo de devolução, conclua os documentos em falta: sem APEADOS — TRFL interna ou TRFL PENDENTE; só APEADOS — TRA APEADOS; misto — TRA APEADOS e TRFL PENDENTE.',
        });
      }
      if (temApeados && !String(row.devolucao_tra_apeados_numero || '').trim()) {
        return res.status(400).json({
          error: 'Preencha e guarde o número da TRA APEADOS antes de finalizar a devolução.',
        });
      }
    } else if (fluxoCentralApeado) {
      if (!(['separado', 'Entregue'].includes(row.status) && Boolean(row.tra_gerada_em))) {
        return res.status(400).json({
          error: 'Para transferência Central -> APEADO, finalize apenas após gerar a TRA.'
        });
      }
      if (!String(row.tra_numero || '').trim()) {
        return res.status(400).json({ error: 'Preencha o número da TRA antes de finalizar a requisição.' });
      }
    } else if (row.status !== 'Entregue') {
      return res.status(400).json({ error: 'Só é possível finalizar requisições com status Entregue.' });
    } else if (!String(row.tra_numero || '').trim()) {
      return res.status(400).json({ error: 'Preencha o número da TRA antes de finalizar a requisição.' });
    }

    await pool.query('UPDATE requisicoes SET status = $1 WHERE id = $2', ['FINALIZADO', id]);
    res.json({ ok: true, id: parseInt(id, 10), status: 'FINALIZADO' });
  } catch (error) {
    console.error('Erro ao finalizar requisição:', error);
    res.status(500).json({ error: 'Erro ao finalizar requisição', details: error.message });
  }
});

router.patch('/:id/tra-numero', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const traNumero = String(req.body?.tra_numero || '').trim();
    if (!traNumero) {
      return res.status(400).json({ error: 'Número da TRA é obrigatório.' });
    }
    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id, r.tra_gerada_em,
              r.devolucao_tra_gerada_em, r.tra_numero,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    const row = check.rows[0];
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, {
        requisicao: row,
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      return respostaBloqueioSeparador(res);
    }
    if (!row.tra_gerada_em && !row.devolucao_tra_gerada_em) {
      return res.status(400).json({ error: 'Gere a TRA/DEV antes de informar o número.' });
    }
    const isDevolucaoFluxo = Boolean(row.devolucao_tra_gerada_em);
    const traJaDefinida = Boolean(String(row.tra_numero || '').trim());
    if (isDevolucaoFluxo && traJaDefinida && ['APEADOS', 'Entregue', 'FINALIZADO'].includes(String(row.status || ''))) {
      return res.status(400).json({ error: 'Número da DEV não pode ser alterado após mover para Transferências pendentes.' });
    }

    const statusDestino = isDevolucaoFluxo && String(row.status || '') === 'EM EXPEDICAO'
      ? 'APEADOS'
      : row.status;
    const up = await pool.query(
      `UPDATE requisicoes
       SET tra_numero = $1,
           status = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, tra_numero, status`,
      [traNumero, statusDestino, id]
    );
    return res.json({
      ok: true,
      id: up.rows[0].id,
      tra_numero: up.rows[0].tra_numero,
      status: up.rows[0].status,
    });
  } catch (error) {
    if (error && error.code === '42703') {
      return res.status(503).json({
        error: 'Coluna tra_numero em falta na base de dados.',
        details: 'Execute a migração que adiciona o número da TRA em requisicoes.'
      });
    }
    console.error('Erro ao guardar número da TRA:', error);
    return res.status(500).json({ error: 'Erro ao guardar número da TRA', details: error.message });
  }
});

router.patch('/:id/devolucao-tra-apeados-numero', ...requisicaoAuth, denyOperador, async (req, res) => {
  try {
    const { id } = req.params;
    const valor = String(req.body?.devolucao_tra_apeados_numero || '').trim();
    if (!valor) {
      return res.status(400).json({ error: 'Número da TRA APEADOS é obrigatório.' });
    }
    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              r.devolucao_tra_apeados_gerada_em, r.devolucao_tra_apeados_numero
       FROM requisicoes r
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Requisição não encontrada' });
    const row = check.rows[0];
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, row.armazem_origem_id, {
        requisicao: row,
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(row, req)) {
      return respostaBloqueioSeparador(res);
    }
    if (!row.devolucao_tra_apeados_gerada_em) {
      return res.status(400).json({ error: 'Gere a TRA APEADOS antes de informar o número.' });
    }
    if (['Entregue', 'FINALIZADO'].includes(String(row.status || ''))) {
      return res.status(400).json({ error: 'Não é possível alterar o número da TRA APEADOS após encerramento da devolução.' });
    }
    const jaDefinido = String(row.devolucao_tra_apeados_numero || '').trim();
    if (jaDefinido) {
      return res.status(400).json({ error: 'Número da TRA APEADOS já foi guardado e não pode ser alterado.' });
    }
    const up = await pool.query(
      `UPDATE requisicoes
       SET devolucao_tra_apeados_numero = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, devolucao_tra_apeados_numero`,
      [valor, id]
    );
    return res.json({
      ok: true,
      id: up.rows[0].id,
      devolucao_tra_apeados_numero: up.rows[0].devolucao_tra_apeados_numero,
    });
  } catch (error) {
    if (error && error.code === '42703') {
      return res.status(503).json({
        error: 'Coluna devolucao_tra_apeados_numero em falta na base de dados.',
        details: 'Execute a migração que adiciona o número da TRA APEADOS em requisicoes.'
      });
    }
    console.error('Erro ao guardar número da TRA APEADOS:', error);
    return res.status(500).json({ error: 'Erro ao guardar número da TRA APEADOS', details: error.message });
  }
});

  // =========================================================
  // Recebimento de transferência entre armazéns (UI “cards”)
  // =========================================================

  // Parse da Guia de Transporte (PDF) enviada pelo armazém de origem.
  // Regras:
  // - PDF contém 3 cópias (ORIGINAL, DUPLICADO, TRIPLICADO)
  // - Usar apenas a tabela da cópia ORIGINAL
  // - Extrair código do artigo da coluna "Designação dos Bens" (apenas código)
  // - Quantidade na coluna ao lado (na extração textual aparece antes de "UN")
  router.post(
    '/transferencias/recebimento/parse-guia-transporte',
    authenticateToken,
    requisicaoPerfilNegadoMiddleware,
    denyOperador,
    requisicaoScopeMiddleware,
    excelUploadRequisicoes.single('arquivo'),
    async (req, res) => {
      let tempPath = null;
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'Arquivo PDF da guia é obrigatório.' });
        }
        tempPath = req.file.path;
        const mime = String(req.file.mimetype || '').toLowerCase();
        const ext = String(req.file.originalname || '').toLowerCase();
        if (!(mime.includes('pdf') || ext.endsWith('.pdf'))) {
          return res.status(400).json({ error: 'Formato inválido. Envie um PDF.' });
        }

        const buffer = fs.readFileSync(tempPath);
        const textRaw = await extractPdfText(buffer);
        if (!textRaw.trim()) {
          return res.status(400).json({ error: 'Não foi possível extrair texto do PDF.' });
        }

        // 1) Isolar cópia ORIGINAL
        const originalAnchor = textRaw.search(/guia\s+de\s+transporte[\s\r\n]*original/i);
        if (originalAnchor < 0) {
          return res.status(400).json({ error: 'Cópia ORIGINAL não encontrada no PDF.' });
        }
        let originalText = textRaw.slice(originalAnchor);
        const endCandidates = [
          originalText.search(/--\s*1\s+of\s+\d+\s*--/i),
          originalText.search(/guia\s+de\s+transporte[\s\r\n]*duplicado/i),
          originalText.search(/guia\s+de\s+transporte[\s\r\n]*triplicado/i),
        ].filter((x) => x > 0);
        if (endCandidates.length > 0) {
          originalText = originalText.slice(0, Math.min(...endCandidates));
        }

        // 2) Encontrar a tabela da ORIGINAL
        const lines = originalText
          .split(/\r?\n/)
          .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const headerIdx = lines.findIndex((l) => /designa[cç][aã]o\s+dos\s+bens/i.test(l));
        if (headerIdx < 0) {
          return res.status(400).json({ error: 'Tabela de artigos não encontrada na cópia ORIGINAL.' });
        }

        const stopRegex = /(n\.?\s*[ºo]\s*total\s+de|impresso\s+na\s+data|p[aá]gina\s+\d+\s*\/\s*\d+)/i;
        const tableLines = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const ln = lines[i];
          if (stopRegex.test(ln)) break;
          tableLines.push(ln);
        }
        if (tableLines.length === 0) {
          return res.status(400).json({ error: 'Sem linhas de artigos na tabela ORIGINAL.' });
        }

        // 3) Extrair código + quantidade (tolerante a quebra de linha/formato)
        const parseLocaleNumber = (raw) => {
          const s = String(raw || '').replace(/\s+/g, '');
          if (!s) return NaN;
          const lastComma = s.lastIndexOf(',');
          const lastDot = s.lastIndexOf('.');
          if (lastComma !== -1 && lastDot !== -1) {
            const decimalSep = lastComma > lastDot ? ',' : '.';
            const thousandSep = decimalSep === ',' ? '.' : ',';
            const noThousand = s.split(thousandSep).join('');
            const normalized = decimalSep === ',' ? noThousand.replace(',', '.') : noThousand;
            return Number(normalized);
          }
          if (lastComma !== -1) return Number(s.replace(',', '.'));
          return Number(s);
        };
        const startsNewItemRow = (text) => /^\s*\d{4,}\b/.test(String(text || ''));
        const extractCodigo = (text) => {
          const m = /^\s*(\d{4,})\b/.exec(String(text || ''));
          return m ? String(m[1]).trim() : null;
        };
        const extractQuantidade = (text) => {
          const ln = String(text || '');
          const mQtyBeforeUn = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(?:UN|UND\.?|UNID(?:\.|ADE)?S?)\b/i.exec(ln);
          if (mQtyBeforeUn) return parseLocaleNumber(mQtyBeforeUn[1]);
          // fallback: pegar o primeiro número decimal "grande" da linha (normalmente a quantidade),
          // evitando o último valor monetário (ex.: 0,00).
          const nums = ln.match(/\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?/g) || [];
          for (const raw of nums) {
            const n = parseLocaleNumber(raw);
            if (Number.isFinite(n) && n > 0) return n;
          }
          return NaN;
        };

        // Agrupar linhas com base em quebra visual da grelha:
        // uma nova linha de item começa apenas quando a linha inicia com código numérico.
        // Linhas seguintes (mesmo com tokens alfanuméricos) são continuação da descrição.
        const grouped = [];
        for (const ln of tableLines) {
          if (startsNewItemRow(ln) || grouped.length === 0) {
            grouped.push(ln);
          } else {
            grouped[grouped.length - 1] = `${grouped[grouped.length - 1]} ${ln}`.trim();
          }
        }

        const byCodigo = new Map();
        for (let i = 0; i < grouped.length; i++) {
          const line = grouped[i];
          const codigo = extractCodigo(line);
          if (!codigo) continue;

          let qtd = extractQuantidade(line);
          if (!Number.isFinite(qtd) || qtd <= 0) {
            // fallback: tenta próxima linha agrupada (há PDFs em que a qty cai na linha seguinte)
            const next = grouped[i + 1] || '';
            qtd = extractQuantidade(`${line} ${next}`);
          }
          if (!Number.isFinite(qtd) || qtd <= 0) continue;
          byCodigo.set(codigo, (byCodigo.get(codigo) || 0) + qtd);
        }

        const itens = Array.from(byCodigo.entries()).map(([codigo, quantidade]) => ({
          codigo,
          quantidade,
        }));
        if (itens.length === 0) {
          return res.status(400).json({ error: 'Nenhum artigo válido encontrado na cópia ORIGINAL.' });
        }

        // Enriquecer com descrição cadastrada no sistema (quando existir).
        const codigos = itens.map((x) => String(x.codigo || '').trim().toUpperCase()).filter(Boolean);
        const placeholders = codigos.map((_, i) => `$${i + 1}`).join(',');
        let descByCode = new Map();
        if (codigos.length > 0) {
          const lookup = await pool.query(
            `SELECT codigo, descricao
             FROM itens
             WHERE UPPER(TRIM(codigo)) = ANY(ARRAY[${placeholders}])`,
            codigos
          );
          descByCode = new Map(
            (lookup.rows || []).map((r) => [String(r.codigo || '').trim().toUpperCase(), String(r.descricao || '').trim()])
          );
        }
        const itensComDescricao = itens.map((it) => {
          const k = String(it.codigo || '').trim().toUpperCase();
          return {
            ...it,
            descricao: descByCode.get(k) || '',
          };
        });

        return res.json({ itens: itensComDescricao, total_itens: itensComDescricao.length });
      } catch (e) {
        console.error('Erro ao interpretar guia de transporte PDF:', e);
        return res.status(500).json({ error: 'Erro ao interpretar guia de transporte PDF', details: e.message });
      } finally {
        if (tempPath) {
          try {
            fs.unlinkSync(tempPath);
          } catch (_) {}
        }
      }
    }
  );

  // Criar “transferência a receber” a partir de uma lista de materiais.
  // Guarda marcador em `requisicoes.observacoes` e inicializa status em `pendente`.
  // Nesta implementação:
  // - requisicoes.armazem_origem_id = armazém destino (onde o utilizador recebe)
  // - requisicoes.armazem_id      = armazém origem (de onde vêm os bens)
  router.post(
    '/transferencias/recebimento',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { origem_armazem_id, recebimento_armazem_id, origem_fornecedor, itens, observacoes } = req.body || {};

        const origemId = parseInt(String(origem_armazem_id || ''), 10);
        const recebimentoId = parseInt(String(recebimento_armazem_id || ''), 10);
        const origemFornecedor = origem_fornecedor === true || String(origem_fornecedor || '') === '1';
        if ((!origemFornecedor && !Number.isFinite(origemId)) || !Number.isFinite(recebimentoId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Campos obrigatórios: origem_armazem_id e recebimento_armazem_id.' });
        }
        if (!origemFornecedor && origemId === recebimentoId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Origem e recebimento devem ser armazéns diferentes.' });
        }

        if (!Array.isArray(itens) || itens.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Campo obrigatório: itens (array com pelo menos 1 linha).' });
        }

        // Scope: como a requisição será criada com armazem_origem_id = recebimentoId,
        // garantimos que o utilizador tem acesso a esse armazém (via requisicaoScopeMiddleware).
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(recebimentoId)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso ao armazém de recebimento.' });
          }
        }

        // Validar armazéns
        let origemIdFinal = origemId;
        let origemArm = null;
        if (origemFornecedor) {
          const origemFornecedorQ = await client.query(
            `SELECT id, tipo, ativo
             FROM armazens
             WHERE ativo = true
               AND (
                 UPPER(TRIM(codigo)) = 'FORNECEDOR'
                 OR UPPER(TRIM(descricao)) = 'FORNECEDOR'
               )
             ORDER BY id ASC
             LIMIT 1`
          );
          origemArm = origemFornecedorQ.rows[0] || null;
          if (!origemArm) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Armazém FORNECEDOR não encontrado. Cadastre um armazém com código ou descrição "FORNECEDOR".' });
          }
          origemIdFinal = Number(origemArm.id);
        } else {
          const origemArmQ = await client.query('SELECT id, tipo, codigo, descricao, ativo FROM armazens WHERE id = $1', [origemId]);
          origemArm = origemArmQ.rows[0] || null;
        }
        const recvArmQ = await client.query('SELECT id, tipo, codigo, descricao, ativo FROM armazens WHERE id = $1', [recebimentoId]);
        const recvArm = recvArmQ.rows[0];
        if (!origemArm || !recvArm || origemArm.ativo !== true || recvArm.ativo !== true) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Armazém origem/destino não encontrado ou inativo.' });
        }

        // Resolver itens por código -> item_id
        const normalizeCode = (c) => String(c || '').trim();
        const linhas = itens
          .map((x) => ({
            codigo: normalizeCode(x?.codigo),
            quantidade: x?.quantidade,
            descricao: x?.descricao || '',
          }))
          .filter((l) => l.codigo);

        if (linhas.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Nenhum item válido (código em falta).' });
        }

        const resolvedCodes = [];
        for (const l of linhas) {
          const q = Number(l.quantidade);
          if (!Number.isFinite(q) || q <= 0) continue;
          resolvedCodes.push({ codigo: l.codigo, quantidade: q });
        }
        if (resolvedCodes.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Quantidades inválidas: cada linha tem de ter quantidade numérica > 0.' });
        }

        // SELECT por códigos normalizados (UPPER/TRIM)
        const codes = Array.from(new Set(resolvedCodes.map((x) => x.codigo))).slice(0, 500);
        const placeholders = codes.map((_, i) => `$${i + 1}`).join(',');
        const codeParams = codes.map((c) => String(c).trim().toUpperCase());
        const lookup = await client.query(
          `SELECT id, codigo, descricao
           FROM itens
           WHERE UPPER(TRIM(codigo)) = ANY(ARRAY[${placeholders}])`,
          codeParams
        );

        const byCode = new Map((lookup.rows || []).map((r) => [String(r.codigo || '').trim().toUpperCase(), r]));
        for (const l of resolvedCodes) {
          const k = String(l.codigo).trim().toUpperCase();
          if (!byCode.get(k)) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Código de artigo não encontrado no stock: ${l.codigo}` });
          }
        }

        // Inserir requisicao
        const obs = `${RECEBIMENTO_TRANSFERENCIA_MARKER}${observacoes ? `: ${observacoes}` : ''}`;
        const reqInsert = await client.query(
          `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
           VALUES ($1, $2, $3, $4, 'pendente')
           RETURNING id, status, armazem_origem_id, armazem_id, observacoes, created_at`,
          [recebimentoId, origemIdFinal, obs, req.user.id]
        );
        const requisicaoId = reqInsert.rows[0]?.id;

        // Inserir/atualizar itens
        for (const l of resolvedCodes) {
          const k = String(l.codigo).trim().toUpperCase();
          const itemRow = byCode.get(k);
          await client.query(
            `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
             VALUES ($1, $2, $3)
             ON CONFLICT (requisicao_id, item_id)
             DO UPDATE SET quantidade = EXCLUDED.quantidade`,
            [requisicaoId, itemRow.id, l.quantidade]
          );
        }

        await client.query('COMMIT');

        const requisicao = await getRequisicaoComItens(requisicaoId);
        if (!requisicao) return res.status(500).json({ error: 'Erro ao recuperar requisição criada.' });
        // Garantir marker
        requisicao.itens = Array.isArray(requisicao.itens) ? requisicao.itens : [];
        return res.status(201).json(requisicao);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao criar recebimento transferência:', e);
        return res.status(500).json({ error: 'Erro ao criar recebimento transferência', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  // Confirmar materiais (Pendente -> Em processo) marcando quantidades preparadas/confirmadas.
  router.patch(
    '/transferencias/recebimento/:id/confirmar',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const { itens } = req.body || {};
        if (!Array.isArray(itens) || itens.length === 0) {
          return res.status(400).json({ error: 'Campo obrigatório: itens (array).' });
        }

        const lock = await pool.query(
          `SELECT r.*
           FROM requisicoes r
           WHERE r.id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) return res.status(404).json({ error: 'Requisição não encontrada.' });
        const requisicao = lock.rows[0];

        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Esta requisição não é um recebimento de transferência.' });
        }

        if (String(requisicao.status || '') !== 'pendente') {
          return res.status(400).json({ error: 'Só é possível confirmar quando a requisição está pendente.' });
        }

        // Verificar acesso por armazem_origem_id (scope)
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(requisicao.armazem_origem_id)) {
            return res.status(403).json({ error: 'Sem acesso ao armazém de recebimento desta requisição.' });
          }
        }

        const ids = itens
          .map((x) => ({
            requisicao_item_id: parseInt(String(x?.requisicao_item_id || ''), 10),
            quantidade: Number(x?.quantidade_confirmada),
          }))
          .filter((x) => Number.isFinite(x.requisicao_item_id));

        if (!ids.length) return res.status(400).json({ error: 'Nenhuma linha válida de itens.' });

        // Garantir que confirmamos todos os itens da requisição
        const allItemsQ = await pool.query(
          `SELECT id FROM requisicoes_itens WHERE requisicao_id = $1`,
          [reqId]
        );
        const allItemIds = new Set((allItemsQ.rows || []).map((r) => r.id));
        const confirmedItemIds = new Set(ids.map((x) => x.requisicao_item_id));
        for (const iId of allItemIds) {
          if (!confirmedItemIds.has(iId)) {
            return res.status(400).json({
              error: 'Confirme todos os itens desta requisição.',
              missing_item_id: iId,
            });
          }
        }

        // Atualizar linhas e validar quantidades
        for (const l of ids) {
          const q = Number(l.quantidade);
          if (!Number.isFinite(q) || q <= 0) {
            return res.status(400).json({ error: `Quantidade inválida para item ${l.requisicao_item_id}.` });
          }
          await pool.query(
            `UPDATE requisicoes_itens
             SET quantidade_preparada = $1,
                 preparacao_confirmada = true,
                 quantidade_apeados = COALESCE(quantidade_apeados, 0)
             WHERE id = $2 AND requisicao_id = $3`,
            [q, l.requisicao_item_id, reqId]
          );
        }

        // Pendente -> Em processo (usamos EM EXPEDICAO como equivalente UI “Em processo”)
        await pool.query(
          `UPDATE requisicoes
           SET status = 'EM EXPEDICAO',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );

        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        console.error('Erro ao confirmar recebimento transferência:', e);
        return res.status(500).json({ error: 'Erro ao confirmar recebimento transferência', details: e.message });
      }
    }
  );

  // Exportar report de material recebido
  router.get(
    '/transferencias/recebimento/:id/export-reporte',
    ...requisicaoAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const reqId = parseInt(String(id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const requisicao = await getRequisicaoComItens(reqId);
        if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada.' });
        if (!hasRecebimentoMarker(requisicao)) {
          return res.status(400).json({ error: 'Requisição não é um recebimento de transferência.' });
        }
        if (String(requisicao.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Reporte só está disponível quando o recebimento está em processo.' });
        }

        const destino = requisicao?.armazem_origem_descricao || '';
        const origem = requisicao?.armazem_destino_descricao || '';
        const locRecebimentoDestino =
          (await localizacaoArmazemPorTipoConn(pool, requisicao.armazem_origem_id, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;

        const rows = (requisicao.itens || []).map((it) => ({
          Artigo: String(it.item_codigo || '').trim(),
          'Descrição': String(it.item_descricao || '').trim(),
          Quantidade: Number(it.quantidade_preparada ?? it.quantidade ?? 0) || 0,
          ORIGEM: String(origem || '').trim(),
          'S/N': String(it.serialnumber || '').trim(),
          LOTE: String(it.lote || '').trim(),
          DESTINO: String(locRecebimentoDestino || destino || '').trim(),
          Observações: '',
        }));

        await pool.query(
          `UPDATE requisicoes
           SET tra_gerada_em = COALESCE(tra_gerada_em, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );

        const filename = `MATERIAL_RECEBIDO_requisicao_${reqId}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        await buildExcelReporte(rows, res, filename, { includeObservacoes: false });
      } catch (e) {
        console.error('Erro ao exportar report material recebido:', e);
        return res.status(500).json({ error: 'Erro ao exportar report', details: e.message });
      }
    }
  );

  router.patch(
    '/transferencias/recebimento/:id/receber-stock',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      const client = await pool.connect();
      try {
        if (!usuarioTemPermissaoControloStock(req)) {
          return res.status(403).json({ error: 'Sem permissão de controlo de stock.' });
        }
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        await client.query('BEGIN');
        const lock = await client.query(
          `SELECT id, status, observacoes, armazem_origem_id, tra_gerada_em, tra_baixa_expedicao_aplicada_em
           FROM requisicoes
           WHERE id = $1
           FOR UPDATE`,
          [reqId]
        );
        if (!lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Requisição não encontrada.' });
        }
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Só é possível receber stock quando estiver Em processo.' });
        }
        if (!row.tra_gerada_em) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Gere o report antes de receber stock.' });
        }
        if (row.tra_baixa_expedicao_aplicada_em) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Stock já recebido para esta requisição.' });
        }

        const itensQ = await client.query(
          `SELECT ri.id, ri.item_id, ri.quantidade, ri.quantidade_preparada, i.codigo AS item_codigo, i.tipocontrolo
           FROM requisicoes_itens ri
           INNER JOIN itens i ON i.id = ri.item_id
           WHERE ri.requisicao_id = $1`,
          [reqId]
        );
        const requisicaoItemIds = (itensQ.rows || []).map((x) => Number(x.id)).filter(Number.isFinite);
        const bobinasQ = requisicaoItemIds.length > 0
          ? await client.query(
              `SELECT b.requisicao_item_id, ri.item_id, b.lote, b.serialnumber, b.metros
               FROM requisicoes_itens_bobinas b
               INNER JOIN requisicoes_itens ri ON ri.id = b.requisicao_item_id
               WHERE b.requisicao_item_id = ANY($1::int[])`,
              [requisicaoItemIds]
            )
          : { rows: [] };

        const locRec =
          (await localizacaoArmazemPorTipoConn(client, row.armazem_origem_id, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;
        await aplicarStockDevolucaoEntradaRecebimento(client, {
          centralId: row.armazem_origem_id,
          locRec,
          itensComFerramenta: itensQ.rows || [],
          bobinas: bobinasQ.rows || [],
        });

        await client.query(
          `UPDATE requisicoes
           SET tra_baixa_expedicao_aplicada_em = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );
        await client.query('COMMIT');
        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erro ao receber stock de recebimento:', e);
        return res.status(500).json({ error: 'Erro ao receber stock', details: e.message });
      } finally {
        client.release();
      }
    }
  );

  router.patch(
    '/transferencias/recebimento/:id/finalizar',
    ...requisicaoAuth,
    denyOperador,
    async (req, res) => {
      try {
        const reqId = parseInt(String(req.params.id || ''), 10);
        if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'ID inválido.' });

        const lock = await pool.query(
          `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id
           FROM requisicoes r
           WHERE r.id = $1`,
          [reqId]
        );
        if (!lock.rows.length) return res.status(404).json({ error: 'Requisição não encontrada.' });
        const row = lock.rows[0];
        if (!hasRecebimentoMarker(row)) {
          return res.status(400).json({ error: 'Requisição não é do fluxo de recebimento de mercadoria.' });
        }
        if (!isAdmin(req.user?.role)) {
          const allowed = req.requisicaoArmazemOrigemIds || [];
          if (!allowed.includes(row.armazem_origem_id)) {
            return res.status(403).json({ error: 'Sem acesso a este recebimento.' });
          }
        }
        if (String(row.status || '') !== 'EM EXPEDICAO') {
          return res.status(400).json({ error: 'Só é possível finalizar quando estiver Em processo.' });
        }

        await pool.query(
          `UPDATE requisicoes
           SET status = 'FINALIZADO',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [reqId]
        );
        const updated = await getRequisicaoComItens(reqId);
        return res.json(updated);
      } catch (e) {
        console.error('Erro ao finalizar recebimento de mercadoria:', e);
        return res.status(500).json({ error: 'Erro ao finalizar recebimento', details: e.message });
      }
    }
  );

// Deletar requisição
router.delete('/:id', ...requisicaoAuth, denyOperador, async (req, res) => {
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
