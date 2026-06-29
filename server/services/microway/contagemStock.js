const path = require('path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const {
  MW_WAREHOUSE_ORDER,
  loadMicrowayWarehouseAliasMap,
  resolveMicrowayExportLabel,
  exportLabelForArmazemCodigo,
} = require('../../utils/warehouseAliasMap');

const MICROWAY_ALIAS_MAP = loadMicrowayWarehouseAliasMap(
  path.join(__dirname, '..', '..', 'ALIAS.xlsx')
);

function warehouseLabelFromDescricao(descricao, codigo) {
  const fromAlias = exportLabelForArmazemCodigo(codigo, MICROWAY_ALIAS_MAP);
  if (fromAlias) return fromAlias;

  const desc = String(descricao || '').toUpperCase();
  for (const label of MW_WAREHOUSE_ORDER) {
    if (desc.includes(label)) return label;
  }
  const cod = String(codigo || '').trim().toUpperCase();
  if (cod) return cod;
  return String(descricao || '').trim().toUpperCase() || '—';
}

function warehouseSortIndex(label) {
  const u = String(label || '').trim().toUpperCase();
  const idx = MICROWAY_ALIAS_MAP.exportLabels.findIndex(
    (l) => String(l).trim().toUpperCase() === u
  );
  if (idx >= 0) return idx;
  const legacy = MW_WAREHOUSE_ORDER.indexOf(u);
  return legacy >= 0 ? legacy : MICROWAY_ALIAS_MAP.exportLabels.length + 1;
}

function normalizeWarehouseLabel(label) {
  return String(label || '').trim().toUpperCase();
}

function buildMicrowayWarehouseExportList() {
  return MICROWAY_ALIAS_MAP.exportLabels.map((warehouseLabel) => ({
    warehouseLabel,
    sortIndex: warehouseSortIndex(warehouseLabel),
  })).sort((a, b) => a.sortIndex - b.sortIndex);
}

/** EXP.* → expedição; armazém apeado → damaged; resto no central → functional. */
function classificarMicrowayBucket(armazemTipo, localizacao) {
  const arm = String(armazemTipo || '').trim().toLowerCase();
  if (arm === 'apeado' || arm === 'apeados') return 'damaged';
  const loc = String(localizacao || '').trim().toUpperCase();
  if (loc.startsWith('EXP.')) return 'expedition';
  return 'functional';
}

function isViaturaMwWarehouse(warehouse) {
  const w = String(warehouse || '').trim().toUpperCase();
  return /^V\d/.test(w);
}

function normalizeMwRow(row) {
  const norm = {};
  for (const [k, v] of Object.entries(row || {})) {
    norm[String(k || '').trim().toLowerCase()] = v;
  }
  const codigo = String(norm.item || norm.erp || norm.codigo || '').trim();
  const descricaoMw = String(norm.description || norm.descricao || norm.descrição || '').trim();
  const warehouse = String(norm.warehouse || norm.armazem || '').trim();
  const localizacao = String(norm.location || norm.localizacao || norm.localização || '').trim();
  const stockRaw = norm.stock ?? norm.quantidade ?? norm.qty ?? 0;
  const stock = Number(stockRaw) || 0;
  return { codigo, descricaoMw, warehouse, localizacao, stock };
}

function readMwSheetRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.includes('Sheet') ? 'Sheet' : wb.SheetNames[0];
  if (!sheetName || !wb.Sheets[sheetName]) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

function parseMwLinhasFromBuffer(buffer) {
  const rows = readMwSheetRows(buffer);
  const out = [];
  for (const row of rows) {
    const parsed = normalizeMwRow(row);
    if (!parsed.codigo) continue;
    out.push(parsed);
  }
  return out;
}

async function loadArmazemMicrowayMaps(pool) {
  const r = await pool.query(
    `SELECT id, codigo, descricao,
            LOWER(TRIM(COALESCE(tipo, ''))) AS tipo,
            armazem_central_vinculado_id
     FROM armazens
     WHERE COALESCE(ativo, true) = true`
  );
  const centralByCodigo = new Map();
  const apeadoByCodigo = new Map();
  const centrais = [];
  for (const row of r.rows || []) {
    const cod = String(row.codigo || '').trim().toUpperCase();
    if (!cod) continue;
    const tipo = String(row.tipo || '').trim().toLowerCase();
    if (tipo === 'central') {
      const entry = {
        id: Number(row.id),
        codigo: String(row.codigo || '').trim(),
        descricao: String(row.descricao || '').trim(),
        warehouseLabel: warehouseLabelFromDescricao(row.descricao, row.codigo),
      };
      centralByCodigo.set(cod, entry);
      centrais.push(entry);
    } else if (tipo === 'apeado' || tipo === 'apeados') {
      apeadoByCodigo.set(cod, {
        centralId: Number(row.armazem_central_vinculado_id) || null,
      });
    }
  }
  return { centralByCodigo, apeadoByCodigo, centrais };
}

function resolveArmazemTipoForMwWarehouse(warehouse, maps) {
  const w = String(warehouse || '').trim().toUpperCase();
  if (maps.apeadoByCodigo.has(w) || w.startsWith('APE.')) {
    return 'apeado';
  }
  if (maps.centralByCodigo.has(w)) {
    return 'central';
  }
  return 'central';
}

function isMwWarehouseRecognized(warehouse, maps) {
  const w = String(warehouse || '').trim().toUpperCase();
  if (!w || isViaturaMwWarehouse(w)) return false;
  if (resolveMicrowayExportLabel(w, MICROWAY_ALIAS_MAP, maps)) return true;
  return Boolean(maps.centralByCodigo.get(w) || maps.apeadoByCodigo.get(w));
}

function makeTotalsKey(exportLabel, codigo) {
  return `${normalizeWarehouseLabel(exportLabel)}::${String(codigo || '').trim().toUpperCase()}`;
}

function addToTotalsByExportLabel(totalsMap, { exportLabel, codigo, armazemTipo, localizacao, qtd }) {
  const q = Number(qtd) || 0;
  if (!exportLabel || !codigo || q <= 0) return;
  const bucket = classificarMicrowayBucket(armazemTipo, localizacao);
  const key = makeTotalsKey(exportLabel, codigo);
  if (!totalsMap.has(key)) {
    totalsMap.set(key, { functional: 0, damaged: 0, expedition: 0 });
  }
  totalsMap.get(key)[bucket] += q;
}

function agregarTotaisFromMwLinhas(mwLinhas, codigosSet, maps) {
  const totalsMap = new Map();
  for (const linha of mwLinhas) {
    const codKey = String(linha.codigo || '').trim().toUpperCase();
    if (!codigosSet.has(codKey)) continue;

    const exportLabel = resolveMicrowayExportLabel(linha.warehouse, MICROWAY_ALIAS_MAP, maps);
    if (!exportLabel) continue;

    const armazemTipo = resolveArmazemTipoForMwWarehouse(linha.warehouse, maps);
    addToTotalsByExportLabel(totalsMap, {
      exportLabel,
      codigo: linha.codigo,
      armazemTipo,
      localizacao: linha.localizacao,
      qtd: linha.stock,
    });
  }
  return totalsMap;
}

function getTotalsForExportLabel(totalsMap, exportLabel, codigo) {
  return totalsMap.get(makeTotalsKey(exportLabel, codigo)) || {
    functional: 0,
    damaged: 0,
    expedition: 0,
  };
}

async function parseMwArtigosFromBuffer(buffer, pool) {
  const mwLinhas = parseMwLinhasFromBuffer(buffer);
  const maps = await loadArmazemMicrowayMapsSafe(pool);
  const byCodigo = new Map();

  for (const linha of mwLinhas) {
    const codKey = String(linha.codigo || '').trim().toUpperCase();
    if (!codKey) continue;
    const recognized = isMwWarehouseRecognized(linha.warehouse, maps);
    const prev = byCodigo.get(codKey) || {
      codigo: linha.codigo,
      descricao_mw: '',
      stock_mw: 0,
      linhas_mw: 0,
    };
    if (linha.descricaoMw && !prev.descricao_mw) prev.descricao_mw = linha.descricaoMw;
    if (recognized && linha.stock > 0) {
      prev.stock_mw += linha.stock;
      prev.linhas_mw += 1;
    }
    byCodigo.set(codKey, prev);
  }

  return [...byCodigo.values()].sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));
}

async function loadArmazemMicrowayMapsSafe(pool) {
  const empty = { centralByCodigo: new Map(), apeadoByCodigo: new Map(), centrais: [] };
  if (!pool) return empty;
  try {
    return await loadArmazemMicrowayMaps(pool);
  } catch (e) {
    console.warn('[Microway] Armazéns BD indisponíveis; agregação via ALIAS.xlsx:', e.message);
    return empty;
  }
}

async function loadDescricoesItensSafe(pool, codigos) {
  if (!pool) return new Map();
  try {
    return await loadDescricoesItens(pool, codigos);
  } catch (e) {
    console.warn('[Microway] Catálogo BD indisponível; descrições do ficheiro MW:', e.message);
    return new Map();
  }
}

async function loadDescricoesItens(pool, codigos) {
  const r = await pool.query(
    `SELECT codigo, descricao FROM itens WHERE codigo = ANY($1::text[])`,
    [codigos]
  );
  const map = new Map();
  for (const row of r.rows || []) {
    const cod = String(row.codigo || '').trim();
    if (!cod) continue;
    map.set(cod.toUpperCase(), String(row.descricao || '').trim());
  }
  return map;
}

async function agregarStockMicrowayFromMwFile(pool, buffer, codigos, descMwByCodigo = new Map()) {
  const list = [...new Set((codigos || []).map((c) => String(c || '').trim()).filter(Boolean))];
  if (!list.length) {
    return { centrais: [], linhas: [] };
  }
  if (!MICROWAY_ALIAS_MAP.loaded || MICROWAY_ALIAS_MAP.byMwCode.size === 0) {
    throw new Error(
      'Ficheiro server/ALIAS.xlsx não encontrado ou vazio. É necessário para mapear armazéns MW.'
    );
  }

  const codigosSet = new Set(list.map((c) => c.toUpperCase()));
  const maps = await loadArmazemMicrowayMapsSafe(pool);
  const itemMeta = await loadDescricoesItensSafe(pool, list);
  const mwLinhas = parseMwLinhasFromBuffer(buffer);

  const totalsMap = agregarTotaisFromMwLinhas(mwLinhas, codigosSet, maps);
  const warehousesExport = buildMicrowayWarehouseExportList();
  const sortedCodigos = [...list].sort((a, b) => String(a).localeCompare(String(b)));

  const linhas = [];
  for (const wh of warehousesExport) {
    for (const codigo of sortedCodigos) {
      const metaDesc = itemMeta.get(String(codigo).toUpperCase());
      const mwMeta = descMwByCodigo.get(String(codigo).toUpperCase());
      const descricao = metaDesc || mwMeta?.descricao_mw || '';
      const totals = getTotalsForExportLabel(totalsMap, wh.warehouseLabel, codigo);
      const erpNum = Number(codigo);
      linhas.push({
        erp: Number.isFinite(erpNum) ? erpNum : codigo,
        descricao,
        warehouse: wh.warehouseLabel,
        functional: totals.functional,
        damaged: totals.damaged,
        expedition: totals.expedition,
      });
    }
  }

  return { centrais: warehousesExport, linhas };
}

async function buildStockMwWorkbookBuffer(linhas) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.columns = [
    { width: 8 },
    { width: 52.109375 },
    { width: 14.33203125 },
    { width: 18 },
    { width: 15.77734375 },
    { width: 16.33203125 },
    { width: 10 },
  ];

  const headerRow = sheet.addRow([
    'ERP',
    'DESCRIPTION',
    'WAREHOUSE',
    'FUNCTIONAL ITEMS',
    'DAMAGED ITEMS',
    'EXPEDITION AREA',
    '',
  ]);
  headerRow.font = { name: 'Calibri', size: 10 };

  for (const row of linhas || []) {
    const dataRow = sheet.addRow([
      row.erp,
      row.descricao,
      row.warehouse,
      Number(row.functional) || 0,
      Number(row.damaged) || 0,
      Number(row.expedition) || 0,
      '',
    ]);
    dataRow.font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } };
    if (typeof row.erp === 'number') {
      dataRow.getCell(1).numFmt = '0';
    }
    for (let c = 4; c <= 6; c += 1) {
      dataRow.getCell(c).numFmt = '0';
    }
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  MW_WAREHOUSE_ORDER,
  MICROWAY_ALIAS_MAP,
  parseMwArtigosFromBuffer,
  parseMwLinhasFromBuffer,
  agregarStockMicrowayFromMwFile,
  buildStockMwWorkbookBuffer,
  classificarMicrowayBucket,
  warehouseLabelFromDescricao,
  resolveMicrowayExportLabel,
  agregarTotaisFromMwLinhas,
  getTotalsForExportLabel,
};
