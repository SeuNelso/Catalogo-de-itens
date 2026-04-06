const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectPackages(lockPath, scope) {
  const lock = readJson(lockPath);
  const packages = lock.packages || {};
  const rows = [];

  Object.entries(packages).forEach(([pkgPath, meta]) => {
    if (!pkgPath || pkgPath === '') return;
    const name = pkgPath.replace(/^node_modules\//, '');
    const version = meta.version || '';
    const license = meta.license || 'UNKNOWN';
    rows.push({ scope, name, version, license });
  });

  return rows;
}

function toCsv(rows) {
  const header = 'scope,package,version,license';
  const body = rows
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
      return a.name.localeCompare(b.name);
    })
    .map((r) => {
      const vals = [r.scope, r.name, r.version, r.license].map((v) =>
        `"${String(v).replace(/"/g, '""')}"`
      );
      return vals.join(',');
    });
  return [header, ...body].join('\n') + '\n';
}

function classifyRisk(licenseText) {
  const l = String(licenseText || '').toUpperCase();
  const isRed =
    l.includes('AGPL')
    || l.includes('SSPL')
    || l.includes('BUSL')
    || l.includes('COMMONS CLAUSE')
    || (l.includes('GPL') && !l.includes('LGPL'));
  if (isRed) return { level: 'VERMELHO', color: 'VERMELHO' };

  const isYellow =
    l.includes('LGPL')
    || l.includes('MPL')
    || l.includes('CDDL')
    || l.includes('EPL')
    || l.includes('ARTISTIC')
    || l.includes('UNKNOWN');
  if (isYellow) return { level: 'AMARELO', color: 'AMARELO' };

  return { level: 'VERDE', color: 'VERDE' };
}

async function writeXlsx(rows, outFile) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Licencas');
  sheet.columns = [
    { header: 'scope', key: 'scope', width: 14 },
    { header: 'package', key: 'name', width: 48 },
    { header: 'version', key: 'version', width: 16 },
    { header: 'license', key: 'license', width: 34 },
    { header: 'risk_level', key: 'riskLevel', width: 14 },
    { header: 'risk_color', key: 'riskColor', width: 14 },
  ];

  const sorted = [...rows].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });

  sorted.forEach((r) => {
    const risk = classifyRisk(r.license);
    sheet.addRow({
      scope: r.scope,
      name: r.name,
      version: r.version,
      license: r.license,
      riskLevel: risk.level,
      riskColor: risk.color,
    });
  });

  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 6 },
  };

  const colorCol = sheet.getColumn(6);
  colorCol.eachCell((cell, rowNumber) => {
    if (rowNumber === 1) return;
    const value = String(cell.value || '');
    if (value === 'VERDE') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    } else if (value === 'AMARELO') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
    } else if (value === 'VERMELHO') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    }
  });

  await workbook.xlsx.writeFile(outFile);
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const rootLock = path.join(root, 'package-lock.json');
  const clientLock = path.join(root, 'client', 'package-lock.json');
  const outCsv = path.join(root, 'THIRD_PARTY_LICENSE_INVENTORY.csv');
  const outXlsx = path.join(root, 'THIRD_PARTY_LICENSE_INVENTORY.xlsx');

  const rows = [];
  if (fs.existsSync(rootLock)) rows.push(...collectPackages(rootLock, 'backend'));
  if (fs.existsSync(clientLock)) rows.push(...collectPackages(clientLock, 'frontend'));

  fs.writeFileSync(outCsv, toCsv(rows), 'utf8');
  await writeXlsx(rows, outXlsx);
  console.log(`[compliance] inventario de licencas gerado: ${outCsv}`);
  console.log(`[compliance] planilha de licencas gerada: ${outXlsx}`);
  console.log(`[compliance] total de pacotes inventariados: ${rows.length}`);
}

main().catch((err) => {
  console.error('[compliance] erro ao gerar inventario de licencas:', err);
  process.exit(1);
});
