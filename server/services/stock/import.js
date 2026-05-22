const fs = require('fs');
const XLSX = require('xlsx');
const { STOCK_STATUS } = require('./loteStatus');
const { localizacaoExisteNoArmazem } = require('./consulta');
const { logStockMovimento } = require('./auditoria');

function normalizeImportHeader(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function parseRowsFromWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function mapRawRowToImportRow(row, idx, { selectedArmazemId, selectedArmazemCodigo }) {
  const norm = {};
  for (const [k, v] of Object.entries(row || {})) norm[normalizeImportHeader(k)] = v;
  const artigoCodigo = String(
    norm.artigo_codigo ||
      norm['codigo do artigo'] ||
      norm['codigo artigo'] ||
      norm.codigo ||
      norm.artigo ||
      ''
  ).trim();
  const itemId = Number(norm.item_id || norm['item id'] || 0) || null;
  const serialOrLote = String(
    norm['serial number ou lote'] ||
      norm['serial ou lote'] ||
      norm['serial/lote'] ||
      norm['serial number'] ||
      ''
  ).trim();
  const serialnumber = String(
    norm.serialnumber || norm.serial || norm['s/n'] || serialOrLote || ''
  ).trim();
  const lote = String(norm.lote || (serialnumber ? '' : serialOrLote) || '').trim();
  const localizacao = String(
    norm.localizacao ||
      norm['localizacao de origem'] ||
      norm['localizacao origem'] ||
      norm['local de armazenagem'] ||
      ''
  ).trim();
  const caixaCodigo = String(
    norm.caixa_codigo || norm['codigo da caixa'] || norm['codigo caixa'] || norm.caixa || ''
  ).trim();
  const quantidade = Number(norm.quantidade || norm.metragem || norm.metros || 0) || 0;
  return {
    linha: idx + 2,
    artigoCodigo,
    itemId,
    serialnumber,
    lote,
    quantidade,
    armazemCodigo:
      String(norm.armazem_codigo || norm.armazem || '').trim() || selectedArmazemCodigo,
    armazemId: Number(norm.armazem_id || 0) || selectedArmazemId,
    localizacao,
    caixaCodigo,
  };
}

function mapWorkbookRows(rows, options) {
  return rows
    .map((row, idx) => mapRawRowToImportRow(row, idx, options))
    .filter((r) => r.serialnumber || r.lote || r.itemId || r.artigoCodigo);
}

async function parseImportStockRows(req) {
  const selectedArmazemId = Number(req.body?.armazem_id || 0) || null;
  const selectedArmazemCodigo = String(req.body?.armazem_codigo || '').trim();
  if (Array.isArray(req.body?.rows)) {
    return req.body.rows.map((r, idx) => ({
      linha: Number(r.linha || idx + 1),
      artigoCodigo: String(r.artigoCodigo || '').trim(),
      itemId: Number(r.itemId || 0) || null,
      serialnumber: String(r.serialnumber || '').trim(),
      lote: String(r.lote || '').trim(),
      quantidade: Number(r.quantidade || 0) || 0,
      armazemCodigo: String(r.armazemCodigo || '').trim() || selectedArmazemCodigo,
      armazemId: Number(r.armazemId || 0) || selectedArmazemId,
      localizacao: String(r.localizacao || '').trim(),
      caixaCodigo: String(r.caixaCodigo || '').trim(),
    }));
  }
  if (!req.file) {
    throw new Error('Arquivo é obrigatório.');
  }
  const fileBuffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
  if (!fileBuffer) throw new Error('Não foi possível ler o arquivo enviado.');
  const rows = parseRowsFromWorkbookBuffer(fileBuffer);
  return mapWorkbookRows(rows, { selectedArmazemId, selectedArmazemCodigo });
}

async function validateImportPreviewRows(pool, rows, selectedArmazemId) {
  const errors = [];
  const seenSerial = new Set();
  const locExistsCache = new Map();
  for (const r of rows) {
    const rowArmazemId = Number(r.armazemId || selectedArmazemId || 0) || 0;
    if (!r.localizacao) errors.push({ linha: r.linha, erro: 'Localização obrigatória' });
    if (!r.itemId && !r.artigoCodigo) {
      errors.push({ linha: r.linha, erro: 'item_id ou artigo_codigo obrigatório' });
    }
    if (!r.serialnumber && !r.lote) {
      errors.push({ linha: r.linha, erro: 'serialnumber ou lote obrigatório' });
    }
    if (rowArmazemId && r.localizacao) {
      const key = `${rowArmazemId}::${String(r.localizacao || '').trim().toUpperCase()}`;
      let exists = locExistsCache.get(key);
      if (typeof exists === 'undefined') {
        // eslint-disable-next-line no-await-in-loop
        exists = await localizacaoExisteNoArmazem(pool, {
          armazemId: rowArmazemId,
          localizacao: r.localizacao,
        });
        locExistsCache.set(key, exists);
      }
      if (!exists) {
        errors.push({
          linha: r.linha,
          erro: `Localização "${r.localizacao}" não existe no armazém ${rowArmazemId}`,
        });
      }
    }
    if (r.lote && (!Number.isFinite(Number(r.quantidade)) || Number(r.quantidade) <= 0)) {
      errors.push({ linha: r.linha, erro: 'quantidade obrigatória e > 0 para lote' });
    }
    if (r.serialnumber) {
      const k = `${r.itemId || r.artigoCodigo}::${r.serialnumber}`;
      if (seenSerial.has(k)) errors.push({ linha: r.linha, erro: 'Serial duplicado no arquivo' });
      seenSerial.add(k);
    }
  }
  return errors;
}

async function commitImportStock(client, { rows, selectedArmazemId, usuarioId }) {
  const codigosArtigo = [...new Set(rows.map((r) => String(r.artigoCodigo || '').trim()).filter(Boolean))];
  const itensMap = new Map();
  if (codigosArtigo.length > 0) {
    const itensQ = await client.query('SELECT id, codigo FROM itens WHERE codigo = ANY($1::text[])', [
      codigosArtigo,
    ]);
    for (const row of itensQ.rows || []) itensMap.set(String(row.codigo), Number(row.id));
  }
  let imported = 0;
  let skipped = 0;
  const errors = [];
  const locExistsCache = new Map();
  for (let idx = 0; idx < rows.length; idx += 1) {
    const r = rows[idx];
    try {
      const itemId = r.itemId || itensMap.get(String(r.artigoCodigo || '').trim()) || null;
      const armazemId = r.armazemId || selectedArmazemId || null;
      if (!itemId || !armazemId || !r.localizacao) {
        skipped += 1;
        errors.push({ linha: r.linha, erro: 'Referências inválidas (item/armazém/localização)' });
        continue;
      }
      const locKey = `${armazemId}::${String(r.localizacao || '').trim().toUpperCase()}`;
      let locExists = locExistsCache.get(locKey);
      if (typeof locExists === 'undefined') {
        // eslint-disable-next-line no-await-in-loop
        locExists = await localizacaoExisteNoArmazem(client, {
          armazemId,
          localizacao: r.localizacao,
        });
        locExistsCache.set(locKey, locExists);
      }
      if (!locExists) {
        skipped += 1;
        errors.push({
          linha: r.linha,
          erro: `Localização "${r.localizacao}" não existe no armazém ${armazemId}`,
        });
        continue;
      }
      if (r.serialnumber) {
        await client.query(
          `INSERT INTO stock_serial (item_id, armazem_id, localizacao, serialnumber, lote, status)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (item_id, serialnumber)
           DO UPDATE SET armazem_id = EXCLUDED.armazem_id, localizacao = EXCLUDED.localizacao, lote = COALESCE(NULLIF(EXCLUDED.lote,''), stock_serial.lote), atualizado_em = CURRENT_TIMESTAMP`,
          [itemId, armazemId, r.localizacao, r.serialnumber, r.lote || null, STOCK_STATUS.DISPONIVEL]
        );
        if (r.caixaCodigo) {
          const caixa = await client.query(
            `INSERT INTO stock_caixas (codigo_caixa, item_id, armazem_id, localizacao, status, criado_por_usuario_id)
             VALUES ($1,$2,$3,$4,'fechada',$5)
             ON CONFLICT (codigo_caixa)
             DO UPDATE SET item_id = EXCLUDED.item_id, armazem_id = EXCLUDED.armazem_id, localizacao = EXCLUDED.localizacao, atualizado_em = CURRENT_TIMESTAMP
             RETURNING id`,
            [r.caixaCodigo, itemId, armazemId, r.localizacao, usuarioId || null]
          );
          const serial = await client.query(
            'SELECT id FROM stock_serial WHERE item_id = $1 AND serialnumber = $2',
            [itemId, r.serialnumber]
          );
          await client.query(
            `INSERT INTO stock_caixa_seriais (caixa_id, stock_serial_id)
             VALUES ($1,$2)
             ON CONFLICT (stock_serial_id) DO NOTHING`,
            [caixa.rows[0].id, serial.rows[0].id]
          );
        }
        imported += 1;
        await logStockMovimento({
          db: client,
          tipo: 'import_serial',
          itemId,
          armazemId,
          localizacao: r.localizacao,
          lote: r.lote || null,
          serialnumber: r.serialnumber,
          quantidade: 1,
          usuarioId: usuarioId || null,
          payload: { linha: r.linha, caixa: r.caixaCodigo || null },
        });
      } else if (r.lote) {
        const quantidadeLote = Number(r.quantidade || 0);
        if (!Number.isFinite(quantidadeLote) || quantidadeLote <= 0) {
          skipped += 1;
          errors.push({ linha: r.linha, erro: 'quantidade obrigatória e > 0 para lote' });
          continue;
        }
        await client.query(
          `INSERT INTO stock_lote (item_id, armazem_id, localizacao, lote, quantidade_disponivel)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (item_id, armazem_id, localizacao, lote)
           DO UPDATE SET quantidade_disponivel = stock_lote.quantidade_disponivel + EXCLUDED.quantidade_disponivel, atualizado_em = CURRENT_TIMESTAMP`,
          [itemId, armazemId, r.localizacao, r.lote, quantidadeLote]
        );
        imported += 1;
        await logStockMovimento({
          db: client,
          tipo: 'import_lote',
          itemId,
          armazemId,
          localizacao: r.localizacao,
          lote: r.lote,
          quantidade: quantidadeLote,
          usuarioId: usuarioId || null,
          payload: { linha: r.linha },
        });
      }
    } catch (innerErr) {
      skipped += 1;
      errors.push({ linha: r.linha, erro: innerErr.message });
    }
    const processadas = idx + 1;
    if (processadas % 100 === 0 || processadas === rows.length) {
      console.log(
        `[stock-import][commit] progresso armazem=${selectedArmazemId} processadas=${processadas}/${rows.length} importadas=${imported} ignoradas=${skipped}`
      );
    }
  }
  return { imported, skipped, errors };
}

module.exports = {
  normalizeImportHeader,
  parseRowsFromWorkbookBuffer,
  mapRawRowToImportRow,
  mapWorkbookRows,
  parseImportStockRows,
  validateImportPreviewRows,
  commitImportStock,
};
