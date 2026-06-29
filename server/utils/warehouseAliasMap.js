const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

/** Ordem das 7 cidades no STOCK MW de referência. */
const MW_WAREHOUSE_ORDER = [
  'LEIRIA',
  'GUARDA',
  'PORTO',
  'LISBOA',
  'FARO',
  'PONTA DELGADA',
  'MADEIRA',
];

const EXTRA_MW_CODES_ORDER = ['M', 'Q', 'R', 'S'];

/** Normaliza código MW / texto de alias para lookup. */
function normalizeAliasCode(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .trim();
}

/** OUTROS / APEADOS → rótulo WAREHOUSE do reporte Microway. */
function outrosToExportWarehouseLabel(outros) {
  let s = String(outros || '').trim().toUpperCase();
  if (!s) return '';
  if (/^APEADOS\s+/i.test(s)) {
    s = s.replace(/^APEADOS\s+/i, '').trim();
  }
  if (s === 'P. DELGADA' || s === 'P DELGADA') return 'PONTA DELGADA';
  if (s === 'ST.MARIA' || s === 'STA M. DA FEIRA' || s === 'STA M DA FEIRA') {
    return 'ST.MARIA DA FEIRA';
  }
  if (s.startsWith('ST.MARIA') || s.startsWith('STA M')) return 'ST.MARIA DA FEIRA';
  return s;
}

function loadMicrowayWarehouseAliasMap(aliasPath) {
  const byMwCode = new Map();
  const extraExportLabels = [];
  const resolvedPath = aliasPath || path.join(__dirname, '..', 'ALIAS.xlsx');

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { byMwCode, exportLabels: [...MW_WAREHOUSE_ORDER], extraExportLabels, loaded: false };
    }

    const wb = XLSX.readFile(resolvedPath);
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) {
      return { byMwCode, exportLabels: [...MW_WAREHOUSE_ORDER], extraExportLabels, loaded: false };
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    for (const row of rows || []) {
      const codigo = String(row['CODIGO ARMAZEM'] || row['codigo armazem'] || row.codigo || '').trim();
      const descricaoFicheiro = String(
        row['DESCRIÇÃO FICHEIRO'] || row['DESCRICAO FICHEIRO'] || row.descricao || ''
      ).trim();
      const outros = String(row.OUTROS || row.outros || '').trim();
      if (!codigo) continue;

      const codeNorm = normalizeAliasCode(codigo);
      const exportLabel = outrosToExportWarehouseLabel(outros || descricaoFicheiro);
      if (!exportLabel) continue;

      byMwCode.set(codeNorm, {
        codigo,
        descricaoFicheiro,
        outros,
        exportLabel,
      });
    }

    const exportLabels = [];
    const seen = new Set();

    for (const city of MW_WAREHOUSE_ORDER) {
      const key = city.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        exportLabels.push(city);
      }
    }

    for (const letter of EXTRA_MW_CODES_ORDER) {
      const entry = byMwCode.get(normalizeAliasCode(letter));
      if (!entry?.exportLabel) continue;
      const key = entry.exportLabel.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extraExportLabels.push(entry.exportLabel);
      exportLabels.push(entry.exportLabel);
    }

    return { byMwCode, exportLabels, extraExportLabels, loaded: true };
  } catch (e) {
    console.warn(`⚠️ Não foi possível carregar ALIAS.xlsx (Microway): ${e.message}`);
    return { byMwCode, exportLabels: [...MW_WAREHOUSE_ORDER], extraExportLabels, loaded: false };
  }
}

/**
 * Rótulo WAREHOUSE do reporte a partir da coluna Warehouse do MW.xlsx.
 * @param {string} mwWarehouse
 * @param {{ byMwCode: Map }} aliasMap
 * @param {{ centralByCodigo?: Map, apeadoByCodigo?: Map, centrais?: [] }} [armazemMaps]
 */
function resolveMicrowayExportLabel(mwWarehouse, aliasMap, armazemMaps = null) {
  const w = String(mwWarehouse || '').trim().toUpperCase();
  if (!w) return null;

  const direct = aliasMap?.byMwCode?.get(normalizeAliasCode(w));
  if (direct?.exportLabel) return direct.exportLabel;

  const apeMatch = w.match(/^APE\.([A-Z0-9]+)$/i);
  if (apeMatch?.[1]) {
    const parent = aliasMap?.byMwCode?.get(normalizeAliasCode(apeMatch[1]));
    if (parent?.exportLabel) return parent.exportLabel;
    const apeEntry = aliasMap?.byMwCode?.get(normalizeAliasCode(w));
    if (apeEntry?.exportLabel) return apeEntry.exportLabel;
  }

  if (armazemMaps?.centralByCodigo) {
    const central = armazemMaps.centralByCodigo.get(w);
    if (central) {
      const fromAlias = aliasMap?.byMwCode?.get(normalizeAliasCode(central.codigo));
      if (fromAlias?.exportLabel) return fromAlias.exportLabel;
    }
    const apeado = armazemMaps.apeadoByCodigo?.get(w);
    if (apeado?.centralId && armazemMaps.centrais) {
      const linked = armazemMaps.centrais.find((c) => c.id === apeado.centralId);
      if (linked) {
        const fromAlias = aliasMap?.byMwCode?.get(normalizeAliasCode(linked.codigo));
        if (fromAlias?.exportLabel) return fromAlias.exportLabel;
      }
    }
  }

  return null;
}

function exportLabelForArmazemCodigo(codigo, aliasMap) {
  const entry = aliasMap?.byMwCode?.get(normalizeAliasCode(codigo));
  return entry?.exportLabel || null;
}

module.exports = {
  MW_WAREHOUSE_ORDER,
  EXTRA_MW_CODES_ORDER,
  normalizeAliasCode,
  outrosToExportWarehouseLabel,
  loadMicrowayWarehouseAliasMap,
  resolveMicrowayExportLabel,
  exportLabelForArmazemCodigo,
};
