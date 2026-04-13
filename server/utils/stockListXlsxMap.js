const XLSX = require('xlsx');

/**
 * Normaliza código de artigo para cruzamento (trim + maiúsculas).
 * @param {unknown} s
 */
function normCodigo(s) {
  return String(s ?? '').trim().toUpperCase();
}

/**
 * Encontra a chave do objeto da primeira linha cujo nome normalizado coincide.
 * @param {string[]} keys
 * @param {string} target ex.: "x3", "total"
 */
function findColumnKey(keys, target) {
  const t = String(target).trim().toLowerCase().replace(/\s+/g, '');
  for (const k of keys) {
    if (String(k).trim().toLowerCase().replace(/\s+/g, '') === t) {
      return k;
    }
  }
  return null;
}

/**
 * Lê um XLSX de stock (ex.: colunas x3 = código, Total = quantidade).
 * Soma quantidades quando o mesmo código aparece em várias linhas.
 * @param {string} filePath
 * @returns {Map<string, number>} código normalizado → stock */
function loadStockByCodigoFromXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return new Map();
  }
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) {
    return new Map();
  }

  const keys = Object.keys(rows[0]);
  const kx3 = findColumnKey(keys, 'x3');
  const kTotal = findColumnKey(keys, 'total');
  if (!kx3 || !kTotal) {
    const err = new Error(
      'Ficheiro de stock inválido: é necessário existir as colunas x3 (código) e Total (quantidade).'
    );
    err.code = 'STOCK_XLSX_COLS';
    throw err;
  }

  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of rows) {
    const code = normCodigo(row[kx3]);
    if (!code) continue;
    const raw = String(row[kTotal] ?? '')
      .trim()
      .replace(/\s/g, '')
      .replace(',', '.');
    const q = parseFloat(raw);
    if (!Number.isFinite(q)) continue;
    map.set(code, (map.get(code) || 0) + q);
  }
  return map;
}

module.exports = {
  normCodigo,
  loadStockByCodigoFromXlsx,
};
