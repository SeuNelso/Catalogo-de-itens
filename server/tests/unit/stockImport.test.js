const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeImportHeader,
  mapRawRowToImportRow,
  mapWorkbookRows,
} = require('../../services/stock/import');

describe('stock import parsing', () => {
  it('normalizeImportHeader remove acentos', () => {
    assert.equal(normalizeImportHeader('Localização'), 'localizacao');
  });

  it('mapRawRowToImportRow lê serial e localização', () => {
    const row = mapRawRowToImportRow(
      {
        artigo_codigo: 'ABC',
        serialnumber: 'SN-1',
        localizacao: 'A1',
        quantidade: 1,
      },
      0,
      { selectedArmazemId: 5, selectedArmazemCodigo: 'WH01' }
    );
    assert.equal(row.artigoCodigo, 'ABC');
    assert.equal(row.serialnumber, 'SN-1');
    assert.equal(row.armazemId, 5);
    assert.equal(row.linha, 2);
  });

  it('mapWorkbookRows filtra linhas vazias', () => {
    const rows = mapWorkbookRows(
      [{ lote: 'L1', quantidade: 10, localizacao: 'B2', artigo_codigo: 'X' }, {}],
      { selectedArmazemId: 1, selectedArmazemCodigo: '' }
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lote, 'L1');
  });
});
