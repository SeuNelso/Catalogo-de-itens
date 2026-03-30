const XLSX = require('xlsx');

const TRFL_HEADERS = [
  'Date',
  'OriginWarehouse',
  'OriginLocation',
  'Article',
  'Quatity',
  'SerialNumber1',
  'SerialNumber2',
  'MacAddress',
  'CentroCusto',
  'DestinationWarehouse',
  'DestinationLocation',
  'ProjectCode',
  'Batch',
];

const TRFL_EMPTY_ROW = {
  Date: '',
  OriginWarehouse: '',
  OriginLocation: '',
  Article: '',
  Quatity: '',
  SerialNumber1: '',
  SerialNumber2: '',
  MacAddress: '',
  CentroCusto: '',
  DestinationWarehouse: '',
  DestinationLocation: '',
  ProjectCode: '',
  Batch: '',
};

/** Excel TRFL/TRA/DEV — colunas alinhadas ao modelo interno (Quatity mantido por compatibilidade). */
function buildExcelTransferencia(rows, res, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [TRFL_EMPTY_ROW], { header: TRFL_HEADERS });
  XLSX.utils.book_append_sheet(wb, ws, 'Dados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

module.exports = { buildExcelTransferencia, TRFL_HEADERS, TRFL_EMPTY_ROW };
