// Carregar variáveis de ambiente
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbUrlConfigured = String(process.env.DATABASE_URL || '').trim();
const railwayUrlConfigured = String(process.env.DATABASE_URL_RAILWAY || '').trim();
if (!dbUrlConfigured && process.env.DB_USER === 'seu_usuario' && !railwayUrlConfigured) {
  console.warn(
    '[CONFIG] Defina DATABASE_URL em server/.env (URL pública do Postgres no Railway). ' +
    'Sem isso o backend usa localhost + placeholders e o login devolve 500.'
  );
}

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const sharp = require('sharp');

const { pool, pgPoolMax } = require('./db/pool');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { v4: uuidv4 } = require('uuid');
const { uploadToS3 } = require('./s3Upload');
const { convertGoogleSheetsUrlToExport } = require('./utils/googleSheets');
const { downloadFile } = require('./utils/downloadFile');
const { buildItensListOrderByClause } = require('./utils/sqlSafe');
const { createS3Client } = require('./utils/s3Client');
const { nomeCompletoUsuario } = require('./utils/usuarioNome');
const { ROLES_VALIDOS } = require('./utils/roles');
const { createArmazemViatura } = require('./utils/createArmazemViatura');
const { cadastrarTodosItensNaoCadastrados } = require('./utils/itensNaoCadastradosCadastroLote');
const { SETORES_VALIDOS } = require('./config/constants');
const { JWT_SECRET, PORT } = require('./config/secrets');
const { createAuthenticateToken } = require('./middleware/auth');
const {
  requisicaoScopeMiddleware,
  requisicaoArmazemOrigemAcessoPermitido,
  assertIdsRequisicoesPermitidas,
  createRequisicaoAuth,
  fetchRequisicoesArmazemIdsForUser,
  usuarioRequisicaoArmazemJunctionTableExists,
  usuariosTemColunaRequisicoesArmazemOrigem,
} = require('./middleware/requisicoesScope');
const { createRequisicoesRouter } = require('./routes/requisicoes');

const vision = require('@google-cloud/vision');
const { detectLabelsFromS3 } = require('./rekognition');
const AWS = require('aws-sdk');
const https = require('https');

const compression = require('compression');

const app = express();
const authenticateToken = createAuthenticateToken(JWT_SECRET);
const requisicaoAuth = createRequisicaoAuth(authenticateToken);

if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(compression({ threshold: '1kb' }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '12mb' }));
app.use('/uploads', express.static('uploads'));

// Servir arquivos estáticos do React em produção
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
}

// Configuração do Multer para upload de imagens
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// --- Importação assíncrona de Excel com progresso em memória ---
const importStatus = {};

function normalizeStockHeader(field) {
  return String(field ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Quantidades no Excel: números, vírgula decimal (PT), milhares com ponto, etc. */
function parseStockQuantity(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0;
  }
  let s = String(value).trim();
  if (!s) return 0;
  s = s.replace(/\s/g, '').replace(/[^\d,.+-]/g, '');
  if (!s || s === '+' || s === '-') return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      s = parts[0].replace(/\./g, '') + '.' + parts[1];
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      s = parts.join('');
    } else if (parts.length === 2 && parts[1].length === 3 && /^[0-9]{1,3}$/.test(parts[0])) {
      s = parts[0] + parts[1];
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const STOCK_NON_WAREHOUSE_KEYS = new Set([
  'artigo',
  'sku',
  'codigo',
  'code',
  'item',
  'cod',
  'ref',
  'ref.',
  'descricao',
  'description',
  'nome',
  'desc',
  'total',
  'soma',
  'sum',
  'tot',
  'quantidade',
  'qty',
  'qtd',
  'stocktotal',
  'totalstock',
  'dep',
  'sumofqty',
  'unidade',
  'medida',
  'unidadedemedida',
  'unidade medida',
  '__rownum__',
]);

function stockCellFromRow(row, candidates) {
  const map = Object.create(null);
  for (const key of Object.keys(row || {})) {
    map[normalizeStockHeader(key)] = row[key];
    map[String(key).trim().toLowerCase()] = row[key];
  }
  for (const c of candidates) {
    const v =
      map[normalizeStockHeader(c)]
      ?? map[String(c).trim().toLowerCase()]
      ?? row[c];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return '';
}

function stockTotalFromRow(row) {
  const direct = stockCellFromRow(row, [
    'Sum of QTY',
    'SUM OF QTY',
    'QTD',
    'TOTAL',
    'Total',
    'SOMA',
    'Sum',
    'TOT',
    'Qtd Total',
    'Quantidade Total',
    'Total Stock',
    'Stock Total',
    'Total Geral',
    'Qtd.',
    'Quantidade',
  ]);
  if (direct !== '') {
    return parseStockQuantity(direct);
  }
  for (const key of Object.keys(row || {})) {
    const norm = normalizeStockHeader(key);
    if (
      norm === 'total'
      || norm === 'soma'
      || norm === 'tot'
      || norm === 'sum'
      || norm === 'quantidadetotal'
      || norm === 'qtdtotal'
      || norm === 'totalstock'
      || norm === 'stocktotal'
      || norm === 'totalgeral'
      || norm === 'sum of qty'
      || norm === 'qtd'
    ) {
      return parseStockQuantity(row[key]);
    }
    if (norm.includes('sum') && norm.includes('qty')) {
      return parseStockQuantity(row[key]);
    }
  }
  return 0;
}

/**
 * Colunas de armazém: WH1, WH 01, e Primavera "WH - A" + quebra de linha + "CACÉM", "WH - MARKT", etc.
 */
function isWarehouseColumnName(rawHeader) {
  const c = String(rawHeader).replace(/^\uFEFF/, '').trim();
  if (!c) return false;
  const u = c.toUpperCase();
  const oneLine = u.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = u.replace(/\s/g, '');
  if (!/^WH/i.test(oneLine)) return false;
  if (/^WHAT\b/i.test(oneLine) || /^WHY\b/i.test(oneLine) || /^WHERE\b/i.test(oneLine)) {
    return false;
  }
  if (/^WH\s*\d/.test(oneLine)) return true;
  if (/^WH\d/.test(compact)) return true;
  if (/^WH[-_.]\d/.test(compact)) return true;
  // Primavera National Stock: "WH - A", "WH - MARKT" (letra ou código após o hífen)
  if (/WH\s*-\s*[A-Z0-9]/i.test(oneLine)) return true;
  return false;
}

function warehouseColumnDisplayLabel(rawHeader) {
  return String(rawHeader)
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stockArmazensFromRow(row) {
  const armazens = {};
  for (const col of Object.keys(row || {})) {
    const norm = normalizeStockHeader(col);
    if (!norm || STOCK_NON_WAREHOUSE_KEYS.has(norm)) continue;
    if (norm === 'unidade' || norm === 'medida' || norm.includes('unidade')) continue;
    if (!isWarehouseColumnName(col)) continue;
    const label = warehouseColumnDisplayLabel(col);
    armazens[label] = parseStockQuantity(row[col]);
  }
  return armazens;
}

function sumArmazensQuantidades(armazens) {
  return Object.values(armazens || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** Descobre em que linha (0-based) estão os cabeçalhos (Artigo, REF., WH1, Sum of QTY, …). */
function scoreStockSheetHeaderKeys(keys) {
  if (!keys.length) return -1000;
  const norms = keys.map((k) => normalizeStockHeader(String(k)));
  let score = 0;
  const emptyLike = keys.filter((k) => String(k).startsWith('__EMPTY')).length;
  score -= emptyLike * 4;
  for (let ki = 0; ki < keys.length; ki += 1) {
    const k = keys[ki];
    const n = norms[ki];
    if (!n || n.startsWith('__empty')) continue;
    if (n.includes('artigo') || n === 'ref' || n.startsWith('ref.') || n.includes('referencia')) score += 5;
    if (n === 'cod' || n.includes('codigo')) score += 3;
    if (n.includes('descri') || n.includes('description')) score += 3;
    if (n.includes('sum') && n.includes('qty')) score += 6;
    if (n === 'qtd' || n === 'total' || n.includes('total')) score += 2;
    if (n.includes('qty') || n.includes('quantidade')) score += 2;
    if (n.startsWith('wh') && /\d/.test(n)) score += 4;
    if (isWarehouseColumnName(k)) score += 5;
    if (n === 'dep' || n.includes('depart')) score += 2;
  }
  return score;
}

function detectStockImportStartRow(sheet) {
  let best = 6;
  let bestScore = -Infinity;
  for (let r = 0; r <= 30; r += 1) {
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
      range: r,
      raw: false,
    });
    if (!rows.length) continue;
    const s = scoreStockSheetHeaderKeys(Object.keys(rows[0]));
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (bestScore < -100) return 6;
  console.log(
    `📋 Stock nacional: cabeçalhos na linha ${best + 1} do Excel (índice ${best}, score ${bestScore})`
  );
  return best;
}

/** Folha resumo com colunas WH (evita importar só "PRIMAVERA STOCK_DETAIL" por engano). */
function pickStockNationalSheetName(workbook) {
  const names = workbook.SheetNames || [];
  if (!names.length) return undefined;
  const exact = names.find((n) => /^PRIMAVERA STOCK_RESUME$/i.test(String(n).trim()));
  if (exact) return exact;
  const resume = names.find(
    (n) =>
      /stock/i.test(n)
      && /resume|resumo/i.test(n)
      && !/detail|detalhe/i.test(n)
      && !/\bape\b/i.test(String(n).toLowerCase())
  );
  if (resume) return resume;
  const anyResume = names.find((n) => /resume|resumo/i.test(n) && !/detail|detalhe/i.test(n));
  return anyResume || names[0];
}

/** Departamento / local pivot (cabeçalhos variam entre ficheiros e exportações). */
function depFromRow(row) {
  const direct = stockCellFromRow(row, [
    'DEP',
    'Dep',
    'dep',
    'DEP.',
    'Departamento',
    'DEPARTAMENTO',
    'Department',
    'Dept',
    'DEPT',
    'Depto',
    'DEPART',
    'Local',
    'LOCAL',
    'Viatura',
    'Centro',
  ]);
  if (direct) return direct;
  for (const key of Object.keys(row || {})) {
    const n = normalizeStockHeader(key);
    if (
      n === 'dep'
      || n === 'depto'
      || n.includes('departamento')
      || n.includes('department')
      || (n.includes('local') && !n.includes('localizacao'))
    ) {
      const v = row[key];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
}

/** Coluna tipo "Sum of QTY" do pivot (nome varia). */
function sumOfQtyFromRow(row) {
  if (row['Sum of QTY'] !== undefined && String(row['Sum of QTY']).trim() !== '') {
    return parseStockQuantity(row['Sum of QTY']);
  }
  for (const key of Object.keys(row || {})) {
    const n = normalizeStockHeader(key);
    if (n.includes('sum') && n.includes('qty')) {
      return parseStockQuantity(row[key]);
    }
  }
  return stockTotalFromRow(row);
}

/**
 * O mesmo código aparece em várias linhas (ex.: um DEP por linha). Junta quantidades por armazém/DEP
 * e define itens.quantidade = soma coerente com o detalhe.
 */
function aggregateStockRecordsByCodigo(records) {
  const map = new Map();
  for (const rec of records) {
    const c = String(rec.codigo || '').trim();
    if (!c) continue;
    if (!map.has(c)) {
      map.set(c, {
        codigo: c,
        nome: rec.nome || c,
        descricao: rec.descricao || rec.nome || c,
        quantidadeSum: 0,
        armazens: {},
        lineIdx: rec.lineIdx != null ? rec.lineIdx : 999999,
      });
    }
    const a = map.get(c);
    a.quantidadeSum += Number(rec.quantidade) || 0;
    if (rec.lineIdx != null) a.lineIdx = Math.min(a.lineIdx, rec.lineIdx);
    if (rec.nome) a.nome = rec.nome;
    if (rec.descricao) a.descricao = rec.descricao;
    for (const [k, v] of Object.entries(rec.armazens || {})) {
      const kk = String(k).trim();
      if (!kk) continue;
      const q = Math.round(Number(v)) || 0;
      a.armazens[kk] = (a.armazens[kk] || 0) + q;
    }
  }

  let ord = 0;
  return Array.from(map.values()).map((a) => {
    const sumWh = sumArmazensQuantidades(a.armazens);
    let qty = a.quantidadeSum;
    if (sumWh > qty) qty = sumWh;
    if (qty === 0 && sumWh > 0) qty = sumWh;
    let arms = { ...a.armazens };
    if (Object.keys(arms).length === 0 && qty > 0) {
      arms = { 'Sem detalhe de armazém': qty };
    }
    return {
      codigo: a.codigo,
      nome: a.nome,
      descricao: a.descricao,
      quantidade: qty,
      armazens: arms,
      idx: a.lineIdx === 999999 ? 0 : a.lineIdx,
      ordem_importacao: ord++,
    };
  });
}

/**
 * Uma linha do Excel pode ter 1 ou 2 artigos (ex.: REF.+Sum of QTY e COD+QTD lado a lado).
 */
function stockRecordsFromImportRow(row) {
  const records = [];

  const codigoA = stockCellFromRow(row, [
    'REF.',
    'REF',
    'Referência',
    'Referencia',
    'Artigo',
    'ARTIGO',
    'Sku',
    'SKU',
    'Codigo',
    'Código',
    'Code',
    'Item',
  ]);
  const descA = stockCellFromRow(row, [
    'DESCRIPTION',
    'Description',
    'Descrição',
    'Descricao',
    'Nome',
    'Desc.',
    'Desc',
  ]);
  const dep = depFromRow(row);
  const qA = sumOfQtyFromRow(row);

  let armA = stockArmazensFromRow(row);
  if (Object.keys(armA).length === 0) {
    if (dep) {
      armA = { [dep]: qA };
    } else if (qA !== 0 || String(row['Sum of QTY'] ?? '').trim() === '0') {
      armA = { 'Sem detalhe de armazém': qA };
    }
  }
  let qtyItemA = qA;
  if (qtyItemA === 0) qtyItemA = sumArmazensQuantidades(armA);

  if (codigoA) {
    records.push({
      codigo: codigoA,
      nome: descA || codigoA,
      descricao: descA || codigoA,
      quantidade: qtyItemA,
      armazens: armA,
    });
  }

  const codigoB = stockCellFromRow(row, ['COD', 'Cod']);
  const descB = stockCellFromRow(row, ['DESCRIÇÃO', 'DESCRICAO', 'Descricao', 'Desc']);
  let qB = 0;
  if (row.QTD !== undefined && String(row.QTD).trim() !== '') {
    qB = parseStockQuantity(row.QTD);
  }
  const depB = dep;
  let armB = {};
  if (qB !== 0 || String(row.QTD ?? '').trim() === '0') {
    armB = depB ? { [depB]: qB } : { 'Sem detalhe de armazém': qB };
  }
  const qtyItemB = qB || sumArmazensQuantidades(armB);

  if (codigoB && codigoB !== codigoA) {
    records.push({
      codigo: codigoB,
      nome: descB || codigoB,
      descricao: descB || codigoB,
      quantidade: qtyItemB,
      armazens: armB,
    });
  }

  return records;
}

const excelUpload = multer({ dest: 'uploads/' });
app.post('/api/importar-excel', authenticateToken, excelUpload.single('arquivo'), async (req, res) => {
  
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar dados.' });
  }
  
  // Verificar se é importação via arquivo ou Google Sheets
  const googleSheetsUrl = req.body.googleSheetsUrl;
  const isGoogleSheets = googleSheetsUrl && googleSheetsUrl.trim();
  
  if (!req.file && !isGoogleSheets) {
    return res.status(400).json({ error: 'Arquivo não enviado ou URL do Google Sheets não fornecida.' });
  }
  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    erros: [],
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };
  res.json({ message: 'Importação iniciada', importId });

  setImmediate(async () => {
    try {
      let workbook;
      let filePath;
      
      if (isGoogleSheets) {
        // Processar Google Sheets
        console.log('📊 Processando Google Sheets:', googleSheetsUrl);
        
        // Converter URL para formato de exportação
        const exportUrl = convertGoogleSheetsUrlToExport(googleSheetsUrl);
        if (!exportUrl) {
          throw new Error('URL do Google Sheets inválida');
        }
        
        // Download do arquivo do Google Sheets
        filePath = `uploads/google_sheets_${Date.now()}.xlsx`;
        await downloadFile(exportUrl, filePath);
        
        workbook = XLSX.readFile(filePath);
      } else {
        // Processar arquivo local
        workbook = XLSX.readFile(req.file.path);
        filePath = req.file.path;
      }
      
      const sheetName = pickStockNationalSheetName(workbook);
      const sheet = workbook.Sheets[sheetName];
      console.log(`📄 Folha de stock: "${sheetName}"`);

      const headerRowIndex = detectStockImportStartRow(sheet);
      const data = XLSX.utils.sheet_to_json(sheet, {
        defval: '',
        range: headerRowIndex,
        raw: false,
      });

      const rawStockRecs = [];
      data.forEach((row, lineIdx) => {
        for (const rec of stockRecordsFromImportRow(row)) {
          if (rec.codigo) rawStockRecs.push({ ...rec, lineIdx });
        }
      });
      const aggregatedStock = aggregateStockRecordsByCodigo(rawStockRecs);

      console.log(
        `📊 Importação iniciada: ${data.length} linhas Excel → ${aggregatedStock.length} artigos únicos (cabeçalho linha ${headerRowIndex + 1})`
      );

      importStatus[importId].status = 'importando';
      importStatus[importId].total = aggregatedStock.length;
      let processados = 0;
      const BATCH_SIZE = 50;
      const codigosAtivosArr = aggregatedStock.map((r) => r.codigo);
      await pool.query(
        'UPDATE itens SET ativo = (codigo IS NOT NULL AND codigo = ANY($1::text[]))',
        [codigosAtivosArr]
      );

      for (let batchStart = 0; batchStart < aggregatedStock.length; batchStart += BATCH_SIZE) {
        const batch = aggregatedStock.slice(batchStart, batchStart + BATCH_SIZE);
        const valid = batch.map((rec) => ({
          idx: rec.idx,
          codigo: rec.codigo,
          nome: rec.nome,
          descricao: rec.descricao || rec.nome,
          quantidade: rec.quantidade,
          ordem_importacao: rec.ordem_importacao,
          armazens: rec.armazens,
        }));

        processados += batch.length;
        importStatus[importId].processados = processados;

        if (valid.length === 0) continue;

        try {
          const codigos = valid.map((v) => v.codigo);
          const itRes = await pool.query('SELECT id, codigo FROM itens WHERE codigo = ANY($1::text[])', [codigos]);
          const codigoToId = new Map(itRes.rows.map((r) => [r.codigo, r.id]));

          const missing = valid.filter((v) => !codigoToId.has(v.codigo));
          const found = valid.filter((v) => codigoToId.has(v.codigo));

          if (missing.length > 0) {
            const missCodes = missing.map((m) => m.codigo);
            const naoRes = await pool.query(
              'SELECT codigo FROM itens_nao_cadastrados WHERE codigo = ANY($1::text[])',
              [missCodes]
            );
            const naoSet = new Set(naoRes.rows.map((r) => r.codigo));
            const toInsert = missing.filter((m) => !naoSet.has(m.codigo));
            const toUpdate = missing.filter((m) => naoSet.has(m.codigo));

            if (toInsert.length > 0) {
              await pool.query(
                `INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens, data_importacao)
                 SELECT t.codigo, t.descricao, t.armazens::jsonb, CURRENT_TIMESTAMP
                 FROM unnest($1::text[], $2::text[], $3::text[]) AS t(codigo, descricao, armazens)`,
                [
                  toInsert.map((x) => x.codigo),
                  toInsert.map((x) => x.nome),
                  toInsert.map((x) => JSON.stringify(x.armazens)),
                ]
              );
            }
            if (toUpdate.length > 0) {
              await pool.query(
                `UPDATE itens_nao_cadastrados n SET
                   descricao = d.descricao,
                   armazens = d.armazens::jsonb,
                   data_importacao = CURRENT_TIMESTAMP
                 FROM unnest($1::text[], $2::text[], $3::text[]) AS d(codigo, descricao, armazens)
                 WHERE n.codigo = d.codigo`,
                [
                  toUpdate.map((x) => x.codigo),
                  toUpdate.map((x) => x.nome),
                  toUpdate.map((x) => JSON.stringify(x.armazens)),
                ]
              );
            }

            for (const m of missing) {
              importStatus[importId].erros.push({
                codigo: m.codigo,
                descricao: m.nome || 'N/A',
                motivo: 'Artigo não cadastrado',
                linha: m.idx + 8,
                armazens: m.armazens
              });
            }
          }

          if (found.length > 0) {
            await pool.query(
              `UPDATE itens i SET
                 nome = v.nome,
                 descricao = v.descricao,
                 quantidade = v.quantidade,
                 ordem_importacao = v.ordem_importacao
               FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::int[])
                 AS v(codigo, nome, descricao, quantidade, ordem_importacao)
               WHERE i.codigo = v.codigo`,
              [
                found.map((x) => x.codigo),
                found.map((x) => x.nome),
                found.map((x) => x.descricao),
                found.map((x) => Math.round(Number(x.quantidade)) || 0),
                found.map((x) => x.ordem_importacao)
              ]
            );

            const itemIdsComWh = found
              .filter((x) => Object.keys(x.armazens || {}).length > 0)
              .map((x) => codigoToId.get(x.codigo));
            if (itemIdsComWh.length > 0) {
              await pool.query('DELETE FROM armazens_item WHERE item_id = ANY($1::int[])', [
                itemIdsComWh,
              ]);
            }

            const iIds = [];
            const armNomes = [];
            const armQtds = [];
            for (const f of found) {
              if (Object.keys(f.armazens || {}).length === 0) continue;
              const iid = codigoToId.get(f.codigo);
              for (const [armazem, qtd] of Object.entries(f.armazens)) {
                iIds.push(iid);
                armNomes.push(armazem);
                armQtds.push(Math.round(Number(qtd)) || 0);
              }
            }
            if (iIds.length > 0) {
              await pool.query(
                `INSERT INTO armazens_item (item_id, armazem, quantidade)
                 SELECT * FROM unnest($1::int[], $2::text[], $3::int[]) AS x(item_id, armazem, quantidade)`,
                [iIds, armNomes, armQtds]
              );
            }
          }
        } catch (batchErr) {
          for (const v of valid) {
            importStatus[importId].erros.push({
              codigo: v.codigo,
              descricao: v.nome || 'N/A',
              motivo: 'Erro ao importar lote',
              erro: batchErr?.message || String(batchErr),
              linha: v.idx + 8
            });
          }
        }
      }
      
      // Limpar arquivo temporário
      if (isGoogleSheets && filePath) {
        fs.unlinkSync(filePath);
      } else if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();
    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
      
      // Limpar arquivo temporário em caso de erro
      if (isGoogleSheets && filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkError) {
          console.error('Erro ao remover arquivo temporário:', unlinkError);
        }
      }
    }
  });
});

// Endpoint para consultar status da importação
app.get('/api/importar-excel-status/:id', authenticateToken, (req, res) => {
  const importId = req.params.id;
  if (!importStatus[importId]) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }
  res.json(importStatus[importId]);
});

// Endpoint para consultar status da importação de itens
app.get('/api/importar-itens-status/:importId', authenticateToken, (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { importId } = req.params;
  
  // Teste temporário para simular dados de progresso
  if (importId === 'test-id') {
    return res.json({
      status: 'progresso',
      total: 100,
      processados: Math.floor(Math.random() * 100),
      cadastrados: 10,
      ignorados: 5,
      erros: []
    });
  }
  
  const status = importStatus[importId];
  
  if (!status) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }

  res.json(status);
});

// --- Importação de novos itens via Excel ---
const excelUploadItens = multer({ dest: 'uploads/' });

// Upload para importar requisições via Excel
const excelUploadRequisicoes = multer({ dest: 'uploads/' });
app.post('/api/importar-itens', authenticateToken, excelUploadItens.single('arquivo'), async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar itens.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }
  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    erros: [],
    cadastrados: 0,
    ignorados: 0,
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };
  res.json({ importId });
  setImmediate(async () => {
    try {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      importStatus[importId].status = 'progresso';
      importStatus[importId].total = data.length;
      let cadastrados = 0;
      let ignorados = 0;
      let processados = 0;
      // Buscar todos os códigos já existentes
      const { rows: existentes } = await pool.query('SELECT codigo FROM itens');
      const codigosExistentes = new Set(existentes.map(e => e.codigo));
      // Função para processar um item
      async function processarLinha(row, idx) {
        try {
          const codigo = row['Artigo']?.toString().trim();
          const descricao = row['Descrição']?.toString().trim();
          const nome = descricao;
          const categoria = row['Categoria']?.toString().trim() || 'Sem categoria';
          const quantidade = Number(row['TOTAL']) || 0;
          
          // Novos campos do template atualizado (apenas colunas que existem na tabela)
          const preco = row['Preço'] ? Number(row['Preço']) : null;
          const localizacao = row['Localização']?.toString().trim() || null;
          const observacoes = row['Observações']?.toString().trim() || null;
          const familia = row['Família']?.toString().trim() || null;
          const subfamilia = row['Subfamília']?.toString().trim() || null;
          const setor = row['Setor']?.toString().trim() || null;
          const comprimento = row['Comprimento'] ? Number(row['Comprimento']) : null;
          const largura = row['Largura'] ? Number(row['Largura']) : null;
          const altura = row['Altura'] ? Number(row['Altura']) : null;
          const unidade = row['Unidade']?.toString().trim() || null;
          const peso = row['Peso']?.toString().trim() || null;
          const unidadePeso = row['Unidade Peso']?.toString().trim() || null;
          const unidadeArmazenamento = row['Unidade Armazenamento']?.toString().trim() || null;
          const tipocontrolo = row['Tipo Controle']?.toString().trim() || null;
          
          if (!codigo || !nome) {
            importStatus[importId].erros.push({ linha: idx + 2, motivo: 'Código ou descrição ausente', codigo: codigo || 'N/A' });
            processados++;
            importStatus[importId].processados = processados;
            return;
          }
          if (codigosExistentes.has(codigo)) {
            ignorados++;
            processados++;
            importStatus[importId].ignorados = ignorados;
            importStatus[importId].processados = processados;
            return;
          }
          const result = await pool.query(
            `INSERT INTO itens (
              nome, descricao, categoria, codigo, quantidade, preco, 
              localizacao, observacoes, familia, subfamilia, setor, comprimento, 
              largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
            [nome, descricao, categoria, codigo, quantidade, preco, 
             localizacao, observacoes, familia, subfamilia, setor, comprimento, 
             largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento, tipocontrolo]
          );
          const itemId = result.rows[0].id;
          // Inserir armazéns (colunas WH) em paralelo
          const armazens = {};
          Object.keys(row).forEach(col => {
            if (col.startsWith('WH')) {
              armazens[col] = Number(row[col]) || 0;
            }
          });
          await Promise.all(Object.entries(armazens).map(([armazem, qtd]) =>
            pool.query('INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ($1, $2, $3)', [itemId, armazem, qtd])
          ));
          cadastrados++;
          processados++;
          importStatus[importId].cadastrados = cadastrados;
          importStatus[importId].processados = processados;
          codigosExistentes.add(codigo); // Evita duplicidade no mesmo arquivo
        } catch (err) {
          importStatus[importId].erros.push({ linha: idx + 2, motivo: 'Erro ao cadastrar', erro: err?.message || String(err) });
          processados++;
          importStatus[importId].processados = processados;
        }
      }
      // Processar em lotes de 20
      const BATCH_SIZE = 20;
      for (let batchStart = 0; batchStart < data.length; batchStart += BATCH_SIZE) {
        const batch = data.slice(batchStart, batchStart + BATCH_SIZE);
        await Promise.all(batch.map((row, i) => processarLinha(row, batchStart + i)));
      }
      fs.unlinkSync(req.file.path);
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();
    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
    }
  });
});

// --- Download do template de importação ---
app.get('/api/download-template', authenticateToken, (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    // Criar dados de exemplo para o template (apenas colunas que existem na tabela)
    const dadosExemplo = [
      {
        'Artigo': 'ART001',
        'Descrição': 'Produto de exemplo',
        'Categoria': 'Categoria exemplo',
        'Preço': 100.50,
        'TOTAL': 10,
        'Localização': 'Prateleira A1',
        'Observações': 'Observações do item',
        'Família': 'Família exemplo',
        'Subfamília': 'Subfamília exemplo',
        'Setor': 'Setor exemplo',
        'Comprimento': 10.5,
        'Largura': 5.2,
        'Altura': 3.1,
        'Unidade': 'cm',
        'Peso': '2.5',
        'Unidade Peso': 'kg',
        'Unidade Armazenamento': 'un',
        'Tipo Controle': 'Manual',
        'WH1': 5,
        'WH2': 3,
        'WH3': 2
      }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dadosExemplo);

    // Definir largura das colunas (apenas colunas que existem na tabela)
    const colWidths = [
      { wch: 12 }, // Artigo
      { wch: 30 }, // Descrição
      { wch: 15 }, // Categoria
      { wch: 10 }, // Preço
      { wch: 8 },  // TOTAL
      { wch: 15 }, // Localização
      { wch: 25 }, // Observações
      { wch: 15 }, // Família
      { wch: 15 }, // Subfamília
      { wch: 15 }, // Setor
      { wch: 12 }, // Comprimento
      { wch: 12 }, // Largura
      { wch: 12 }, // Altura
      { wch: 10 }, // Unidade
      { wch: 10 }, // Peso
      { wch: 15 }, // Unidade Peso
      { wch: 20 }, // Unidade Armazenamento
      { wch: 15 }, // Tipo Controle
      { wch: 8 },  // WH1
      { wch: 8 },  // WH2
      { wch: 8 }   // WH3
    ];
    worksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_importacao_itens.xlsx"');
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao gerar template:', error);
    res.status(500).json({ error: 'Erro ao gerar template.' });
  }
});

/** Importar dados dos itens: atalhos S / L / qtd → valores em `itens.tipocontrolo`. */
function normalizeTipoControloImportValor(raw) {
  if (raw == null) return { ok: false, value: null };
  const s = String(raw).trim();
  if (!s) return { ok: false, value: null };
  const u = s.toUpperCase();
  const compact = u.replace(/\s+/g, '');
  if (compact === 'S' || compact === 'S/N' || compact === 'SN') return { ok: true, value: 'S/N' };
  if (compact === 'L' || u === 'LOTE') return { ok: true, value: 'LOTE' };
  if (compact === 'QTD' || u === 'QUANTIDADE' || u === 'QUANTITY') return { ok: true, value: 'Quantidade' };
  if (s === 'S/N' || s === 'LOTE' || s === 'Quantidade') return { ok: true, value: s };
  return { ok: false, value: null };
}

/** Template: uma coluna "tipo de controlo". Outros nomes = compatibilidade (1.ª célula não vazia). */
const TIPO_CONTROLE_IMPORT_ALIASES = [
  'tipo de controlo',
  'Tipo Controle',
  'Tipo de Controlo',
  'Tipo de controlo',
  'Tipo controlo',
  'tipocontrolo'
];

/** Remove BOM e espaços dos cabeçalhos do Excel/CSV para bater com aliases. */
function normalizeImportDadosItensRowKeys(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = String(k).replace(/^\ufeff/, '').trim();
    out[nk] = v;
  }
  return out;
}

function normalizeImportHeaderKey(k) {
  return String(k || '')
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 1.ª célula não vazia pela ordem dos aliases; depois match por cabeçalho normalizado (maiúsculas/acentos). */
function pickImportCellFlexible(row, aliases) {
  if (!row || !aliases || !aliases.length) return '';
  for (const key of aliases) {
    const v = row[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  const normToOriginal = {};
  for (const key of Object.keys(row)) {
    normToOriginal[normalizeImportHeaderKey(key)] = key;
  }
  for (const a of aliases) {
    const orig = normToOriginal[normalizeImportHeaderKey(a)];
    if (orig == null) continue;
    const v = row[orig];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function pickTipoControleCell(row) {
  return pickImportCellFlexible(row, TIPO_CONTROLE_IMPORT_ALIASES);
}

/** Campos opcionais na importação de dados (vários cabeçalhos aceites por campo). */
const IMPORT_DADOS_ITENS_CAMPOS = [
  { field: 'familia', aliases: ['Família', 'Familia'] },
  { field: 'subfamilia', aliases: ['Subfamília', 'Subfamilia'] },
  { field: 'setor', aliases: ['Setor', 'Setores'] },
  { field: 'comprimento', aliases: ['Comprimento'] },
  { field: 'largura', aliases: ['Largura'] },
  { field: 'altura', aliases: ['Altura'] },
  { field: 'unidade', aliases: ['Unidade'] },
  { field: 'peso', aliases: ['Peso'] },
  { field: 'unidadePeso', aliases: ['Unidade Peso', 'Unidade peso'] },
  {
    field: 'unidadearmazenamento',
    // Template: coluna única "Unidade de armazenamento". "Unidade Armazenamento" = alias compatibilidade.
    aliases: [
      'Unidade de armazenamento',
      'Unidade de Armazenamento',
      'Unidade Armazenamento',
      'Unidade armazenamento'
    ]
  },
  { field: 'observacoes', aliases: ['Observações', 'Observacoes'] }
];

const IMPORT_DADOS_CODIGO_ALIASES = ['Código', 'Codigo', 'CODIGO', 'codigo'];

// --- Importação de dados dos itens existentes ---
const dadosItensUpload = multer({ dest: 'uploads/' });
app.post('/api/importar-dados-itens', authenticateToken, dadosItensUpload.single('arquivo'), async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem importar dados.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }

  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    atualizados: 0,
    ignorados: 0,
    erros: [],
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };

  res.json({ 
    message: 'Importação de dados iniciada', 
    importId,
    details: 'Os dados serão processados em segundo plano'
  });

  setImmediate(async () => {
    try {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const data = rawRows.map(normalizeImportDadosItensRowKeys);

      importStatus[importId].status = 'importando';
      importStatus[importId].total = data.length;
      let processados = 0;
      let atualizados = 0;
      let ignorados = 0;

      const colunasPermitidasImportDados = new Set([
        ...IMPORT_DADOS_ITENS_CAMPOS.map((c) => c.field),
        'tipocontrolo'
      ]);

      const codigosTodos = [
        ...new Set(
          data
            .map((row) => pickImportCellFlexible(row, IMPORT_DADOS_CODIGO_ALIASES))
            .filter(Boolean)
        )
      ];
      const idPorCodigo = new Map();
      if (codigosTodos.length > 0) {
        const ex = await pool.query('SELECT id, codigo FROM itens WHERE codigo = ANY($1::text[])', [codigosTodos]);
        for (const r of ex.rows) {
          idPorCodigo.set(r.codigo, r.id);
        }
      }

      for (const row of data) {
        try {
          const codigo = pickImportCellFlexible(row, IMPORT_DADOS_CODIGO_ALIASES);
          if (!codigo) {
            importStatus[importId].erros.push({
              linha: processados + 2,
              motivo: 'Código não informado'
            });
            processados++;
            importStatus[importId].processados = processados;
            continue;
          }

          const itemId = idPorCodigo.get(codigo);
          if (itemId == null) {
            importStatus[importId].erros.push({
              codigo,
              linha: processados + 2,
              motivo: 'Item não encontrado no sistema'
            });
            ignorados++;
            processados++;
            importStatus[importId].processados = processados;
            continue;
          }

          const updateData = {};
          for (const { field, aliases } of IMPORT_DADOS_ITENS_CAMPOS) {
            const valor = pickImportCellFlexible(row, aliases);
            if (valor) updateData[field] = valor;
          }

          const tipoRaw = pickTipoControleCell(row);
          if (tipoRaw) {
            const { ok, value } = normalizeTipoControloImportValor(tipoRaw);
            if (ok) {
              updateData.tipocontrolo = value;
            } else {
              importStatus[importId].erros.push({
                codigo,
                linha: processados + 2,
                motivo: `Tipo Controle inválido: "${tipoRaw}". Use S ou S/N (série), L ou LOTE (lote), qtd ou Quantidade.`
              });
            }
          }

          const keysSeguras = Object.keys(updateData).filter((k) => colunasPermitidasImportDados.has(k));
          if (keysSeguras.length > 0) {
            const setClause = keysSeguras.map((key, index) => `${key} = $${index + 2}`).join(', ');
            const values = keysSeguras.map((k) => updateData[k]);

            await pool.query(`UPDATE itens SET ${setClause} WHERE id = $1`, [itemId, ...values]);
            atualizados++;
          } else {
            ignorados++;
          }

          processados++;
          importStatus[importId].processados = processados;
          importStatus[importId].atualizados = atualizados;
          importStatus[importId].ignorados = ignorados;
        } catch (err) {
          importStatus[importId].erros.push({
            codigo: pickImportCellFlexible(row, IMPORT_DADOS_CODIGO_ALIASES) || 'N/A',
            linha: processados + 2,
            motivo: 'Erro ao processar linha',
            erro: err.message
          });
          processados++;
          importStatus[importId].processados = processados;
        }
      }

      fs.unlinkSync(req.file.path);
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();

    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
    }
  });
});

// Endpoint para consultar status da importação de dados
app.get('/api/importar-dados-itens-status/:id', authenticateToken, (req, res) => {
  const importId = req.params.id;
  if (!importStatus[importId]) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }
  res.json(importStatus[importId]);
});

// Rotas da API

// Autenticação
app.post('/api/login', async (req, res) => {
  const loginIdRaw = req.body.username ?? req.body.login ?? req.body.numero_colaborador;
  const { password } = req.body;
  const loginId = loginIdRaw != null ? String(loginIdRaw).trim() : '';

  if (!loginId || !password) {
    return res.status(400).json({
      error: 'Indique o nº de colaborador ou o utilizador (username) e a palavra-passe.'
    });
  }

  try {
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM usuarios WHERE
          TRIM(COALESCE(numero_colaborador::text, '')) = TRIM($1)
          OR LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1))`,
        [loginId]
      );
    } catch (dbErr) {
      console.error('[LOGIN] Erro no banco:', dbErr.message);
      return res.status(500).json({
        error: 'Erro ao conectar. Verifique se o banco está configurado e se a tabela usuarios existe (com colunas username e password).',
        details: process.env.NODE_ENV === 'development' ? dbErr.message : undefined
      });
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    if (result.rows.length > 1) {
      return res.status(401).json({ error: 'Várias contas correspondem a estes dados. Contacte o administrador.' });
    }

    const user = result.rows[0];
    const hash = user.password || user.senha;
    if (!hash) {
      console.error('[LOGIN] Usuário sem senha no banco (coluna password/senha). Execute a migração migrate-usuarios-username-password.sql');
      return res.status(500).json({ error: 'Configuração do usuário inválida. Execute as migrações do banco.' });
    }

    let validPassword = false;
    try {
      validPassword = bcrypt.compareSync(password, hash);
    } catch (bcryptErr) {
      console.error('[LOGIN] Erro ao verificar senha:', bcryptErr.message);
      return res.status(500).json({ error: 'Erro ao validar senha.' });
    }
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const reqArmIds = await fetchRequisicoesArmazemIdsForUser(user.id);

    try {
      const token = jwt.sign(
        {
          id: user.id,
          username: user.username || String(user.numero_colaborador || ''),
          role: user.role,
          requisicoes_armazem_origem_ids: reqArmIds,
          requisicoes_armazem_origem_id: reqArmIds.length === 1 ? reqArmIds[0] : null
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        message: 'Login realizado com sucesso',
        token,
        user: {
          id: user.id,
          username: user.username || user.numero_colaborador,
          nome: nomeCompletoUsuario(user),
          nome_proprio: user.nome,
          sobrenome: user.sobrenome,
          email: user.email,
          telemovel: user.telemovel,
          numero_colaborador: user.numero_colaborador,
          role: user.role,
          requisicoes_armazem_origem_ids: reqArmIds,
          requisicoes_armazem_origem_id: reqArmIds.length === 1 ? reqArmIds[0] : null
        }
      });
    } catch (jwtErr) {
      console.error('[LOGIN] Erro ao gerar token:', jwtErr.message);
      return res.status(500).json({ error: 'Erro ao gerar sessão.' });
    }
  } catch (e) {
    console.error('[LOGIN]', e);
    return res.status(500).json({ error: 'Erro no login.', details: e.message });
  }
});

// Verificar token (dados atualizados da BD, incl. armazéns de requisições)
app.get('/api/verify-token', authenticateToken, async (req, res) => {
  try {
    let r;
    try {
      r = await pool.query(
        `SELECT id, username, nome, sobrenome, telemovel, email, numero_colaborador, role FROM usuarios WHERE id = $1`,
        [req.user.id]
      );
    } catch (colErr) {
      if (colErr.code !== '42703') throw colErr;
      r = await pool.query(
        `SELECT id, username, nome, email, numero_colaborador, role FROM usuarios WHERE id = $1`,
        [req.user.id]
      );
    }
    if (r.rows.length === 0) {
      return res.status(403).json({ error: 'Utilizador inválido.' });
    }
    const u = r.rows[0];
    const reqArmIds = await fetchRequisicoesArmazemIdsForUser(u.id);
    res.json({
      valid: true,
      user: {
        id: u.id,
        username: u.username,
        nome: nomeCompletoUsuario(u),
        nome_proprio: u.nome,
        sobrenome: u.sobrenome,
        email: u.email,
        telemovel: u.telemovel,
        numero_colaborador: u.numero_colaborador,
        role: u.role,
        requisicoes_armazem_origem_ids: reqArmIds,
        requisicoes_armazem_origem_id: reqArmIds.length === 1 ? reqArmIds[0] : null
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao validar sessão.', details: e.message });
  }
});

// Listar todos os itens (público) COM paginação
app.get('/api/itens', async (req, res) => {
  const incluirInativos = req.query.incluirInativos === 'true';
  const page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 500) limit = 500;
  const offset = (page - 1) * limit;
  const searchTerm = req.query.search || '';
  
  // Parâmetros de filtro
  const familia = req.query.familia || '';
  const subfamilia = req.query.subfamilia || '';
  const setor = req.query.setor || '';
  const categoria = req.query.categoria || '';
  const quantidadeMin = req.query.quantidadeMin || '';
  const quantidadeMax = req.query.quantidadeMax || '';
  const unidadeArmazenamento = req.query.unidadeArmazenamento || '';
  const tipocontrolo = req.query.tipocontrolo || '';
  
  // Parâmetros de ordenação
  const sortBy = req.query.sortBy || '';
  const sortOrder = req.query.sortOrder || 'asc';
  
  let whereConditions = [];
  let params = [];
  let paramIndex = 1;
  
  // Condição para itens ativos/inativos
  if (!incluirInativos) {
    whereConditions.push('i.ativo = true');
  }
  
  // Condição de pesquisa
  if (searchTerm.trim()) {
    whereConditions.push(
      `(LOWER(COALESCE(i.codigo,'')) LIKE LOWER($${paramIndex}) OR LOWER(COALESCE(i.nome,'')) LIKE LOWER($${paramIndex}) OR LOWER(COALESCE(i.descricao,'')) LIKE LOWER($${paramIndex}))`
    );
    params.push(`%${searchTerm.trim()}%`);
    paramIndex++;
  }
  
  // Filtros adicionais
  if (familia.trim()) {
    whereConditions.push(`LOWER(i.familia) LIKE LOWER($${paramIndex})`);
    params.push(`%${familia.trim()}%`);
    paramIndex++;
  }
  
  if (subfamilia.trim()) {
    whereConditions.push(`LOWER(i.subfamilia) LIKE LOWER($${paramIndex})`);
    params.push(`%${subfamilia.trim()}%`);
    paramIndex++;
  }
  
  // Processar múltiplos filtros de setor
  const setoresFiltro = req.query.setor ? (Array.isArray(req.query.setor) ? req.query.setor : [req.query.setor]) : [];
  if (setoresFiltro.length > 0) {
    const setoresConditions = setoresFiltro.map((setor, index) => {
      const paramPos = paramIndex + index;
      return `EXISTS (
        SELECT 1 FROM itens_setores is2 
        WHERE is2.item_id = i.id 
        AND LOWER(is2.setor) LIKE LOWER($${paramPos})
      )`;
    });
    whereConditions.push(`(${setoresConditions.join(' OR ')})`);
    setoresFiltro.forEach(setor => {
      params.push(`%${setor.trim()}%`);
    });
    paramIndex += setoresFiltro.length;
  }
  
  if (categoria.trim()) {
    whereConditions.push(`LOWER(i.categoria) LIKE LOWER($${paramIndex})`);
    params.push(`%${categoria.trim()}%`);
    paramIndex++;
  }
  
  if (quantidadeMin.trim()) {
    const qmin = parseInt(quantidadeMin.trim(), 10);
    if (Number.isFinite(qmin)) {
      whereConditions.push(`i.quantidade >= $${paramIndex}`);
      params.push(qmin);
      paramIndex++;
    }
  }

  if (quantidadeMax.trim()) {
    const qmax = parseInt(quantidadeMax.trim(), 10);
    if (Number.isFinite(qmax)) {
      whereConditions.push(`i.quantidade <= $${paramIndex}`);
      params.push(qmax);
      paramIndex++;
    }
  }
  
  if (unidadeArmazenamento.trim()) {
    whereConditions.push(`LOWER(i.unidadeArmazenamento) LIKE LOWER($${paramIndex})`);
    params.push(`%${unidadeArmazenamento.trim()}%`);
    paramIndex++;
  }
  
  if (tipocontrolo.trim()) {
    whereConditions.push(`LOWER(i.tipocontrolo) LIKE LOWER($${paramIndex})`);
    params.push(`%${tipocontrolo.trim()}%`);
    paramIndex++;
  }
  
  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  /** ORDER BY só com identificadores vindos de whitelist (sqlSafe) — nunca interpolar req.query.sortBy diretamente */
  const orderByClause = buildItensListOrderByClause(sortBy, sortOrder);

  // Query para contar total de itens
  const countQuery = `
    SELECT COUNT(DISTINCT i.id) as total
    FROM itens i
    LEFT JOIN itens_setores is2 ON i.id = is2.item_id
    ${whereClause}
  `;

  // Query principal com paginação
  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens,
           COUNT(DISTINCT img.id) as total_imagens,
           STRING_AGG(DISTINCT is2.setor, ', ') as setores
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    LEFT JOIN itens_setores is2 ON i.id = is2.item_id
    ${whereClause}
    GROUP BY i.id
    ${orderByClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;
  
  // Adicionar parâmetros de paginação
  params.push(limit, offset);

  const countParams = params.slice(0, paramIndex - 1);
  try {
    const [countResult, result] = await Promise.all([
      pool.query(countQuery, countParams),
      pool.query(query, params)
    ]);
    const total = parseInt(countResult.rows[0].total, 10);
    const itens = result.rows.map((row) => ({
      ...row,
      imagens: row.imagens ? row.imagens.split(',') : []
    }));
    res.json({
      itens,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      searchTerm
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota de proxy para imagens do Cloudflare R2
app.get('/api/imagem/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  
  console.log('🔧 [PROXY] Solicitando imagem:', filename);
  
  // Verificar se as credenciais estão configuradas
  // Configurar o cliente S3 para R2
  const s3Client = createS3Client();
  
  if (!s3Client) {
    return res.status(503).json({ 
      error: 'Serviço de armazenamento não configurado',
      message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
    });
  }
  
  const params = {
    Bucket: process.env.R2_BUCKET || 'catalogo-imagens',
    Key: filename
  };
  
  s3Client.getObject(params, (err, data) => {
    if (err) {
      console.error('❌ [PROXY] Erro ao buscar imagem do R2:', err);
      return res.status(404).json({ 
        error: 'Imagem não encontrada',
        details: err.message 
      });
    }
    
    // Determinar o tipo de conteúdo
    const contentType = data.ContentType || 'image/jpeg';
    
    console.log('✅ [PROXY] Imagem encontrada:', filename);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Length', data.ContentLength);
    
    res.send(data.Body);
  });
});

// Buscar item por ID
app.get('/api/itens/:id', (req, res) => {
  const itemId = req.params.id;
  // Buscar item, incluindo setores agregados
  pool.query(`
    SELECT i.*, COALESCE(STRING_AGG(DISTINCT is2.setor, ', '), '') AS setores
    FROM itens i
    LEFT JOIN itens_setores is2 ON is2.item_id = i.id
    WHERE i.id = $1
    GROUP BY i.id
  `, [itemId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    // Processar setores - converter string para array
    const item = result.rows[0];
    let setores = [];
    if (item.setores && item.setores.trim() !== '') {
      setores = item.setores.split(', ').filter(s => s.trim() !== '');
    }
    item.setores = setores;
    // Buscar imagens (normais e de itens compostos)
    pool.query('SELECT * FROM imagens_itens WHERE item_id = $1 ORDER BY is_completo ASC', [itemId], (err, imagensResult) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      // Buscar armazéns
      pool.query('SELECT armazem, quantidade FROM armazens_item WHERE item_id = $1', [itemId], (err, armazensResult) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        // Detecção automática COMPLETAMENTE DESABILITADA para evitar duplicação
        const codigo = result.rows[0].codigo;
        console.log(`🔒 Detecção automática DESABILITADA para item ${codigo}. Imagens existentes: ${imagensResult.rows.length}`);
        if (imagensResult.rows.length > 0) {
          console.log('📋 Imagens existentes no banco:');
          imagensResult.rows.forEach((img, index) => {
            console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}, Caminho: ${img.caminho}`);
          });
        }
        const imagensProcessadas = imagensResult.rows.map(img => {
          let caminhoFinal;
          if (img.caminho.startsWith('/api/imagem/')) {
            caminhoFinal = img.caminho;
          } else if (img.caminho.startsWith('http')) {
            if (img.caminho.includes('r2.cloudflarestorage.com')) {
              const urlParts = img.caminho.split('/');
              const filename = decodeURIComponent(urlParts[urlParts.length - 1]);
              caminhoFinal = `/api/imagem/${encodeURIComponent(filename)}`;
            } else {
              caminhoFinal = img.caminho;
            }
          } else {
            caminhoFinal = `/api/imagem/${encodeURIComponent(img.caminho)}`;
          }
          console.log('Processando imagem:', {
            id: img.id,
            caminhoOriginal: img.caminho,
            caminhoFinal: caminhoFinal,
            nome_arquivo: img.nome_arquivo,
            is_completo: img.is_completo
          });
          return {
            id: img.id,
            caminho: caminhoFinal,
            nome_arquivo: img.nome_arquivo,
            tipo: img.tipo,
            is_completo: img.is_completo || false
          };
        });

        // Separar imagens normais das imagens de itens compostos
        const imagensNormais = imagensProcessadas.filter(img => !img.is_completo);
        const imagensCompostas = imagensProcessadas.filter(img => img.is_completo);
        // Buscar componentes do item
        pool.query(`
          SELECT 
            ic.id,
            ic.quantidade_componente,
            i.id as item_id,
            i.codigo,
            i.descricao,
            i.unidadearmazenamento
          FROM itens_compostos ic
          JOIN itens i ON ic.item_componente_id = i.id
          WHERE ic.item_principal_id = $1
          ORDER BY i.codigo
        `, [itemId], (err, componentesResult) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.json({
            ...result.rows[0],
            imagens: imagensNormais,
            imagensCompostas: imagensCompostas,
            armazens: armazensResult.rows || [],
            componentes: componentesResult.rows
          });
        });
      });
    });
  });
});

// Cadastrar novo item (protegido)
app.post('/api/itens', authenticateToken, upload.fields([
  { name: 'imagens', maxCount: 10 },
  { name: 'imagemCompleta', maxCount: 1 }
]), async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem criar itens.' });
  }

  const {
    nome,
    descricao,
    categoria,
    codigo,
    preco,
    quantidade,
    localizacao,
    observacoes
  } = req.body;

  // Validações obrigatórias
  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  // Verificar se código já existe
  if (codigo) {
    try {
      const result = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
      if (result.rows.length > 0) {
        return res.status(400).json({ error: 'Código já existe' });
      }
      await inserirItem();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    await inserirItem();
  }

  async function inserirItem() {
    // Concatenar peso e unidadePeso se ambos existirem
    let pesoFinal = '';
    if (req.body.peso && req.body.unidadepeso) {
      pesoFinal = `${req.body.peso} ${req.body.unidadepeso}`;
    } else if (req.body.peso) {
      pesoFinal = req.body.peso;
    }
    const itemData = {
      nome: nome || descricao, // Se nome não for enviado, usar descricao como nome
      descricao,
      categoria: categoria || 'Sem categoria', // valor padrão
      codigo,
      preco: preco ? parseFloat(preco) : null,
      quantidade: quantidade ? parseInt(quantidade) : 0,
      localizacao,
      observacoes,
      familia: req.body.familia || '',
      subfamilia: req.body.subfamilia || '',
      setor: req.body.setor || '',
      comprimento: req.body.comprimento ? parseFloat(req.body.comprimento) : null,
      largura: req.body.largura ? parseFloat(req.body.largura) : null,
      altura: req.body.altura ? parseFloat(req.body.altura) : null,
      unidade: req.body.unidade || '',
      peso: pesoFinal,
      unidadepeso: req.body.unidadepeso || '',
      unidadearmazenamento: req.body.unidadeArmazenamento || '',
      tipocontrolo: req.body.tipocontrolo || '',
      ativo: true // Sempre ativo ao cadastrar
    };

    // Logar o corpo da requisição para depuração
    console.log('Dados recebidos no cadastro de item:', req.body);

    try {
      const result = await pool.query(`
        INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, comprimento, largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id
      `, [itemData.nome, itemData.descricao, itemData.categoria, itemData.codigo, itemData.preco, itemData.quantidade, itemData.localizacao, itemData.observacoes,
          itemData.familia, itemData.subfamilia, itemData.comprimento, itemData.largura, itemData.altura, itemData.unidade, itemData.peso, itemData.unidadepeso, itemData.unidadearmazenamento, itemData.tipocontrolo, itemData.ativo]);

      const itemId = result.rows[0].id;

      // Inserir setores múltiplos
      if (req.body.setores) {
        try {
          const setores = JSON.parse(req.body.setores);
          if (Array.isArray(setores) && setores.length > 0) {
            for (const setor of setores) {
              await pool.query(
                'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
                [itemId, setor]
              );
            }
            console.log(`✅ Setores inseridos para item ${itemId}:`, setores);
          }
        } catch (setoresError) {
          console.error(`❌ Erro ao inserir setores: ${setoresError.message}`);
        }
      }

      // Remover item da tabela de itens não cadastrados se existir
      try {
        const deleteResult = await pool.query('DELETE FROM itens_nao_cadastrados WHERE codigo = $1', [codigo]);
        if (deleteResult.rowCount > 0) {
          console.log(`🗑️  Item removido da tabela de não cadastrados: ${codigo}`);
        }
      } catch (deleteError) {
        console.error(`❌ Erro ao remover item da tabela de não cadastrados: ${deleteError.message}`);
      }

      // Salvar imagens no AWS S3
      console.log('🔄 === INÍCIO DO UPLOAD DE IMAGENS (CADASTRO) ===');
      console.log('req.files:', req.files);
      console.log('Arquivos para upload no cadastro:', req.files ? Object.keys(req.files).length : 0);
      
      // Verificar se req.files existe antes de processar
      if (!req.files) {
        console.log('ℹ️  Nenhum arquivo enviado no cadastro');
        console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
        
        res.status(201).json({ 
          message: 'Item cadastrado com sucesso',
          itemId: itemId 
        });
        return;
      }
      
      // Processar imagens normais
      const imagensNormais = req.files && req.files.imagens ? req.files.imagens : [];
      
      // Verificar se há imagens para processar
      if (imagensNormais.length > 0) {
        imagensNormais.forEach((file, index) => {
          console.log(`   ${index + 1}. ${file.originalname} (${file.mimetype})`);
          });
          
          const imagensPromises = imagensNormais.map(async (file) => {
            try {
              // Buscar o código do item para usar no nome do arquivo
              const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
              const codigo = codigoResult.rows[0]?.codigo || itemId;
              
              // Upload para AWS S3 com nome baseado no código
              console.log(`📤 Upload para R2: ${file.originalname}`);
              const s3Result = await uploadToS3(
                file.path,
                `${codigo}_${Date.now()}_${file.originalname}`,
                file.mimetype
              );
              console.log(`✅ Upload concluído: ${s3Result.url}`);
              
              // Salvar informações no banco
              console.log(`💾 Salvando imagem no banco (cadastro): ${file.originalname}`);
              return new Promise((resolve, reject) => {
                pool.query(
                  `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
                   VALUES ($1, $2, $3, $4) RETURNING id`,
                  [itemId, file.originalname, s3Result.url, file.mimetype],
                  (err, result) => {
                    if (err) reject(err);
                    else {
                      console.log(`✅ Imagem salva no banco com ID: ${result.rows[0].id}`);
                      // Remover arquivo local após upload
                      fs.unlink(file.path, (unlinkErr) => {
                        if (unlinkErr) {
                          console.error('Erro ao remover arquivo local:', unlinkErr);
                        } else {
                          console.log(`🗑️  Arquivo local removido: ${file.path}`);
                        }
                      });
                      resolve();
                    }
                  }
                );
              });
            } catch (error) {
              console.error('Erro no upload para AWS S3:', error);
              throw error;
            }
          });

          Promise.all(imagensPromises).then(async () => {
            // Verificar total de imagens após upload
            const totalImagens = await pool.query('SELECT COUNT(*) as total FROM imagens_itens WHERE item_id = $1', [itemId]);
            console.log(`📊 Total de imagens no item ${itemId} após cadastro: ${totalImagens.rows[0].total}`);
            console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
            
            // Processar imagem do item completo se existir
            if (req.files && req.files.imagemCompleta && Array.isArray(req.files.imagemCompleta) && req.files.imagemCompleta.length > 0) {
              const imagemCompleta = req.files.imagemCompleta[0];
              try {
                console.log(`📤 Upload da imagem do item completo: ${imagemCompleta.originalname}`);
                const s3Result = await uploadToS3(
                  imagemCompleta.path,
                  `IC_${codigo}_${Date.now()}_${imagemCompleta.originalname}`,
                  imagemCompleta.mimetype
                );
                console.log(`✅ Upload da imagem completa concluído: ${s3Result.url}`);
                
                // Salvar no banco com flag especial
                await pool.query(
                  `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [itemId, imagemCompleta.originalname, s3Result.url, imagemCompleta.mimetype, true]
                );
                
                // Remover arquivo local
                fs.unlink(imagemCompleta.path, (err) => {
                  if (err) console.error('Erro ao remover arquivo local da imagem completa:', err);
                });
              } catch (error) {
                console.error('Erro no upload da imagem completa:', error);
              }
            }
            
            res.status(201).json({ 
              message: 'Item cadastrado com sucesso',
              itemId: itemId 
            });
          }).catch(err => {
            res.status(500).json({ error: err.message });
          });
        } else {
          console.log('ℹ️  Nenhuma imagem enviada no cadastro');
          console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
          
          res.status(201).json({ 
            message: 'Item cadastrado com sucesso',
            itemId: itemId 
          });
        }
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  }
);

// Buscar itens por imagem (reconhecimento) - PÚBLICO
app.post('/api/reconhecer', upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  }

  // Função para calcular cor média de uma imagem
  async function getAverageColorFromFile(filePath) {
    try {
      const { data, info } = await sharp(filePath).resize(32, 32).raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const pixels = data.length / info.channels;
      return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
    } catch (err) {
      return [0, 0, 0];
    }
  }

  // Calcular cor média da imagem enviada
  const corMediaEnviada = await getAverageColorFromFile(req.file.path);

  // Buscar itens e imagens do banco
  pool.query(`
    SELECT i.*, img.id as img_id, img.caminho as img_caminho
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
  `, async (err, result) => {
    if (err) {
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: err.message });
    }
    // Para cada imagem, calcular cor média
    const itensMap = {};
    const corMediaBanco = [];
    for (const row of result.rows) {
      if (!row.img_caminho) continue;
      try {
        // Baixar imagem do Google Drive se for URL
        let localPath = row.img_caminho;
        if (row.img_caminho.startsWith('http')) {
          // Baixar temporariamente
          const axios = require('axios');
          const tempPath = `uploads/temp_${row.img_id}_${Date.now()}.jpg`;
          const response = await axios({ url: row.img_caminho, responseType: 'arraybuffer' });
          fs.writeFileSync(tempPath, response.data);
          localPath = tempPath;
        }
        const cor = await getAverageColorFromFile(localPath);
        corMediaBanco.push({ itemId: row.id, imgId: row.img_id, caminho: row.img_caminho, cor });
        if (localPath !== row.img_caminho && fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch {}
    }
    // Calcular distância de cor
    function colorDistance(c1, c2) {
      return Math.sqrt((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2);
    }
    // Para cada item, pegar a menor distância de cor entre as imagens
    const itemScores = {};
    for (const img of corMediaBanco) {
      const dist = colorDistance(corMediaEnviada, img.cor);
      if (!itemScores[img.itemId] || dist < itemScores[img.itemId].dist) {
        itemScores[img.itemId] = { dist, caminho: img.caminho };
      }
    }
    // Buscar dados dos itens mais próximos
    const topItens = Object.entries(itemScores)
      .sort((a, b) => a[1].dist - b[1].dist)
      .slice(0, 10)
      .map(([itemId, data]) => ({ itemId: Number(itemId), distancia: data.dist, imagem: data.caminho }));
    // Buscar detalhes dos itens
    const ids = topItens.map(i => i.itemId);
    if (ids.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.json({ resultados: [], analise: { corMediaEnviada } });
    }
    pool.query(`SELECT * FROM itens WHERE id = ANY($1)`, [ids], (err2, itensResult) => {
      fs.unlinkSync(req.file.path);
      if (err2) return res.status(500).json({ error: err2.message });
      // Juntar info
      const itensDetalhados = topItens.map(ti => {
        const item = itensResult.rows.find(i => i.id === ti.itemId);
        return { ...item, distancia: ti.distancia, imagemMaisProxima: ti.imagem };
      });
      res.json({ resultados: itensDetalhados, analise: { corMediaEnviada } });
    });
  });
});

// Buscar itens por texto
app.get('/api/buscar', (req, res) => {
  const { q } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Termo de busca é obrigatório' });
  }

  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    WHERE i.nome LIKE $1 OR i.descricao LIKE $2 OR i.categoria LIKE $3
    GROUP BY i.id
    ORDER BY i.data_cadastro DESC
  `;

  const searchTerm = `%${q}%`;
  
  pool.query(query, [searchTerm, searchTerm, searchTerm], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const itens = result.rows.map(row => ({
      ...row,
      imagens: row.imagens ? row.imagens.split(',') : []
    }));
    
    res.json(itens);
  });
});

// Atualizar item (protegido)
app.put('/api/itens/:id', authenticateToken, upload.fields([
  { name: 'imagens', maxCount: 10 },
  { name: 'imagemCompleta', maxCount: 1 }
]), (req, res) => {
  // Logar o corpo da requisição para depuração
  console.log('Dados recebidos na edição de item:', req.body);
  // Verificar permissão para editar
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem editar itens.' });
  }
  const itemId = req.params.id;
  const {
    nome,
    descricao,
    categoria,
    codigo,
    preco,
    quantidade,
    localizacao,
    observacoes,
    familia,
    subfamilia,
    setor,
    comprimento,
    largura,
    altura,
    unidade,
    peso,
    unidadepeso,
    unidadearmazenamento,
    tipocontrolo,
    especificacoes
  } = req.body;

  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  // Tratar campos numéricos - converter strings vazias para null
  const precoNum = preco && preco.trim() !== '' ? parseFloat(preco) : null;
  const quantidadeNum = quantidade && quantidade.trim() !== '' ? parseInt(quantidade) : null;
  const comprimentoNum = comprimento && comprimento.trim() !== '' ? parseFloat(comprimento) : null;
  const larguraNum = largura && largura.trim() !== '' ? parseFloat(largura) : null;
  const alturaNum = altura && altura.trim() !== '' ? parseFloat(altura) : null;

  pool.query(`
    UPDATE itens 
    SET nome = $1, descricao = $2, categoria = $3, codigo = $4, preco = $5, quantidade = $6, localizacao = $7, observacoes = $8,
        familia = $9, subfamilia = $10, comprimento = $11, largura = $12, altura = $13,
        unidade = $14, peso = $15, unidadepeso = $16, unidadearmazenamento = $17, tipocontrolo = $18
    WHERE id = $19
  `, [
    nome || descricao, descricao, categoria || 'Sem categoria', codigo, precoNum, quantidadeNum, localizacao, observacoes,
    familia, subfamilia, comprimentoNum, larguraNum, alturaNum, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, itemId
  ], async (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Atualizar setores múltiplos
    if (req.body.setores) {
      try {
        // Remover setores existentes
        await pool.query('DELETE FROM itens_setores WHERE item_id = $1', [itemId]);
        
        // Inserir novos setores
        const setores = JSON.parse(req.body.setores);
        if (Array.isArray(setores) && setores.length > 0) {
          for (const setor of setores) {
            await pool.query(
              'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
              [itemId, setor]
            );
          }
          console.log(`✅ Setores atualizados para item ${itemId}:`, setores);
        }
      } catch (setoresError) {
        console.error(`❌ Erro ao atualizar setores: ${setoresError.message}`);
      }
    }

        // Remover imagens marcadas para exclusão
    if (req.body.imagensRemovidas) {
      try {
        const imagensRemovidas = JSON.parse(req.body.imagensRemovidas);
        for (const imgId of imagensRemovidas) {
          // Buscar caminho da imagem
          const { rows } = await pool.query('SELECT caminho, nome_arquivo FROM imagens_itens WHERE id = $1 AND item_id = $2', [imgId, itemId]);
          if (rows.length > 0) {
            let key = rows[0].caminho;
            // Se for URL do proxy, extrair o nome do arquivo
            if (key.startsWith('/api/imagem/')) {
              key = decodeURIComponent(key.replace('/api/imagem/', ''));
            } else if (key.startsWith('http')) {
              // Se for URL completa do R2, extrair apenas o nome do arquivo
              const urlParts = key.split('/');
              key = decodeURIComponent(urlParts[urlParts.length - 1]);
            } else {
              // Se for apenas o nome do arquivo
              key = rows[0].nome_arquivo || key;
            }
            console.log('Tentando deletar imagem do R2:', key);
            await deleteFromS3(key);
            await pool.query('DELETE FROM imagens_itens WHERE id = $1', [imgId]);
          }
        }
      } catch (err) {
        return res.status(500).json({ error: 'Erro ao remover imagens: ' + err.message });
      }
    }

    // Salvar novas imagens, se enviadas
    console.log('🔄 === INÍCIO DO UPLOAD DE IMAGENS ===');
    console.log('req.files:', req.files);
    console.log('req.file:', req.file);

    console.log('req.body.imagensRemovidas:', req.body.imagensRemovidas);
    
    // Verificar se req.files existe antes de processar
    if (!req.files) {
      console.log('ℹ️  Nenhum arquivo enviado na edição');
      console.log('🔄 === FIM DO UPLOAD DE IMAGENS ===');
      
      res.json({ message: 'Item atualizado com sucesso' });
      return;
    }
    
    // Processar imagens normais
    const imagensNormais = req.files && req.files.imagens ? req.files.imagens : [];
    const imagemCompleta = req.files && req.files.imagemCompleta && Array.isArray(req.files.imagemCompleta) && req.files.imagemCompleta.length > 0 ? req.files.imagemCompleta[0] : null;
    
    console.log('📁 Imagens normais para upload:', imagensNormais.length);
    imagensNormais.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file.originalname} (${file.mimetype})`);
    });
    
    if (imagemCompleta) {
      console.log('📁 Imagem completa para upload:', imagemCompleta.originalname);
    }
    
    if (imagensNormais.length > 0 || imagemCompleta) {
              try {
          // Processar imagens normais
          if (imagensNormais.length > 0) {
            const imagensPromises = imagensNormais.map(async (file) => {
              // Buscar o código do item para usar no nome do arquivo
              const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
              const codigo = codigoResult.rows[0]?.codigo || itemId;
              
              // Upload para AWS S3 com nome baseado no código
              const s3Result = await uploadToS3(
                file.path,
                `${codigo}_${Date.now()}_${file.originalname}`,
                file.mimetype
              );
              // Salvar informações no banco
              console.log(`💾 Salvando imagem normal no banco: ${file.originalname}`);
              const insertResult = await pool.query(
                `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [itemId, file.originalname, s3Result.url, file.mimetype, false]
              );
              console.log(`✅ Imagem normal salva no banco com ID: ${insertResult.rows[0].id}`);
              
              // Remover arquivo local após upload
              fs.unlink(file.path, (unlinkErr) => {
                if (unlinkErr) {
                  console.error('Erro ao remover arquivo local:', unlinkErr);
                } else {
                  console.log(`🗑️  Arquivo local removido: ${file.path}`);
                }
              });
            });
            await Promise.all(imagensPromises);
          }
          
          // Processar imagem completa se existir
          if (imagemCompleta) {
            const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
            const codigo = codigoResult.rows[0]?.codigo || itemId;
            
            // Upload para AWS S3 com nome baseado no código
            const s3Result = await uploadToS3(
              imagemCompleta.path,
              `IC_${codigo}_${Date.now()}_${imagemCompleta.originalname}`,
              imagemCompleta.mimetype
            );
            // Salvar informações no banco
            console.log(`💾 Salvando imagem completa no banco: ${imagemCompleta.originalname}`);
            const insertResult = await pool.query(
              `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [itemId, imagemCompleta.originalname, s3Result.url, imagemCompleta.mimetype, true]
            );
            console.log(`✅ Imagem completa salva no banco com ID: ${insertResult.rows[0].id}`);
            
            // Remover arquivo local após upload
            fs.unlink(imagemCompleta.path, (unlinkErr) => {
              if (unlinkErr) {
                console.error('Erro ao remover arquivo local:', unlinkErr);
              } else {
                console.log(`🗑️  Arquivo local removido: ${imagemCompleta.path}`);
              }
            });
          }
        
        // Verificar total de imagens após upload
        const totalImagens = await pool.query('SELECT COUNT(*) as total FROM imagens_itens WHERE item_id = $1', [itemId]);
        console.log(`📊 Total de imagens no item ${itemId} após upload: ${totalImagens.rows[0].total}`);
        console.log('🔄 === FIM DO UPLOAD DE IMAGENS ===');
      } catch (err) {
        console.error('Erro ao salvar imagens:', err);
        return res.status(500).json({ error: 'Erro ao salvar imagens: ' + err.message });
      }
    }

    res.json({ message: 'Item atualizado com sucesso' });
  });
});

// Função para deletar imagem do S3
async function deleteFromS3(key) {
  console.log('🔧 [DELETE] Iniciando deleteFromS3 com key:', key);
  
  // Valores padrão para desenvolvimento local
  const bucket = process.env.R2_BUCKET || 'catalogo-imagens';
  const endpoint = process.env.R2_ENDPOINT || 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com';
  const accessKeyId = process.env.R2_ACCESS_KEY || '32f0b3b31955b3878e1c2c107ef33fd5';
  const secretAccessKey = process.env.R2_SECRET_KEY || '580539e25b1580ce1c37425fb3eeb45be831ec029b352f6375614399e7ab714f';
  
  console.log('🔧 [DELETE] Usando bucket:', bucket);
  console.log('🔧 [DELETE] Usando endpoint:', endpoint);
  
  // Verificar se as credenciais estão configuradas
  if (!accessKeyId || !secretAccessKey || accessKeyId === '32f0b3b31955b3878e1c2c107ef33fd5') {
    console.log('⚠️ [DELETE] Credenciais R2 não configuradas, pulando exclusão de imagem');
    return Promise.resolve();
  }
  
  const s3 = new AWS.S3({
    endpoint: endpoint,
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    signatureVersion: 'v4',
    region: 'auto', // Voltando para 'auto' para Cloudflare R2
    s3ForcePathStyle: true,
    maxRetries: 3,
    httpOptions: {
      timeout: 30000,
      agent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
        rejectUnauthorized: false
      })
    }
  });
  
  return new Promise((resolve, reject) => {
    s3.deleteObject({
      Bucket: bucket,
      Key: key
    }, (err, data) => {
      if (err) {
        console.error('❌ [DELETE] Erro ao deletar do R2:', err);
        // Não rejeitar o erro, apenas logar
        console.log('⚠️ [DELETE] Continuando sem deletar imagem do R2');
        resolve();
      } else {
        console.log('✅ [DELETE] Imagem deletada do R2 com sucesso:', key);
        resolve(data);
      }
    });
  });
}

// Excluir item e imagens do S3
app.delete('/api/itens/:id', authenticateToken, async (req, res) => {
  const itemId = req.params.id;
  const userRole = req.user && req.user.role;
  if (userRole !== 'admin' && userRole !== 'controller') {
    return res.status(403).json({ error: 'Acesso restrito a administradores ou controllers.' });
  }
  try {
    // Buscar imagens associadas
    const { rows: imagens } = await pool.query('SELECT caminho FROM imagens_itens WHERE item_id = $1', [itemId]);
    // Excluir imagens do S3
    for (const img of imagens) {
      let key = img.caminho;
      // Se for URL completa, extrair apenas o nome do arquivo
      if (key.startsWith('http')) {
        const url = new URL(key);
        key = decodeURIComponent(url.pathname.replace(/^\//, ''));
      }
      await deleteFromS3(key);
    }
    // Excluir registros do banco
    await pool.query('DELETE FROM imagens_itens WHERE item_id = $1', [itemId]);

    await pool.query('DELETE FROM armazens_item WHERE item_id = $1', [itemId]);
    const { rowCount } = await pool.query('DELETE FROM itens WHERE id = $1', [itemId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    res.json({ message: 'Item e imagens excluídos com sucesso.' });
  } catch (error) {
    console.error('Erro ao excluir item/imagens:', error);
    res.status(500).json({ error: 'Erro ao excluir item ou imagens.' });
  }
});

// Deletar TODOS os itens (protegido, apenas admin)
app.delete('/api/itens', authenticateToken, (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem excluir todos os itens.' });
  }
  pool.query('BEGIN TRANSACTION', (err) => {
    if (err) {
      console.error('Erro ao iniciar transação para deletar todos os itens:', err.message);
      return res.status(500).json({ error: 'Erro ao iniciar transação.' });
    }
    pool.query('DELETE FROM armazens_item', [], (err) => {
      if (err) {
        console.error('Erro ao apagar armazéns:', err.message);
        return res.status(500).json({ error: 'Erro ao apagar armazéns.' });
      }
      pool.query('DELETE FROM imagens_itens', [], (err2) => {
        if (err2) {
          console.error('Erro ao apagar imagens:', err2.message);
          return res.status(500).json({ error: 'Erro ao apagar imagens.' });
        }
        pool.query('DELETE FROM itens', [], (err4) => {
          if (err4) {
            console.error('Erro ao apagar itens:', err4.message);
            return res.status(500).json({ error: 'Erro ao apagar itens.' });
          }
          res.json({ message: 'Todos os itens foram excluídos com sucesso.' });
        });
      });
    });
  });
});

// Deletar imagem específica (protegido)
app.delete('/api/imagens/:id', authenticateToken, (req, res) => {
  const imagemId = req.params.id;

  pool.query('SELECT caminho FROM imagens_itens WHERE id = $1', [imagemId], (err, imagemResult) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    if (imagemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    // Deletar arquivo físico
    const filePath = path.join(__dirname, '..', 'uploads', imagemResult.rows[0].caminho);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Deletar do banco
    pool.query('DELETE FROM imagens_itens WHERE id = $1', [imagemId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({ message: 'Imagem deletada com sucesso' });
    });
  });
});

// Obter categorias
app.get('/api/categorias', (req, res) => {
  pool.query('SELECT DISTINCT categoria FROM itens ORDER BY categoria', [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const categorias = result.rows.map(row => row.categoria);
    res.json(categorias);
  });
});

// Estatísticas
app.get('/api/estatisticas', (req, res) => {
  const stats = {};
  
  // Total de itens
  pool.query('SELECT COUNT(*) as total FROM itens', [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    stats.totalItens = result.rows[0].total;
    
    // Total de categorias
    pool.query('SELECT COUNT(DISTINCT categoria) as total FROM itens', [], (err, result) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      stats.totalCategorias = result.rows[0].total;
      
      // Total de imagens
      pool.query('SELECT COUNT(*) as total FROM imagens_itens', [], (err, result) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        stats.totalImagens = result.rows[0].total;
        
        res.json(stats);
      });
    });
  });
});

// Endpoint de teste para upload de imagem
app.post('/api/test-upload', upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  }

  try {
    console.log('Iniciando teste de upload para Google Drive...');
    console.log('Arquivo:', req.file.originalname);
    console.log('Tamanho:', req.file.size);
    console.log('Tipo:', req.file.mimetype);

    // Upload para Google Drive
    const driveResult = await uploadToS3(
      req.file.path,
      `test_${Date.now()}_${req.file.originalname}`,
      req.file.mimetype
    );

    console.log('Upload bem-sucedido:', driveResult);

    // Remover arquivo local
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao remover arquivo local:', err);
    });

    res.json({
      message: 'Teste de upload bem-sucedido!',
      fileId: driveResult.url, // Assuming the S3 URL is the fileId for this test
      publicUrl: driveResult.url,
      webViewLink: null // No direct webViewLink for S3 URL
    });

  } catch (error) {
    console.error('Erro no teste de upload:', error);
    res.status(500).json({ 
      error: 'Erro no teste de upload',
      details: error.message 
    });
  }
});

// Limpar banco de dados (exceto usuários)
app.post('/api/limpar-banco', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem limpar o banco.' });
  }
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM armazens_item');
    await pool.query('DELETE FROM imagens_itens');
    await pool.query('DELETE FROM especificacoes');
    await pool.query('DELETE FROM itens');
    await pool.query('COMMIT');
    res.status(200).json({ message: 'Banco limpo com sucesso. Usuários mantidos.' });
  } catch (error) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao limpar banco.', details: error.message });
  }
});

// Exportar todos os dados do banco em JSON
app.get('/api/exportar-json', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem exportar os dados.' });
  }
  try {
    const [itens, imagens, especificacoes, armazens, usuarios] = await Promise.all([
      pool.query('SELECT * FROM itens'),
      pool.query('SELECT * FROM imagens_itens'),
      pool.query('SELECT * FROM especificacoes'),
      pool.query('SELECT * FROM armazens_item'),
      pool.query('SELECT id, username, nome, email, role, data_criacao FROM usuarios')
    ]);
    res.json({
      itens: itens.rows,
      imagens_itens: imagens.rows,
      especificacoes: especificacoes.rows,
      armazens_item: armazens.rows,
      usuarios: usuarios.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao exportar dados.', details: error.message });
  }
});

// Endpoint para exportar itens em Excel
app.get('/api/exportar-itens', authenticateToken, async (req, res) => {
  try {
    const { rows: itens } = await pool.query(`
      SELECT 
        i.codigo, 
        i.descricao, 
        i.unidadearmazenamento, 
        i.familia, 
        i.subfamilia, 
        i.ativo, 
        i.quantidade,
        STRING_AGG(DISTINCT is2.setor, ', ') as setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      GROUP BY i.id, i.codigo, i.descricao, i.unidadearmazenamento, i.familia, i.subfamilia, i.ativo, i.quantidade
      ORDER BY i.codigo
    `);
    
    if (!itens.length) {
      return res.status(404).json({ error: 'Nenhum item encontrado.' });
    }
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Itens');
    
    // Definir cabeçalhos
    worksheet.columns = [
      { header: 'Código', key: 'codigo', width: 12 }, // Artigo
      { header: 'Descrição', key: 'descricao', width: 40 }, // Descrição
      { header: 'Unidade base', key: 'unidade_base', width: 16 }, // Unidade base
      { header: 'Família', key: 'familia', width: 18 }, // Família
      { header: 'Subfamília', key: 'subfamilia', width: 18 }, // Subfamília
      { header: 'Setores', key: 'setores', width: 25 }, // Setores (múltiplos)
      { header: 'Ativo', key: 'ativo', width: 8 }, // Ativo
      { header: 'Quantidade', key: 'quantidade', width: 12 } // Quantidade
    ];
    
    // Adicionar dados
    itens.forEach(item => {
      worksheet.addRow({
        codigo: item.codigo,
        descricao: item.descricao,
        unidade_base: item.unidadearmazenamento,
        familia: item.familia,
        subfamilia: item.subfamilia,
        setores: item.setores || '', // Usar setores (múltiplos) ou string vazia se não houver
        ativo: item.ativo,
        quantidade: item.quantidade
      });
    });
    
    // Calcular largura automática para a coluna Descrição
    let maxDescricaoLength = 0;
    itens.forEach(item => {
      const length = item.descricao ? item.descricao.length : 0;
      if (length > maxDescricaoLength) {
        maxDescricaoLength = length;
      }
    });
    
    // Ajustar largura da coluna Descrição (mínimo 40, máximo 80)
    const descricaoWidth = Math.max(40, Math.min(80, maxDescricaoLength + 5));
    worksheet.getColumn('descricao').width = descricaoWidth;
    
    // Formatar cabeçalho
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FF000000' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Aplicar bordas a todas as células (incluindo células vazias)
    const lastRow = worksheet.rowCount;
    const lastCol = worksheet.columnCount;
    
    for (let row = 1; row <= lastRow; row++) {
      for (let col = 1; col <= lastCol; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF000000' } },
          left: { style: 'thin', color: { argb: 'FF000000' } },
          bottom: { style: 'thin', color: { argb: 'FF000000' } },
          right: { style: 'thin', color: { argb: 'FF000000' } }
        };
      }
    }
    
    // Congelar primeira linha
    worksheet.views = [
      { state: 'frozen', ySplit: 1 }
    ];
    
    // Gerar buffer
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Disposition', 'attachment; filename="catalogo_itens.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao exportar itens: ' + err.message });
  }
});

// Cadastro de novo usuário (apenas admin)
app.post('/api/usuarios', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem cadastrar usuários.' });
  }
  const { username, password, nome, email, role } = req.body;
  if (!username || !password || !nome || !role) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!['admin', 'controller'].includes(role)) {
    return res.status(400).json({ error: 'Role inválido.' });
  }
  try {
    // Verificar se username ou email já existem
    const userExists = await pool.query('SELECT id FROM usuarios WHERE username = $1 OR email = $2', [username, email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Username ou email já cadastrado.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO usuarios (username, password, nome, email, role) VALUES ($1, $2, $3, $4, $5)',
      [username, hashedPassword, nome, email, role]
    );
    res.status(201).json({ message: 'Usuário cadastrado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar usuário.', details: error.message });
  }
});

// Cadastro de novo usuário (apenas admin; nome, nº colaborador e palavra-passe obrigatórios)
// Armazéns de requisições não são definidos aqui — só em PATCH /api/usuarios/:id por admin
app.post('/api/cadastrar-usuario', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem criar utilizadores.' });
  }
  const {
    nome: nomeRaw,
    sobrenome: sobrenomeRaw,
    telemovel: telemovelRaw,
    email: emailRaw,
    username: usernameRaw,
    numero_colaborador: numColRaw,
    senha: senhaRaw
  } = req.body;

  const nome = String(nomeRaw || '').trim();
  const sobrenome = String(sobrenomeRaw || '').trim() || null;
  const telemovel = String(telemovelRaw || '').trim() || null;
  const email = String(emailRaw || '').trim() || null;
  let username = String(usernameRaw || '').trim() || null;
  const numero_colaborador = String(numColRaw || '').trim();
  let senha = senhaRaw != null ? String(senhaRaw).trim() : '';

  if (!nome || !numero_colaborador) {
    return res.status(400).json({ error: 'Nome e número de colaborador são obrigatórios.' });
  }

  if (!senha) {
    return res.status(400).json({ error: 'Palavra-passe é obrigatória.' });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  if (!username) {
    username = numero_colaborador;
  }

  try {
    const armIdsNorm = [];

    const existe = await pool.query('SELECT id FROM usuarios WHERE TRIM(numero_colaborador::text) = TRIM($1)', [numero_colaborador]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Número de colaborador já cadastrado.' });
    }

    if (email) {
      const em = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))', [email]);
      if (em.rows.length > 0) {
        return res.status(400).json({ error: 'Este e-mail já está registado.' });
      }
    }

    const un = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))', [username]);
    if (un.rows.length > 0) {
      return res.status(400).json({ error: 'Este nome de utilizador já está em uso.' });
    }

    const hash = bcrypt.hashSync(senha, 10);
    const hasJunc = await usuarioRequisicaoArmazemJunctionTableExists();
    const hasCol = await usuariosTemColunaRequisicoesArmazemOrigem();

    if (armIdsNorm.length > 0 && !hasJunc && !hasCol) {
      return res.status(400).json({
        error: 'Execute a migração do banco antes de associar armazéns às requisições.',
        detalhes: 'npm run db:migrate:usuarios-req-armazem-multi'
      });
    }
    if (!hasJunc && hasCol && armIdsNorm.length > 1) {
      return res.status(400).json({
        error: 'Vários armazéns exigem a migração N:N.',
        detalhes: 'npm run db:migrate:usuarios-req-armazem-multi'
      });
    }

    const baseVals = [nome, sobrenome, telemovel, email, username, numero_colaborador, hash, 'basico'];

    const runInsert = async (sql, params) => pool.query(sql, params);

    try {
      if (hasJunc) {
        const ins = await runInsert(
          `INSERT INTO usuarios (nome, sobrenome, telemovel, email, username, numero_colaborador, password, role)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          baseVals
        );
        const newUserId = ins.rows[0].id;
        for (const aid of armIdsNorm) {
          await pool.query(
            'INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [newUserId, aid]
          );
        }
      } else if (hasCol) {
        const single = armIdsNorm.length ? armIdsNorm[0] : null;
        await runInsert(
          `INSERT INTO usuarios (nome, sobrenome, telemovel, email, username, numero_colaborador, password, role, requisicoes_armazem_origem_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [...baseVals, single]
        );
      } else {
        await runInsert(
          `INSERT INTO usuarios (nome, sobrenome, telemovel, email, username, numero_colaborador, password, role)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          baseVals
        );
      }
    } catch (insertErr) {
      if (insertErr.code === '42703') {
        const nomeDb = sobrenome ? `${nome} ${sobrenome}`.trim() : nome;
        if (hasJunc) {
          const ins = await pool.query(
            `INSERT INTO usuarios (nome, numero_colaborador, username, password, role, email)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [nomeDb, numero_colaborador, username, hash, 'basico', email]
          );
          const newUserId = ins.rows[0].id;
          for (const aid of armIdsNorm) {
            await pool.query(
              'INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [newUserId, aid]
            );
          }
        } else if (hasCol) {
          const single = armIdsNorm.length ? armIdsNorm[0] : null;
          await pool.query(
            `INSERT INTO usuarios (nome, numero_colaborador, username, password, role, requisicoes_armazem_origem_id, email)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [nomeDb, numero_colaborador, username, hash, 'basico', single, email]
          );
        } else {
          await pool.query(
            `INSERT INTO usuarios (nome, numero_colaborador, username, password, role, email)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [nomeDb, numero_colaborador, username, hash, 'basico', email]
          );
        }
      } else {
        throw insertErr;
      }
    }

    res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar utilizadores: admin vê todos; outros utilizadores autenticados só a si próprios
app.get('/api/usuarios', authenticateToken, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  const isAdmin = req.user.role === 'admin';
  try {
    const hasJunc = await usuarioRequisicaoArmazemJunctionTableExists();
    const hasCol = await usuariosTemColunaRequisicoesArmazemOrigem();
    let sql;
    if (hasJunc) {
      sql = `
      SELECT u.id, u.username, u.numero_colaborador, u.nome, u.sobrenome, u.telemovel, u.role, u.email, u.data_criacao,
        COALESCE(
          (SELECT json_agg(ura.armazem_id ORDER BY ura.armazem_id)
           FROM usuario_requisicoes_armazens ura WHERE ura.usuario_id = u.id),
          '[]'::json
        ) AS requisicoes_armazem_origem_ids,
        COALESCE(
          (SELECT json_agg(json_build_object('id', a2.id, 'codigo', a2.codigo, 'descricao', a2.descricao) ORDER BY a2.id)
           FROM usuario_requisicoes_armazens ura2
           INNER JOIN armazens a2 ON a2.id = ura2.armazem_id
           WHERE ura2.usuario_id = u.id),
          '[]'::json
        ) AS requisicoes_armazens_origem
      FROM usuarios u
      WHERE ($1::int IS NULL OR u.id = $1)
      ORDER BY u.id DESC
    `;
    } else if (hasCol) {
      sql = `
      SELECT u.id, u.username, u.numero_colaborador, u.nome, u.sobrenome, u.telemovel, u.role, u.email, u.data_criacao, u.requisicoes_armazem_origem_id,
        a.codigo as requisicoes_armazem_origem_codigo,
        a.descricao as requisicoes_armazem_origem_descricao,
        CASE WHEN u.requisicoes_armazem_origem_id IS NOT NULL
          THEN json_build_array(u.requisicoes_armazem_origem_id) ELSE '[]'::json END AS requisicoes_armazem_origem_ids,
        CASE WHEN u.requisicoes_armazem_origem_id IS NOT NULL
          THEN json_build_array(json_build_object('id', a.id, 'codigo', a.codigo, 'descricao', a.descricao))
          ELSE '[]'::json END AS requisicoes_armazens_origem
      FROM usuarios u
      LEFT JOIN armazens a ON a.id = u.requisicoes_armazem_origem_id
      WHERE ($1::int IS NULL OR u.id = $1)
      ORDER BY u.id DESC
    `;
    } else {
      sql = `
      SELECT u.id, u.username, u.numero_colaborador, u.nome, u.sobrenome, u.telemovel, u.role, u.email, u.data_criacao,
        NULL::integer AS requisicoes_armazem_origem_id,
        NULL::text AS requisicoes_armazem_origem_codigo,
        NULL::text AS requisicoes_armazem_origem_descricao,
        '[]'::json AS requisicoes_armazem_origem_ids,
        '[]'::json AS requisicoes_armazens_origem
      FROM usuarios u
      WHERE ($1::int IS NULL OR u.id = $1)
      ORDER BY u.id DESC
    `;
    }
    const scopeParam = isAdmin ? null : Number(req.user.id);
    let result;
    try {
      result = await pool.query(sql, [scopeParam]);
    } catch (listErr) {
      if (listErr.code !== '42703') throw listErr;
      result = await pool.query(sql.replace(/u\.sobrenome, u\.telemovel, /g, ''), [scopeParam]);
    }
    const rows = result.rows.map((row) => {
      let ids = row.requisicoes_armazem_origem_ids;
      if (typeof ids === 'string') {
        try {
          ids = JSON.parse(ids);
        } catch (_) {
          ids = [];
        }
      }
      if (!Array.isArray(ids)) ids = [];
      ids = ids.map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
      return { ...row, requisicoes_armazem_origem_ids: ids };
    });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar usuários.', details: error.message });
  }
});

// Atualizar utilizador: admin altera qualquer perfil, role e armazéns; outros só o próprio perfil (sem role/armazéns)
app.patch('/api/usuarios/:id', authenticateToken, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  const isAdmin = req.user.role === 'admin';
  const id = parseInt(req.params.id, 10);
  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  const isSelf = Number(req.user.id) === id;
  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: 'Apenas o administrador pode alterar outros utilizadores.' });
  }

  const {
    role,
    requisicoes_armazem_origem_id,
    requisicoes_armazem_origem_ids,
    nome,
    sobrenome,
    telemovel,
    email,
    username,
    numero_colaborador,
    nova_senha,
    senha: senhaBody
  } = req.body;

  const pwdIn =
    nova_senha != null && String(nova_senha).trim()
      ? String(nova_senha).trim()
      : senhaBody != null && String(senhaBody).trim()
        ? String(senhaBody).trim()
        : null;

  const rolesValidos = ROLES_VALIDOS;
  const updates = [];
  const params = [];
  let pi = 1;

  const hasJunc = await usuarioRequisicaoArmazemJunctionTableExists();
  const hasCol = await usuariosTemColunaRequisicoesArmazemOrigem();

  let idsPayload = requisicoes_armazem_origem_ids;
  if (idsPayload === undefined && requisicoes_armazem_origem_id !== undefined) {
    if (requisicoes_armazem_origem_id === null || requisicoes_armazem_origem_id === '') idsPayload = [];
    else idsPayload = [requisicoes_armazem_origem_id];
  }

  if (isAdmin && idsPayload !== undefined && !hasJunc && !hasCol) {
    return res.status(400).json({
      error: 'Não é possível guardar armazéns sem migração da base de dados.',
      detalhes: 'npm run db:migrate:usuarios-req-armazem ou npm run db:migrate:usuarios-req-armazem-multi'
    });
  }

  if (isAdmin || isSelf) {
    if (nome !== undefined) {
      const n = String(nome || '').trim();
      if (!n) {
        return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
      }
      updates.push(`nome = $${pi++}`);
      params.push(n);
    }
    if (sobrenome !== undefined) {
      const s = String(sobrenome || '').trim() || null;
      updates.push(`sobrenome = $${pi++}`);
      params.push(s);
    }
    if (telemovel !== undefined) {
      const t = String(telemovel || '').trim() || null;
      updates.push(`telemovel = $${pi++}`);
      params.push(t);
    }
    if (email !== undefined) {
      const em = String(email || '').trim() || null;
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return res.status(400).json({ error: 'E-mail inválido.' });
      }
      if (em) {
        const clash = await pool.query(
          'SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND id <> $2',
          [em, id]
        );
        if (clash.rows.length > 0) {
          return res.status(400).json({ error: 'Este e-mail já está a ser usado por outro utilizador.' });
        }
      }
      updates.push(`email = $${pi++}`);
      params.push(em);
    }
    if (username !== undefined) {
      const un = String(username || '').trim();
      if (!un) {
        return res.status(400).json({ error: 'O username não pode ficar vazio.' });
      }
      const clash = await pool.query(
        'SELECT id FROM usuarios WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND id <> $2',
        [un, id]
      );
      if (clash.rows.length > 0) {
        return res.status(400).json({ error: 'Este username já está em uso.' });
      }
      updates.push(`username = $${pi++}`);
      params.push(un);
    }
    if (numero_colaborador !== undefined) {
      const nc = String(numero_colaborador || '').trim();
      if (!nc) {
        return res.status(400).json({ error: 'O número de colaborador não pode ficar vazio.' });
      }
      const clash = await pool.query(
        'SELECT id FROM usuarios WHERE TRIM(numero_colaborador::text) = TRIM($1) AND id <> $2',
        [nc, id]
      );
      if (clash.rows.length > 0) {
        return res.status(400).json({ error: 'Este número de colaborador já está registado.' });
      }
      updates.push(`numero_colaborador = $${pi++}`);
      params.push(nc);
    }
    if (pwdIn) {
      updates.push(`password = $${pi++}`);
      params.push(bcrypt.hashSync(pwdIn, 10));
    }
  }

  if (isAdmin && role !== undefined && role !== null) {
    if (!rolesValidos.includes(role)) {
      return res.status(400).json({ error: 'Role inválido.' });
    }
    updates.push(`role = $${pi++}`);
    params.push(role);
  }

  if (isAdmin && idsPayload !== undefined) {
    if (!Array.isArray(idsPayload)) {
      return res.status(400).json({ error: 'requisicoes_armazem_origem_ids deve ser um array de ids.' });
    }
    const armIdsNorm = [...new Set(idsPayload.map((x) => parseInt(x, 10)).filter(Boolean))];
    for (const aid of armIdsNorm) {
      const ch = await pool.query(
        "SELECT id FROM armazens WHERE id = $1 AND ativo = true AND LOWER(COALESCE(tipo,'')) = 'central'",
        [aid]
      );
      if (ch.rows.length === 0) {
        return res.status(400).json({ error: `Armazém central inválido ou inativo (id ${aid}).` });
      }
    }
    if (hasJunc) {
      await pool.query('DELETE FROM usuario_requisicoes_armazens WHERE usuario_id = $1', [id]);
      for (const aid of armIdsNorm) {
        await pool.query(
          'INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id) VALUES ($1, $2)',
          [id, aid]
        );
      }
    } else if (hasCol) {
      if (armIdsNorm.length > 1) {
        return res.status(400).json({
          error: 'Vários armazéns exigem a migração N:N (usuario_requisicoes_armazens).'
        });
      }
      if (armIdsNorm.length === 0) {
        updates.push('requisicoes_armazem_origem_id = NULL');
      } else {
        updates.push(`requisicoes_armazem_origem_id = $${pi++}`);
        params.push(armIdsNorm[0]);
      }
    }
  }

  if (updates.length === 0 && (idsPayload === undefined || !isAdmin)) {
    return res.status(400).json({
      error: 'Nada a atualizar. Envie dados do perfil, nova palavra-passe, ou (admin) role/armazéns.'
    });
  }

  params.push(id);
  try {
    if (updates.length > 0) {
      await pool.query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${pi}`, params);
    }
    res.json({ message: 'Utilizador atualizado com sucesso.' });
  } catch (error) {
    if (error.code === '42703') {
      return res.status(400).json({
        error: 'Coluna em falta na base de dados.',
        detalhes: error.message,
        hint:
          'Confirme que correu o migrate na mesma base que a API (server/.env → DATABASE_URL). ' +
          'updated_at/created_at em usuarios: npm run db:migrate:usuarios-timestamps. ' +
          'sobrenome/telemovel: npm run db:migrate:usuarios-dados-pessoais. ' +
          'requisicoes_armazem_origem_id: npm run db:migrate:usuarios-req-armazem. ' +
          'numero_colaborador: ver migrações / init-db.'
      });
    }
    res.status(500).json({ error: 'Erro ao atualizar utilizador.', details: error.message });
  }
});

// Excluir utilizador (apenas admin)
app.delete('/api/usuarios/:id', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem excluir utilizadores.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  if (Number(req.user.id) === id) {
    return res.status(400).json({ error: 'Não pode excluir a sua própria conta.' });
  }
  try {
    const del = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }
    res.json({ message: 'Utilizador excluído com sucesso.' });
  } catch (error) {
    console.error('[DELETE /api/usuarios]', error);
    res.status(500).json({
      error: 'Erro ao excluir utilizador.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Gerenciar fotos de reconhecimento (apenas admin)
const fotoReconhecimentoUpload = multer({ dest: 'uploads/' });

// Upload de foto de reconhecimento
app.post('/api/fotos-reconhecimento', authenticateToken, fotoReconhecimentoUpload.single('foto'), async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem enviar fotos.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }
  try {
    const { nome, descricao } = req.body;
    // Upload para Google Drive
    const driveResult = await uploadToS3(
      req.file.path,
      `reconhecimento_${Date.now()}_${req.file.originalname}`,
      req.file.mimetype
    );
    // Salvar no banco
    await pool.query(
      'INSERT INTO fotos_reconhecimento (nome, descricao, caminho) VALUES ($1, $2, $3)',
      [nome, descricao, driveResult.url]
    );
    // Remover arquivo local
    fs.unlink(req.file.path, () => {});
    res.status(201).json({ message: 'Foto enviada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao enviar foto.', details: error.message });
  }
});

// Listar fotos de reconhecimento
app.get('/api/fotos-reconhecimento', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem listar fotos.' });
  }
  try {
    const result = await pool.query('SELECT * FROM fotos_reconhecimento ORDER BY data_upload DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar fotos.', details: error.message });
  }
});

// Deletar foto de reconhecimento
app.delete('/api/fotos-reconhecimento/:id', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem deletar fotos.' });
  }
  const id = req.params.id;
  try {
    // Buscar caminho para possível remoção do arquivo do Google Drive (opcional)
    const result = await pool.query('SELECT caminho FROM fotos_reconhecimento WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Foto não encontrada.' });
    }
    // Opcional: deletar do Google Drive usando deleteFromGoogleDrive se salvar o fileId
    await pool.query('DELETE FROM fotos_reconhecimento WHERE id = $1', [id]);
    res.json({ message: 'Foto deletada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar foto.', details: error.message });
  }
});

// Endpoint para upload e reconhecimento de imagem
app.post('/vision', upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }
    const filePath = req.file.path;
    const visionClient = new vision.ImageAnnotatorClient();
    const [result] = await visionClient.labelDetection(filePath);
    const labels = result.labelAnnotations.map(label => label.description);
    res.json({ labels });
  } catch (error) {
    console.error('Erro no Vision:', error);
    res.status(500).json({ error: 'Erro ao processar a imagem.' });
  }
});

// Endpoint protegido para análise de imagem no S3 com Rekognition
app.post('/api/rekognition-labels', authenticateToken, async (req, res) => {
  const { key } = req.body;
  const userRole = req.user && req.user.role;
  if (!key) {
    return res.status(400).json({ error: 'O campo key é obrigatório.' });
  }
  if (userRole !== 'admin' && userRole !== 'controller') {
    return res.status(403).json({ error: 'Acesso restrito a administradores ou controllers.' });
  }
  try {
    const bucket = process.env.R2_BUCKET;
    const labels = await detectLabelsFromS3(bucket, key);
    res.json({ labels });
  } catch (error) {
    console.error('Erro no Rekognition:', error);
    res.status(500).json({ error: 'Erro ao analisar imagem no Rekognition.' });
  }
});

// Rota para importar imagens automaticamente baseadas na nomenclatura do código do item
app.post('/api/importar-imagens-automaticas', authenticateToken, async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código do item é obrigatório' });
    }

    // Buscar o item pelo código
    const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado com este código' });
    }

    const itemId = itemResult.rows[0].id;
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [IMPORTAÇÃO] Cliente S3 não configurado, pulando busca de imagens');
      return res.status(503).json({ 
        error: 'Serviço de armazenamento não configurado',
        message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
      });
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    console.log(`🔍 [IMPORTAÇÃO] Procurando imagens no bucket com prefixo: ${codigo}_`);
    console.log(`📦 [IMPORTAÇÃO] Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 [IMPORTAÇÃO] Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 [IMPORTAÇÃO] Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ [IMPORTAÇÃO] Nenhuma imagem encontrada com prefixo: ${codigo}_`);
      return res.status(404).json({ 
        error: 'Nenhuma imagem encontrada no bucket com o padrão de nomenclatura',
        message: `Procurando por imagens com prefixo: ${codigo}_`
      });
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 [IMPORTAÇÃO] Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  [IMPORTAÇÃO] Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ [IMPORTAÇÃO] Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 [IMPORTAÇÃO] Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo) VALUES ($1, $2, $3, $4)',
        [itemId, nomeArquivo, urlImagem, tipoMime]
      );

      imagensImportadas++;
      console.log(`✅ [IMPORTAÇÃO] Imagem ${nomeArquivo} importada com sucesso!`);
    }

    res.json({
      message: 'Importação concluída',
      totalEncontradas: imagensEncontradas.length,
      imagensImportadas,
      imagensJaExistentes,
      codigo,
      itemId
    });

  } catch (error) {
    console.error('Erro na importação automática:', error);
    res.status(500).json({ 
      error: 'Erro ao importar imagens automaticamente',
      details: error.message 
    });
  }
});

// Rota para listar imagens disponíveis no bucket para um código específico
app.get('/api/imagens-bucket/:codigo', authenticateToken, async (req, res) => {
  try {
    const { codigo } = req.params;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código do item é obrigatório' });
    }

    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [LISTAGEM] Cliente S3 não configurado');
      return res.status(503).json({ 
        error: 'Serviço de armazenamento não configurado',
        message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
      });
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    // Buscar o item para verificar se existe
    const itemResult = await pool.query('SELECT id, descricao FROM itens WHERE codigo = $1', [codigo]);
    const itemExiste = itemResult.rows.length > 0;
    const itemInfo = itemExiste ? itemResult.rows[0] : null;

    // Verificar quais imagens já estão cadastradas no banco para QUALQUER item
    const imagensResult = await pool.query(`
      SELECT ii.nome_arquivo, ii.item_id, i.codigo, i.descricao 
      FROM imagens_itens ii 
      JOIN itens i ON ii.item_id = i.id 
      WHERE ii.nome_arquivo = ANY($1)
    `, [imagensEncontradas.map(obj => obj.Key)]);

    const imagensCadastradas = {};
    imagensResult.rows.forEach(row => {
      imagensCadastradas[row.nome_arquivo] = {
        itemId: row.item_id,
        codigo: row.codigo,
        descricao: row.descricao
      };
    });

    const imagensComStatus = imagensEncontradas.map(objeto => {
      const jaCadastrada = imagensCadastradas[objeto.Key];
      return {
        nome: objeto.Key,
        tamanho: objeto.Size,
        dataModificacao: objeto.LastModified,
        jaCadastrada: !!jaCadastrada,
        itemRelacionado: jaCadastrada ? {
          codigo: jaCadastrada.codigo,
          descricao: jaCadastrada.descricao
        } : null
      };
    });

    res.json({
      codigo,
      itemExiste,
      itemInfo,
      totalImagens: imagensEncontradas.length,
      imagens: imagensComStatus
    });

  } catch (error) {
    console.error('Erro ao listar imagens do bucket:', error);
    res.status(500).json({ 
      error: 'Erro ao listar imagens do bucket',
      details: error.message 
    });
  }
});

// Função para detectar e importar imagens automaticamente
async function detectarEImportarImagensAutomaticas(itemId, codigo) {
  try {
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [DETECÇÃO] Cliente S3 não configurado, pulando detecção de imagens');
      return { importadas: 0, jaExistentes: 0, erro: 'Serviço de armazenamento não configurado' };
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    console.log(`🔍 Procurando imagens no bucket com prefixo: ${codigo}_`);
    console.log(`📦 Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ Nenhuma imagem encontrada com prefixo: ${codigo}_`);
      return { importadas: 0, jaExistentes: 0 };
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo) VALUES ($1, $2, $3, $4)',
        [itemId, nomeArquivo, urlImagem, tipoMime]
      );

      imagensImportadas++;
      console.log(`✅ Imagem ${nomeArquivo} importada com sucesso!`);
    }

    return { importadas: imagensImportadas, jaExistentes: imagensJaExistentes };
  } catch (error) {
    console.error('Erro na detecção automática de imagens:', error);
    return { importadas: 0, jaExistentes: 0, erro: error.message };
  }
}

// Função para detectar e importar imagens de itens compostos (IC_)
async function detectarEImportarImagensCompostas(itemId, codigo) {
  try {
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [DETECÇÃO] Cliente S3 não configurado, pulando detecção de imagens compostas');
      return { importadas: 0, jaExistentes: 0, erro: 'Serviço de armazenamento não configurado' };
    }

    // Listar objetos no bucket que correspondem ao padrão IC_codigo
    const listParams = {
      Bucket: bucket,
      Prefix: `IC_${codigo}_`
    };

    console.log(`🔍 [COMPOSTO] Procurando imagens no bucket com prefixo: IC_${codigo}_`);
    console.log(`📦 [COMPOSTO] Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 [COMPOSTO] Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 [COMPOSTO] Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ [COMPOSTO] Nenhuma imagem encontrada com prefixo: IC_${codigo}_`);
      return { importadas: 0, jaExistentes: 0 };
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 [COMPOSTO] Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  [COMPOSTO] Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ [COMPOSTO] Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 [COMPOSTO] Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados com flag is_completo = true
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo) VALUES ($1, $2, $3, $4, $5)',
        [itemId, nomeArquivo, urlImagem, tipoMime, true]
      );

      imagensImportadas++;
      console.log(`✅ [COMPOSTO] Imagem ${nomeArquivo} importada com sucesso!`);
    }

    return { importadas: imagensImportadas, jaExistentes: imagensJaExistentes };
  } catch (error) {
    console.error('Erro na detecção automática de imagens compostas:', error);
    return { importadas: 0, jaExistentes: 0, erro: error.message };
  }
}

// Rota para forçar detecção automática de imagens para um item específico
app.post('/api/detectar-imagens/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    // Buscar o item
    const itemResult = await pool.query('SELECT id, codigo FROM itens WHERE id = $1', [itemId]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    const item = itemResult.rows[0];
    const resultado = await detectarEImportarImagensAutomaticas(item.id, item.codigo);
    
    res.json({
      message: 'Detecção automática concluída',
      itemId: item.id,
      codigo: item.codigo,
      ...resultado
    });
    
  } catch (error) {
    console.error('Erro na detecção forçada:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática',
      details: error.message 
    });
  }
});

// Rota para forçar detecção automática de imagens de itens compostos
app.post('/api/detectar-imagens-compostas/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    // Buscar o item
    const itemResult = await pool.query('SELECT id, codigo FROM itens WHERE id = $1', [itemId]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    const item = itemResult.rows[0];
    const resultado = await detectarEImportarImagensCompostas(item.id, item.codigo);
    
    res.json({
      message: 'Detecção automática de imagens compostas concluída',
      itemId: item.id,
      codigo: item.codigo,
      ...resultado
    });
    
  } catch (error) {
    console.error('Erro na detecção forçada de imagens compostas:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática de imagens compostas',
      details: error.message 
    });
  }
});

// ===== ROTAS PARA IMAGENS =====

// Excluir imagem
app.delete('/api/imagens/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Buscar informações da imagem
    const { rows } = await pool.query('SELECT caminho, nome_arquivo, item_id FROM imagens_itens WHERE id = $1', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }
    
    const imagem = rows[0];
    
    // Deletar do R2
    let key = imagem.caminho;
    if (key.startsWith('/api/imagem/')) {
      key = decodeURIComponent(key.replace('/api/imagem/', ''));
    } else if (key.startsWith('http')) {
      const urlParts = key.split('/');
      key = decodeURIComponent(urlParts[urlParts.length - 1]);
    } else {
      key = imagem.nome_arquivo || key;
    }
    
    console.log('Tentando deletar imagem do R2:', key);
    await deleteFromS3(key);
    
    // Deletar do banco
    await pool.query('DELETE FROM imagens_itens WHERE id = $1', [id]);
    
    console.log(`✅ Imagem ${id} excluída com sucesso`);
    res.json({ message: 'Imagem excluída com sucesso' });
    
  } catch (error) {
    console.error('Erro ao excluir imagem:', error);
    res.status(500).json({ error: 'Erro ao excluir imagem: ' + error.message });
  }
});

// ===== ROTAS PARA ITENS COMPOSTOS =====

// Buscar itens para seleção de componentes
app.get('/api/itens-para-componentes', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, codigo, descricao, unidadearmazenamento 
      FROM itens 
      WHERE ativo = true 
      ORDER BY codigo
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar itens para componentes:', error);
    res.status(500).json({ error: 'Erro ao buscar itens' });
  }
});

// Buscar componentes de um item
app.get('/api/itens/:id/componentes', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT 
        ic.id,
        ic.quantidade_componente,
        i.id as item_id,
        i.codigo,
        i.descricao,
        i.familia,
        i.subfamilia,
        i.setor,
        i.comprimento,
        i.largura,
        i.altura,
        i.unidade,
        i.peso,
        i.unidadepeso,
        i.tipocontrolo,
        i.observacoes,
        i.unidadearmazenamento
      FROM itens_compostos ic
      JOIN itens i ON ic.item_componente_id = i.id
      WHERE ic.item_principal_id = $1
      ORDER BY i.codigo
    `, [itemId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar componentes:', error);
    res.status(500).json({ error: 'Erro ao buscar componentes' });
  }
});

// Adicionar componente a um item
app.post('/api/itens/:id/componentes', authenticateToken, async (req, res) => {
  try {
    console.log('🔧 Adicionando componente:', req.body);
    
    const itemId = parseInt(req.params.id);
    const { item_componente_id, quantidade_componente = 1 } = req.body;
    
    console.log('📝 Dados recebidos:', { itemId, item_componente_id, quantidade_componente });
    
    if (!item_componente_id || isNaN(parseInt(item_componente_id)) || parseInt(item_componente_id) <= 0) {
      console.log('❌ ID do item componente inválido:', item_componente_id);
      return res.status(400).json({ error: 'ID do item componente é obrigatório e deve ser um número válido' });
    }
    
    const itemComponenteId = parseInt(item_componente_id);
    
    // Verificar se não está tentando adicionar o próprio item como componente
    if (itemId === itemComponenteId) {
      console.log('❌ Tentativa de adicionar item como componente de si mesmo');
      return res.status(400).json({ error: 'Um item não pode fazer parte da sua própria composição' });
    }
    
    // Verificar se os itens existem
    const itemPrincipal = await pool.query('SELECT id FROM itens WHERE id = $1', [itemId]);
    if (itemPrincipal.rows.length === 0) {
      console.log('❌ Item principal não encontrado:', itemId);
      return res.status(404).json({ error: 'Item principal não encontrado' });
    }
    
    const itemComponente = await pool.query('SELECT id FROM itens WHERE id = $1', [itemComponenteId]);
    if (itemComponente.rows.length === 0) {
      console.log('❌ Item componente não encontrado:', itemComponenteId);
      return res.status(404).json({ error: 'Item componente não encontrado' });
    }
    
    // Verificar se já existe essa relação
    const existing = await pool.query(
      'SELECT id FROM itens_compostos WHERE item_principal_id = $1 AND item_componente_id = $2',
      [itemId, itemComponenteId]
    );
    
    if (existing.rows.length > 0) {
      console.log('❌ Item já existe na composição');
      return res.status(400).json({ error: 'Este item já foi adicionado à composição' });
    }
    
    console.log('✅ Inserindo item na composição...');
    
    // Inserir item na composição
    const result = await pool.query(
      'INSERT INTO itens_compostos (item_principal_id, item_componente_id, quantidade_componente) VALUES ($1, $2, $3) RETURNING id',
      [itemId, itemComponenteId, quantidade_componente]
    );
    
    console.log('✅ Item adicionado com sucesso, ID:', result.rows[0].id);
    res.json({ message: 'Item adicionado à composição com sucesso', id: result.rows[0].id });
  } catch (error) {
    console.error('❌ Erro ao adicionar componente:', error);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({ error: 'Erro ao adicionar componente', details: error.message });
  }
});

// Remover componente de um item
app.delete('/api/itens/:id/componentes/:componenteId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    const componenteId = req.params.componenteId;
    
    const { rowCount } = await pool.query(
      'DELETE FROM itens_compostos WHERE item_principal_id = $1 AND id = $2',
      [itemId, componenteId]
    );
    
         if (rowCount === 0) {
       return res.status(404).json({ error: 'Item não encontrado na composição' });
     }
     
     res.json({ message: 'Item removido da composição com sucesso' });
  } catch (error) {
    console.error('Erro ao remover componente:', error);
    res.status(500).json({ error: 'Erro ao remover componente' });
  }
});

// Buscar itens que um item específico compõe
app.get('/api/itens/:id/compoe', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT 
        ic.id,
        ic.quantidade_componente,
        i.id as item_principal_id,
        i.codigo,
        i.descricao,
        i.familia,
        i.subfamilia,
        i.setor,
        i.unidadearmazenamento
      FROM itens_compostos ic
      JOIN itens i ON ic.item_principal_id = i.id
      WHERE ic.item_componente_id = $1
      ORDER BY i.codigo
    `, [itemId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar itens que compõe:', error);
    res.status(500).json({ error: 'Erro ao buscar itens que compõe' });
  }
});

// Atualizar quantidade de um componente
app.put('/api/itens/:id/componentes/:componenteId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    const componenteId = req.params.componenteId;
    const { quantidade_componente } = req.body;
    
         if (!quantidade_componente || quantidade_componente <= 0) {
       return res.status(400).json({ error: 'Quantidade necessária deve ser maior que zero' });
     }
    
    const { rowCount } = await pool.query(
      'UPDATE itens_compostos SET quantidade_componente = $1 WHERE item_principal_id = $2 AND id = $3',
      [quantidade_componente, itemId, componenteId]
    );
    
         if (rowCount === 0) {
       return res.status(404).json({ error: 'Item não encontrado na composição' });
     }
     
     res.json({ message: 'Quantidade necessária atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar quantidade:', error);
    res.status(500).json({ error: 'Erro ao atualizar quantidade' });
  }
});

// Rota para limpar imagens órfãs (imagens no banco que não existem no R2)
app.post('/api/limpar-imagens-orfas', authenticateToken, async (req, res) => {
  try {
    // Verificar se é admin
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta operação' });
    }

    // Buscar todas as imagens do banco
    const result = await pool.query('SELECT id, nome_arquivo, caminho FROM imagens ORDER BY id');
    const imagens = result.rows;
    
    let totalVerificadas = 0;
    let totalRemovidas = 0;
    const imagensRemovidas = [];

    for (const imagem of imagens) {
      totalVerificadas++;
      
      try {
        // Verificar se a imagem existe no R2
        await s3.headObject({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: imagem.nome_arquivo
        }).promise();
        
        console.log(`✅ Imagem existe no R2: ${imagem.nome_arquivo}`);
      } catch (error) {
        if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
          // Imagem não existe no R2, remover do banco
          await pool.query('DELETE FROM imagens WHERE id = $1', [imagem.id]);
          totalRemovidas++;
          imagensRemovidas.push({
            id: imagem.id,
            nome: imagem.nome_arquivo,
            caminho: imagem.caminho
          });
          console.log(`🗑️  Removida imagem órfã: ${imagem.nome_arquivo}`);
        } else {
          console.error(`❌ Erro ao verificar imagem ${imagem.nome_arquivo}:`, error.message);
        }
      }
    }

    res.json({
      message: 'Limpeza de imagens órfãs concluída',
      totalVerificadas,
      totalRemovidas,
      imagensRemovidas
    });

  } catch (error) {
    console.error('Erro na limpeza de imagens órfãs:', error);
    res.status(500).json({ 
      error: 'Erro na limpeza de imagens órfãs',
      details: error.message 
    });
  }
});

// Rota para salvar itens não cadastrados
app.post('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { itens } = req.body;
    
    if (!Array.isArray(itens)) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    let n = 0;
    for (const item of itens) {
      if (!item || item.codigo == null || String(item.codigo).trim() === '') continue;
      const codigo = String(item.codigo).trim();
      await pool.query(
        `INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens, data_importacao)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (codigo) DO UPDATE SET
           descricao = EXCLUDED.descricao,
           armazens = EXCLUDED.armazens,
           data_importacao = EXCLUDED.data_importacao`,
        [
          codigo,
          item.descricao != null ? String(item.descricao) : '',
          JSON.stringify(item.armazens && typeof item.armazens === 'object' ? item.armazens : {}),
          new Date(),
        ]
      );
      n += 1;
    }

    res.json({ message: 'Itens não cadastrados salvos com sucesso', total: n });
  } catch (error) {
    console.error('Erro ao salvar itens não cadastrados:', error);
    res.status(500).json({ error: 'Erro ao salvar itens não cadastrados' });
  }
});

// Cadastrar em lote: cria `itens` + `armazens_item` a partir do stock nacional em `itens_nao_cadastrados`
app.post('/api/itens-nao-cadastrados/cadastrar-todos', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    const result = await cadastrarTodosItensNaoCadastrados(pool);
    res.json(result);
  } catch (error) {
    console.error('Erro ao cadastrar todos os itens não cadastrados:', error);
    res.status(500).json({ error: error.message || 'Erro ao cadastrar itens' });
  }
});

// Rota para buscar itens não cadastrados
app.get('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Buscando itens não cadastrados...');
    console.log('👤 Usuário:', req.user?.username, 'Role:', req.user?.role);
    
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      console.log('❌ Acesso negado para usuário:', req.user?.username);
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    console.log('✅ Usuário autorizado, executando query...');
    
    // Buscar itens não cadastrados que não estão na tabela de itens cadastrados
    const result = await pool.query(`
      SELECT inc.* 
      FROM itens_nao_cadastrados inc
      WHERE NOT EXISTS (
        SELECT 1 FROM itens i WHERE i.codigo = inc.codigo
      )
      ORDER BY inc.data_importacao DESC
    `);
    console.log('📊 Resultado da query:', result.rows.length, 'itens não cadastrados encontrados');
    
    const itens = result.rows.map((row, index) => {
      console.log(`📝 Processando item ${index + 1}:`, {
        codigo: row.codigo,
        descricao: row.descricao,
        armazens_type: typeof row.armazens,
        armazens_value: row.armazens
      });
      
      let armazens = {};
      try {
        if (row.armazens) {
          armazens = typeof row.armazens === 'string' ? JSON.parse(row.armazens) : row.armazens;
        }
      } catch (parseError) {
        console.error('❌ Erro ao fazer parse do armazens:', parseError);
        armazens = {};
      }
      
      return {
        id: row.id,
        codigo: row.codigo,
        descricao: row.descricao,
        armazens: armazens,
        data_importacao: row.data_importacao
      };
    });

    console.log('✅ Enviando resposta com', itens.length, 'itens');
    res.json(itens);
  } catch (error) {
    console.error('❌ Erro ao buscar itens não cadastrados:', error);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Erro ao buscar itens não cadastrados',
      details: error.message 
    });
  }
});

// Rota para remover itens não cadastrados
app.delete('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    await pool.query('DELETE FROM itens_nao_cadastrados');
    res.json({ message: 'Itens não cadastrados removidos com sucesso' });
  } catch (error) {
    console.error('Erro ao remover itens não cadastrados:', error);
    res.status(500).json({ error: 'Erro ao remover itens não cadastrados' });
  }
});

// Rota para remover um item não cadastrado específico
app.delete('/api/itens-nao-cadastrados/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { id } = req.params;
    
    // Verificar se o item existe
    const checkResult = await pool.query('SELECT id FROM itens_nao_cadastrados WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Remover o item
    await pool.query('DELETE FROM itens_nao_cadastrados WHERE id = $1', [id]);
    
    res.json({ message: 'Item removido com sucesso' });
  } catch (error) {
    console.error('Erro ao remover item não cadastrado:', error);
    res.status(500).json({ error: 'Erro ao remover item não cadastrado' });
  }
});

// Rota para detectar imagens para todos os itens
app.post('/api/detectar-imagens-todos', authenticateToken, async (req, res) => {
  try {
    // Verificar se é admin
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta operação' });
    }
    
    // Buscar todos os itens
    const itensResult = await pool.query('SELECT id, codigo FROM itens ORDER BY codigo');
    const itens = itensResult.rows;
    
    let totalImportadas = 0;
    let totalJaExistentes = 0;
    const resultados = [];
    
    for (const item of itens) {
      const resultado = await detectarEImportarImagensAutomaticas(item.id, item.codigo);
      totalImportadas += resultado.importadas;
      totalJaExistentes += resultado.jaExistentes;
      
      if (resultado.importadas > 0) {
        resultados.push({
          codigo: item.codigo,
          importadas: resultado.importadas
        });
      }
    }
    
    res.json({
      message: 'Detecção automática concluída para todos os itens',
      totalItens: itens.length,
      totalImportadas,
      totalJaExistentes,
      itensComNovasImagens: resultados
    });
    
  } catch (error) {
    console.error('Erro na detecção para todos os itens:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática',
      details: error.message 
    });
  }
});

// Configuração específica do multer para arquivos Excel
const excelSetoresUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, 'setores-' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    // Aceitar arquivos Excel
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são permitidos!'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// Rota para importar setores via upload de arquivo Excel
app.post('/api/importar-setores', authenticateToken, excelSetoresUpload.single('file'), async (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo foi enviado' });
    }

    const filePath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (fileExtension !== '.xlsx' && fileExtension !== '.xls') {
      // Remover arquivo inválido
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Formato de arquivo não suportado. Use .xlsx ou .xls' });
    }

    console.log('📁 Processando arquivo:', req.file.originalname);

    // Ler arquivo Excel
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const dados = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Total de linhas lidas: ${dados.length}`);

    // Processar dados
    const resultados = {
      total: dados.length,
      processados: 0,
      sucesso: 0,
      erros: 0,
      setoresInvalidos: 0,
      itensNaoEncontrados: 0,
      detalhes: []
    };

    console.log('🔄 Iniciando processamento dos dados...');

    for (let i = 0; i < dados.length; i++) {
      const linha = dados[i];
      const codigoRaw =
        linha.Artigo ||
        linha.artigo ||
        linha.Código ||
        linha.Codigo ||
        linha.codigo ||
        linha.CODIGO ||
        linha.CODIGO_ITEM ||
        linha['Código'] ||
        linha['Codigo'];
      const codigo = codigoRaw != null && String(codigoRaw).trim() !== '' ? String(codigoRaw).trim() : '';
      const setoresString =
        linha.SETOR ||
        linha.setor ||
        linha.Setor ||
        linha.Setores ||
        linha['SETOR'] ||
        '';

      // Mostrar progresso a cada 50 itens
      if ((i + 1) % 50 === 0) {
        const percentual = Math.round(((i + 1) / dados.length) * 100);
        console.log(`📈 Progresso: ${i + 1}/${dados.length} (${percentual}%)`);
      }

      if (!codigo) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: 'N/A',
          setores: setoresString,
          erro:
            'Célula de código vazia ou cabeçalho não reconhecido (use coluna Artigo ou Código)'
        });
        continue;
      }

      resultados.processados++;

      try {
        // Buscar o item pelo código
        const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
        
        if (itemResult.rows.length === 0) {
          resultados.itensNaoEncontrados++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            setores: setoresString,
            erro: 'Item não encontrado no banco de dados'
          });
          continue;
        }

        const itemId = itemResult.rows[0].id;

        // Processar setores (separados por vírgula)
        const setoresArray = setoresString
          .split(',')
          .map(setor => setor.trim().toUpperCase())
          .filter(setor => setor.length > 0 && setor !== '')
          .filter((setor, index, array) => array.indexOf(setor) === index); // Remover duplicatas

        // Validar setores
        const setoresValidos = [];
        const setoresInvalidos = [];

        for (const setor of setoresArray) {
          if (SETORES_VALIDOS.includes(setor)) {
            setoresValidos.push(setor);
          } else {
            setoresInvalidos.push(setor);
          }
        }

        if (setoresInvalidos.length > 0) {
          resultados.setoresInvalidos++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            setores: setoresString,
            setoresValidos: setoresValidos,
            setoresInvalidos: setoresInvalidos,
            erro: 'Alguns setores são inválidos'
          });
        }

        if (setoresValidos.length > 0) {
          // Remover setores existentes do item
          await pool.query('DELETE FROM itens_setores WHERE item_id = $1', [itemId]);

          // Inserir novos setores válidos
          for (const setor of setoresValidos) {
            await pool.query(
              'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
              [itemId, setor]
            );
          }

          resultados.sucesso++;
          console.log(`✅ ${codigo}: ${setoresValidos.join(', ')}`);
        }

      } catch (error) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          setores: setoresString,
          erro: error.message
        });
      }
    }

    // Remover arquivo temporário
    fs.unlinkSync(filePath);

    console.log('📊 Estatísticas da importação:', {
      total: resultados.total,
      sucesso: resultados.sucesso,
      erros: resultados.erros,
      itensNaoEncontrados: resultados.itensNaoEncontrados,
      setoresInvalidos: resultados.setoresInvalidos
    });

    res.json({
      message: 'Importação concluída',
      ...resultados
    });

  } catch (error) {
    console.error('❌ Erro durante a importação:', error);
    
    // Remover arquivo em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Erro durante a importação',
      details: error.message 
    });
  }
});

// Rota para download do template de setores
app.get('/api/download-template-setores', authenticateToken, (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // Criar dados de exemplo
    const dados = [
      { Artigo: '3000003', SETOR: 'MOVEL' },
      { Artigo: '3000004', SETOR: 'MOVEL' },
      { Artigo: '3000020', SETOR: 'MOVEL, FIBRA' },
      { Artigo: '3000022', SETOR: 'FIBRA, CLIENTE, ENGENHARIA' },
      { Artigo: '3000023', SETOR: 'IT, LOGISTICA' }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dados);

    // Definir largura das colunas
    worksheet['!cols'] = [
      { width: 15 }, // Artigo
      { width: 40 }  // SETOR
    ];

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Setores');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Configurar headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_setores.xlsx"');
    res.setHeader('Content-Length', buffer.length);

    // Enviar arquivo
    res.send(buffer);

  } catch (error) {
    console.error('❌ Erro ao gerar template:', error);
    res.status(500).json({ 
      error: 'Erro ao gerar template',
      details: error.message 
    });
  }
});

// Rota para importar unidades de armazenamento
app.post('/api/importar-unidades', authenticateToken, excelSetoresUpload.single('file'), async (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    console.log('📁 Arquivo recebido:', req.file.originalname);

    // Unidades válidas
    const UNIDADES_VALIDAS = [
      'UN', 'KG', 'M', 'L', 'PÇ', 'ROL', 'CAIXA', 'PACOTE',
      'METRO', 'LITRO', 'QUILO', 'PECA', 'UNIDADE', 'CM', 'MM',
      'TON', 'G', 'ML', 'PCS', 'UNID', 'M2', 'M3', 'LITROS',
      'QUILOS', 'METROS', 'PECAS', 'UNIDADES', 'LT', 'MT'
    ];

    // Ler arquivo Excel
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const dados = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Processando ${dados.length} linhas do arquivo`);

    const resultados = {
      total: dados.length,
      sucesso: 0,
      erros: 0,
      itensNaoEncontrados: 0,
      unidadesInvalidas: 0,
      detalhes: []
    };

    // Processar cada linha
    for (let i = 0; i < dados.length; i++) {
      const row = dados[i];
      const codigo = row['Artigo']?.toString().trim();
      const unidadeString = row['UNIDADE_ARMAZENAMENTO']?.toString().trim().toUpperCase();

      console.log(`🔍 Processando linha ${i + 1}: ${codigo} -> ${unidadeString}`);

      if (!codigo) {
        console.log(`❌ Linha ${i + 1}: Código vazio`);
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: 'N/A',
          erro: 'Código do artigo não encontrado'
        });
        continue;
      }

      // Validar unidade
      if (unidadeString && !UNIDADES_VALIDAS.includes(unidadeString)) {
        resultados.unidadesInvalidas++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          erro: 'Unidade de armazenamento inválida',
          unidadeInvalida: unidadeString
        });
        continue;
      }

      try {
        // Buscar item pelo código
        const { rows: itens } = await pool.query(
          'SELECT id FROM itens WHERE codigo = $1',
          [codigo]
        );

        if (itens.length === 0) {
          resultados.itensNaoEncontrados++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            erro: 'Item não encontrado no sistema'
          });
          continue;
        }

        const itemId = itens[0].id;

        // Atualizar unidade de armazenamento
        await pool.query(
          'UPDATE itens SET unidadearmazenamento = $1 WHERE id = $2',
          [unidadeString || null, itemId]
        );

        resultados.sucesso++;
        console.log(`✅ Item ${codigo} atualizado com unidade: ${unidadeString || 'null'}`);
        console.log(`📊 Progresso: ${i + 1}/${dados.length} (${Math.round(((i + 1) / dados.length) * 100)}%)`);

      } catch (error) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          erro: error.message
        });
      }
    }

    // Remover arquivo temporário
    fs.unlinkSync(filePath);

    console.log('📊 Estatísticas da importação de unidades:', {
      total: resultados.total,
      sucesso: resultados.sucesso,
      erros: resultados.erros,
      itensNaoEncontrados: resultados.itensNaoEncontrados,
      unidadesInvalidas: resultados.unidadesInvalidas
    });

    res.json({
      message: 'Importação de unidades concluída',
      ...resultados
    });

  } catch (error) {
    console.error('❌ Erro durante a importação de unidades:', error);
    
    // Remover arquivo em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Erro durante a importação de unidades',
      details: error.message 
    });
  }
});

// Rota para download do template de unidades
app.get('/api/download-template-unidades', authenticateToken, (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // Criar dados de exemplo
    const dados = [
      { Artigo: '3000003', UNIDADE_ARMAZENAMENTO: 'UN' },
      { Artigo: '3000004', UNIDADE_ARMAZENAMENTO: 'KG' },
      { Artigo: '3000020', UNIDADE_ARMAZENAMENTO: 'M' },
      { Artigo: '3000022', UNIDADE_ARMAZENAMENTO: 'L' },
      { Artigo: '3000023', UNIDADE_ARMAZENAMENTO: 'PÇ' }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dados);

    // Definir largura das colunas
    worksheet['!cols'] = [
      { width: 15 }, // Artigo
      { width: 25 }  // UNIDADE_ARMAZENAMENTO
    ];

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Unidades');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Configurar headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_unidades.xlsx"');
    res.setHeader('Content-Length', buffer.length);

    // Enviar arquivo
    res.send(buffer);

  } catch (error) {
    console.error('❌ Erro ao gerar template de unidades:', error);
    res.status(500).json({ 
      error: 'Erro ao gerar template de unidades',
      details: error.message 
    });
  }
});

// ============================================
// ROTAS DE ARMAZÉNS
// ============================================

// Listar todos os armazéns (com localizações quando a tabela existir)
app.get('/api/armazens', authenticateToken, async (req, res) => {
  try {
    const { ativo } = req.query;
    let query = 'SELECT * FROM armazens WHERE 1=1';
    const params = [];

    if (ativo !== undefined) {
      query += ' AND ativo = $1';
      params.push(ativo === 'true');
    }

    query += ' ORDER BY codigo ASC';
    let result;
    try {
      result = await pool.query(query, params);
    } catch (orderError) {
      if (orderError.code === '42703') {
        query = query.replace(' ORDER BY codigo ASC', ' ORDER BY descricao ASC');
        result = await pool.query(query, params);
      } else {
        throw orderError;
      }
    }

    let armazens = result.rows;
    if (req.user && req.user.role === 'supervisor_armazem') {
      const allowed = await fetchRequisicoesArmazemIdsForUser(req.user.id);
      if (!allowed.length) {
        return res.json([]);
      }
      const allowSet = new Set(allowed);
      armazens = armazens.filter((a) => allowSet.has(a.id));
    }
    try {
      const ids = armazens.map((a) => a.id).filter((id) => id != null);
      const byArm = new Map();
      if (ids.length > 0) {
        let locRows;
        try {
          const locResult = await pool.query(
            `SELECT armazem_id, id, localizacao, tipo_localizacao
             FROM armazens_localizacoes
             WHERE armazem_id = ANY($1::int[])
             ORDER BY armazem_id, id`,
            [ids]
          );
          locRows = locResult.rows || [];
        } catch (locE) {
          if (locE.code === '42703') {
            const locResult = await pool.query(
              `SELECT armazem_id, id, localizacao
               FROM armazens_localizacoes
               WHERE armazem_id = ANY($1::int[])
               ORDER BY armazem_id, id`,
              [ids]
            );
            locRows = (locResult.rows || []).map((r) => ({
              ...r,
              tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal'
            }));
          } else {
            throw locE;
          }
        }
        for (const r of locRows) {
          const aid = r.armazem_id;
          const tipoLoc = r.tipo_localizacao || 'normal';
          if (!byArm.has(aid)) byArm.set(aid, []);
          byArm.get(aid).push({
            id: r.id,
            localizacao: r.localizacao,
            tipo_localizacao: tipoLoc
          });
        }
      }
      for (const a of armazens) {
        a.tipo = a.tipo || 'viatura';
        let locs = byArm.get(a.id) || [];
        if (locs.length === 0 && a.localizacao) {
          locs = [
            {
              id: null,
              localizacao: a.localizacao,
              tipo_localizacao: (a.localizacao || '').toString().toUpperCase().includes('.FERR') ? 'FERR' : 'normal'
            }
          ];
        }
        a.localizacoes = locs;
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      for (const a of armazens) {
        a.tipo = a.tipo || 'viatura';
        a.localizacoes = a.localizacao ? [{ id: null, localizacao: a.localizacao, tipo_localizacao: 'normal' }] : [];
      }
    }
    res.json(armazens);
  } catch (error) {
    // Tabela armazens ainda não criada - retornar lista vazia
    if (error.code === '42P01') {
      console.warn('⚠️ Tabela "armazens" não existe. Execute: server/create-armazens-requisicoes-v2.sql');
      return res.json([]);
    }
    console.error('Erro ao listar armazéns:', error);
    res.status(500).json({ error: 'Erro ao listar armazéns', details: error.message });
  }
});

// Buscar armazém por ID (com localizações)
app.get('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM armazens WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Armazém não encontrado' });
    }

    const armazem = result.rows[0];
    if (req.user && req.user.role === 'supervisor_armazem') {
      const allowed = await fetchRequisicoesArmazemIdsForUser(req.user.id);
      const idNum = parseInt(id, 10);
      if (!allowed.includes(idNum)) {
        return res.status(403).json({ error: 'Acesso negado a este armazém' });
      }
    }
    armazem.tipo = armazem.tipo || 'viatura';
    try {
      try {
        const locResult = await pool.query(
          'SELECT id, localizacao, tipo_localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [id]
        );
        armazem.localizacoes = (locResult.rows || []).map(r => ({ id: r.id, localizacao: r.localizacao, tipo_localizacao: r.tipo_localizacao || 'normal' }));
      } catch (locE) {
        if (locE.code === '42703') {
          const locResult = await pool.query('SELECT id, localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id', [id]);
          armazem.localizacoes = (locResult.rows || []).map(r => ({ ...r, tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }));
        } else throw locE;
      }
      if (armazem.localizacoes.length === 0 && armazem.localizacao) {
        armazem.localizacoes = [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }];
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      armazem.localizacoes = armazem.localizacao ? [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : [];
    }
    res.json(armazem);
  } catch (error) {
    console.error('Erro ao buscar armazém:', error);
    res.status(500).json({ error: 'Erro ao buscar armazém', details: error.message });
  }
});

// Criar novo armazém (apenas admin)
app.post('/api/armazens', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'backoffice_armazem') {
      return res.status(403).json({ error: 'Apenas administradores ou backoffice armazém podem criar armazéns' });
    }

    const { codigo, descricao, localizacao, localizacoes, tipo } = req.body;

    if (!codigo || !codigo.toString().trim()) {
      return res.status(400).json({ error: 'Código é obrigatório (ex: V848 ou E)' });
    }
    if (!descricao || !descricao.toString().trim()) {
      return res.status(400).json({ error: 'Descrição é obrigatória (ex: BBCH06)' });
    }

    const tipoRaw = (tipo != null) ? String(tipo).trim().toLowerCase() : '';
    const tipoArmazem =
      tipoRaw === 'central' || tipoRaw === 'viatura' || tipoRaw === 'apeado' || tipoRaw === 'epi'
        ? tipoRaw
        : 'viatura';
    const codigoNorm = codigo.toString().trim().toUpperCase();
    const descricaoTrim = (descricao || '').trim();

    let locsWithTipo = [];
    if (Array.isArray(localizacoes) && localizacoes.length > 0) {
      locsWithTipo = localizacoes.map(l => {
        if (typeof l === 'object' && l !== null && l.localizacao != null) {
          return { localizacao: String(l.localizacao).trim(), tipo_localizacao: (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal' };
        }
        const s = String(l).trim();
        if (!s) return null;
        return { localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' };
      }).filter(Boolean);
    }
    if (localizacao && localizacao.toString().trim()) {
      const s = localizacao.toString().trim();
      if (!locsWithTipo.some(l => l.localizacao === s)) locsWithTipo.unshift({ localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' });
    }
    if (tipoArmazem === 'viatura') {
      if (locsWithTipo.length !== 2) {
        locsWithTipo = [
          { localizacao: codigoNorm, tipo_localizacao: 'normal' },
          { localizacao: codigoNorm + '.FERR', tipo_localizacao: 'FERR' }
        ];
      } else {
        const hasFERR = locsWithTipo.some(l => l.tipo_localizacao === 'FERR' || (l.localizacao || '').toUpperCase().includes('.FERR'));
        if (!hasFERR) locsWithTipo[1] = { ...locsWithTipo[1], localizacao: codigoNorm + '.FERR', tipo_localizacao: 'FERR' };
      }
    }
    if (tipoArmazem === 'central') {
      const hasRecebimento = locsWithTipo.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = locsWithTipo.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        return res.status(400).json({ error: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
      }
    }
    if (tipoArmazem === 'apeado' || tipoArmazem === 'epi') {
      locsWithTipo = [{ localizacao: codigoNorm, tipo_localizacao: 'normal' }];
    }

    let result;
    try {
      result = await pool.query(`
        INSERT INTO armazens (codigo, descricao, localizacao, tipo)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [codigoNorm, descricaoTrim, (locsWithTipo[0] && locsWithTipo[0].localizacao) || null, tipoArmazem]);
    } catch (insertError) {
      if (insertError.code === '42703') {
        try {
          result = await pool.query(`
            INSERT INTO armazens (codigo, descricao, localizacao)
            VALUES ($1, $2, $3)
            RETURNING *
          `, [codigoNorm, descricaoTrim, (locsWithTipo[0] && locsWithTipo[0].localizacao) || null]);
          console.log(`✅ Armazém criado (esquema antigo): ${result.rows[0].descricao}`);
          return res.status(201).json(result.rows[0]);
        } catch (fallbackErr) {
          console.error('Erro ao criar armazém (fallback):', fallbackErr);
          return res.status(500).json({
            error: 'Erro ao criar armazém. Execute a migração: server/migrate-armazens-add-codigo.sql',
            details: fallbackErr.message
          });
        }
      }
      throw insertError;
    }

    const armazemId = result.rows[0].id;
    let localizacoesSemTipo = false;
    if (locsWithTipo.length > 0) {
      try {
        for (const loc of locsWithTipo) {
          try {
            await pool.query(
              'INSERT INTO armazens_localizacoes (armazem_id, localizacao, tipo_localizacao) VALUES ($1, $2, $3)',
              [armazemId, loc.localizacao, loc.tipo_localizacao || 'normal']
            );
          } catch (insE) {
            if (insE.code === '42703') {
              await pool.query('INSERT INTO armazens_localizacoes (armazem_id, localizacao) VALUES ($1, $2)', [armazemId, loc.localizacao]);
              localizacoesSemTipo = true;
            } else throw insE;
          }
        }
        if (localizacoesSemTipo) {
          console.warn('⚠️ Coluna tipo_localizacao não existe. Execute: server/migrate-armazens-tipo-central-viatura.sql');
        }
      } catch (e) {
        if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Tabela armazens_localizacoes não existe. Execute a migração:',
            details: 'server/migrate-armazens-multiplas-localizacoes.sql ou server/criar-tabelas-armazens-requisicoes.sql'
          });
        }
        throw e;
      }
    }
    const armazemFinal = result.rows[0];
    armazemFinal.tipo = armazemFinal.tipo || tipoArmazem;
    armazemFinal.localizacoes = locsWithTipo.map((l, i) => ({ id: i + 1, localizacao: l.localizacao, tipo_localizacao: l.tipo_localizacao || 'normal' }));
    if (localizacoesSemTipo) {
      armazemFinal.warning = 'Localizações foram salvas, mas o tipo (Recebimento/Expedição) não. Execute a migração: server/migrate-armazens-tipo-central-viatura.sql';
    }
    console.log(`✅ Armazém criado: ${armazemFinal.codigo} - ${armazemFinal.descricao}`);
    res.status(201).json(armazemFinal);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Já existe um armazém com este código de viatura' });
    }
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Tabela "armazens" não existe. Execute o script SQL:',
        details: 'psql -U USUARIO -d NOME_DA_BASE -f server/create-armazens-requisicoes-v2.sql'
      });
    }
    console.error('Erro ao criar armazém:', error);
    res.status(500).json({
      error: 'Erro ao criar armazém',
      details: error.message || String(error)
    });
  }
});

// Importar armazéns viatura em lote (código + descrição → 2 localizações automáticas)
app.post('/api/armazens/import-viatura', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'backoffice_armazem') {
      return res.status(403).json({ error: 'Apenas administradores ou backoffice armazém podem importar armazéns' });
    }

    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Envie um array rows com objetos { codigo, descricao }.' });
    }
    if (rows.length > 2000) {
      return res.status(400).json({ error: 'Máximo 2000 linhas por importação.' });
    }

    const seen = new Set();
    const created = [];
    const skipped = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const codigo = String(raw?.codigo ?? '').trim().toUpperCase();
      const descricao = String(raw?.descricao ?? '').trim();

      if (!codigo) {
        errors.push({ line: i + 1, codigo: raw?.codigo ?? '', reason: 'Código em falta' });
        continue;
      }
      if (!descricao) {
        errors.push({ line: i + 1, codigo, reason: 'Descrição em falta' });
        continue;
      }
      if (seen.has(codigo)) {
        skipped.push({ codigo, reason: 'Duplicado no ficheiro' });
        continue;
      }
      seen.add(codigo);

      try {
        const out = await createArmazemViatura(pool, codigo, descricao);
        created.push({ id: out.id, codigo: out.codigo });
      } catch (e) {
        if (e.code === 'VALIDATION') {
          errors.push({ line: i + 1, codigo, reason: e.message });
        } else if (e.code === '23505') {
          skipped.push({ codigo, reason: 'Já existe na base' });
        } else if (e.code === 'NO_LOC_TABLE') {
          return res.status(503).json({
            error: 'Tabela armazens_localizacoes não existe. Execute a migração SQL de armazéns.',
            details: e.message
          });
        } else if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Tabela "armazens" não existe. Execute o script SQL de criação.',
            details: e.message
          });
        } else {
          errors.push({ line: i + 1, codigo, reason: e.message || String(e) });
        }
      }
    }

    res.json({ created, skipped, errors });
  } catch (error) {
    console.error('Erro ao importar viaturas:', error);
    res.status(500).json({ error: 'Erro ao importar viaturas', details: error.message });
  }
});

// Atualizar armazém (admin / backoffice: completo; supervisor: só localizações nos armazéns atribuídos)
app.put('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    const role = req.user.role;
    const isFullArmazem = role === 'admin' || role === 'backoffice_armazem';
    const isSupervisor = role === 'supervisor_armazem';
    if (!isFullArmazem && !isSupervisor) {
      return res.status(403).json({ error: 'Sem permissão para atualizar armazéns' });
    }

    const { id } = req.params;
    const idNum = parseInt(id, 10);
    if (Number.isNaN(idNum)) {
      return res.status(400).json({ error: 'ID de armazém inválido' });
    }

    if (isSupervisor) {
      const allowed = await fetchRequisicoesArmazemIdsForUser(req.user.id);
      if (!allowed.includes(idNum)) {
        return res.status(403).json({ error: 'Acesso negado a este armazém' });
      }
      const body = req.body || {};
      if (
        body.codigo !== undefined ||
        body.descricao !== undefined ||
        body.ativo !== undefined ||
        body.tipo !== undefined
      ) {
        return res.status(403).json({
          error: 'Supervisor só pode alterar localizações dos armazéns atribuídos'
        });
      }
      if (!Array.isArray(body.localizacoes)) {
        return res.status(400).json({ error: 'Envie a lista de localizações (localizacoes)' });
      }
    }

    const { codigo, descricao, localizacao, localizacoes, ativo, tipo } = req.body;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (codigo !== undefined && codigo.toString().trim()) {
      updates.push(`codigo = $${paramCount++}`);
      params.push(codigo.toString().trim().toUpperCase());
    }

    if (descricao !== undefined) {
      updates.push(`descricao = $${paramCount++}`);
      params.push(descricao);
    }

    let locsWithTipo = [];
    if (localizacoes !== undefined && Array.isArray(localizacoes)) {
      locsWithTipo = localizacoes.map(l => {
        if (typeof l === 'object' && l !== null && l.localizacao != null) {
          return { localizacao: String(l.localizacao).trim(), tipo_localizacao: (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal' };
        }
        const s = String(l).trim();
        if (!s) return null;
        return { localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' };
      }).filter(Boolean);
    }
    let locVal = locsWithTipo[0]?.localizacao ?? (localizacao !== undefined ? localizacao : undefined);
    if (locVal !== undefined) {
      updates.push(`localizacao = $${paramCount++}`);
      params.push(locVal);
    }

    if (ativo !== undefined) {
      updates.push(`ativo = $${paramCount++}`);
      params.push(ativo);
    }

    const tipoNormPut = tipo != null ? String(tipo).trim().toLowerCase() : undefined;
    if (
      tipoNormPut !== undefined &&
      (tipoNormPut === 'central' || tipoNormPut === 'viatura' || tipoNormPut === 'apeado' || tipoNormPut === 'epi')
    ) {
      try {
        updates.push(`tipo = $${paramCount++}`);
        params.push(tipoNormPut);
      } catch (_) {}
    }

    const temLocalizacoesParaAtualizar = localizacoes !== undefined && Array.isArray(localizacoes);
    if (updates.length === 0 && !temLocalizacoesParaAtualizar) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    let tipoParaValidacao = tipoNormPut;
    if (temLocalizacoesParaAtualizar && tipoParaValidacao === undefined) {
      const arm = await pool.query('SELECT tipo FROM armazens WHERE id = $1', [id]);
      tipoParaValidacao = arm.rows[0]?.tipo || 'viatura';
    }
    if (temLocalizacoesParaAtualizar && tipoParaValidacao === 'central') {
      const hasRecebimento = locsWithTipo.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = locsWithTipo.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        return res.status(400).json({ error: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
      }
    }

    if (updates.length > 0) {
      params.push(id);
      const tipoIdx = updates.findIndex(u => u.startsWith('tipo ='));
      try {
        await pool.query(`
          UPDATE armazens 
          SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${paramCount}
        `, params);
      } catch (updE) {
        if (updE.code === '42703' && tipoIdx !== -1) {
          const cleanUpdates = updates.filter((_, i) => i !== tipoIdx);
          const cleanParams = params.slice(0, -1).filter((_, i) => i !== tipoIdx);
          cleanParams.push(id);
          if (cleanUpdates.length > 0) await pool.query(`UPDATE armazens SET ${cleanUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${cleanParams.length}`, cleanParams);
        } else throw updE;
      }
    }

    if (temLocalizacoesParaAtualizar) {
      const snap = await pool.query('SELECT codigo, tipo FROM armazens WHERE id = $1', [id]);
      if (snap.rows.length === 0) {
        return res.status(404).json({ error: 'Armazém não encontrado' });
      }
      const tipoEff = snap.rows[0]?.tipo || 'viatura';
      const codigoEff = (snap.rows[0]?.codigo || '').toString().trim().toUpperCase();
      if (tipoEff === 'apeado' || tipoEff === 'epi') {
        locsWithTipo = [{ localizacao: codigoEff, tipo_localizacao: 'normal' }];
      } else if (tipoEff === 'viatura' && locsWithTipo.length !== 2) {
        locsWithTipo = [
          { localizacao: codigoEff, tipo_localizacao: 'normal' },
          { localizacao: codigoEff + '.FERR', tipo_localizacao: 'FERR' }
        ];
      }
    }

    if (temLocalizacoesParaAtualizar && locsWithTipo.length > 0) {
      try {
        await pool.query('DELETE FROM armazens_localizacoes WHERE armazem_id = $1', [id]);
        for (const loc of locsWithTipo) {
          try {
            await pool.query(
              'INSERT INTO armazens_localizacoes (armazem_id, localizacao, tipo_localizacao) VALUES ($1, $2, $3)',
              [id, loc.localizacao, loc.tipo_localizacao || 'normal']
            );
          } catch (insE) {
            if (insE.code === '42703') {
              await pool.query('INSERT INTO armazens_localizacoes (armazem_id, localizacao) VALUES ($1, $2)', [id, loc.localizacao]);
            } else throw insE;
          }
        }
      } catch (e) {
        if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Tabela armazens_localizacoes não existe. Execute a migração:',
            details: 'server/migrate-armazens-multiplas-localizacoes.sql ou server/criar-tabelas-armazens-requisicoes.sql'
          });
        }
        throw e;
      }
    }

    const result = await pool.query('SELECT * FROM armazens WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Armazém não encontrado' });
    }

    const armazem = result.rows[0];
    armazem.tipo = armazem.tipo || 'viatura';
    try {
      try {
        const locResult = await pool.query(
          'SELECT id, localizacao, tipo_localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [id]
        );
        armazem.localizacoes = (locResult.rows || []).map(r => ({ id: r.id, localizacao: r.localizacao, tipo_localizacao: r.tipo_localizacao || 'normal' }));
      } catch (locE) {
        if (locE.code === '42703') {
          const locResult = await pool.query('SELECT id, localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id', [id]);
          armazem.localizacoes = (locResult.rows || []).map(r => ({ ...r, tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }));
        } else throw locE;
      }
      if (armazem.localizacoes.length === 0 && armazem.localizacao) {
        armazem.localizacoes = [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }];
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      armazem.localizacoes = armazem.localizacao ? [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : [];
    }

    console.log(`✅ Armazém atualizado: ID ${id}`);
    res.json(armazem);
  } catch (error) {
    console.error('Erro ao atualizar armazém:', error);
    res.status(500).json({ error: 'Erro ao atualizar armazém', details: error.message });
  }
});

// Deletar armazém (apenas admin)
app.delete('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'backoffice_armazem') {
      return res.status(403).json({ error: 'Apenas administradores ou backoffice armazém podem deletar armazéns' });
    }

    const { id } = req.params;
    const idNum = parseInt(id, 10);
    if (Number.isNaN(idNum)) {
      return res.status(400).json({ error: 'ID de armazém inválido' });
    }

    let reqDestino = 0;
    let reqOrigem = 0;
    try {
      const chk = await pool.query(
        `SELECT
          (SELECT COUNT(*)::int FROM requisicoes WHERE armazem_id = $1) AS req_destino,
          (SELECT COUNT(*)::int FROM requisicoes WHERE armazem_origem_id = $1) AS req_origem`,
        [idNum]
      );
      reqDestino = chk.rows[0]?.req_destino ?? 0;
      reqOrigem = chk.rows[0]?.req_origem ?? 0;
    } catch (chkErr) {
      if (chkErr.code !== '42P01') throw chkErr;
    }

    if (reqDestino > 0) {
      return res.status(409).json({
        error: 'Não é possível eliminar este armazém.',
        details:
          `Existem ${reqDestino} requisição(ões) em que este armazém é o destino (viatura). ` +
          'Altere o armazém de destino nessas requisições ou aguarde que deixem de o usar antes de eliminar.',
        code: 'ARMAZEM_REQUISICOES_DESTINO',
        counts: { requisicoes_destino: reqDestino, requisicoes_origem: reqOrigem }
      });
    }

    await pool.query('DELETE FROM armazens WHERE id = $1', [idNum]);

    console.log(`✅ Armazém deletado: ID ${idNum}`);
    res.json({ message: 'Armazém deletado com sucesso' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        error: 'Não é possível eliminar este armazém.',
        details:
          'Ainda existem registos que referenciam este armazém (integridade na base de dados). ' +
          'Verifique requisições, utilizadores ou outros vínculos.',
        hint: error.detail || error.message
      });
    }
    console.error('Erro ao deletar armazém:', error);
    res.status(500).json({ error: 'Erro ao deletar armazém', details: error.message });
  }
});

app.use(
  '/api/requisicoes',
  createRequisicoesRouter({
    pool,
    requisicaoAuth,
    authenticateToken,
    requisicaoScopeMiddleware,
    requisicaoArmazemOrigemAcessoPermitido,
    assertIdsRequisicoesPermitidas,
    excelUploadRequisicoes,
  })
);


if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`API disponível em http://localhost:${PORT}/api`);
  console.log(`[pg] pool max=${pgPoolMax} ligações (PGPOOL_MAX no .env para ajustar)`);
});
