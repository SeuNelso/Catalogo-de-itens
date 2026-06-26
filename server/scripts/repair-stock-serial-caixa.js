/**
 * Repara vínculos stock_serial → stock_caixas a partir de requisicoes_itens_seriais.codigo_caixa
 * e remove duplicados em stock_serial cujo serialnumber inclui caixa (tab/espaço).
 *
 * Uso:
 *   node server/scripts/repair-stock-serial-caixa.js           # aplica reparo
 *   node server/scripts/repair-stock-serial-caixa.js --dry-run # só relatório
 *   npm run db:repair:stock-serial-caixa
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool, getConnectionTargetInfo } = require('../db/pool');

const dryRun = process.argv.includes('--dry-run');

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

function caixaPorSerialFromBlob(blob) {
  const m = new Map();
  for (const line of String(blob || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const { sn, caixa } = serialLimpoDeLinhaComCaixa(line);
    if (sn && caixa) m.set(sn.toUpperCase(), caixa);
  }
  return m;
}

async function columnExists(client, table, column) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function tableExists(client, table) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [table]
  );
  return r.rows.length > 0;
}

async function vincularSerialACaixa(client, {
  stockSerialId,
  itemId,
  armazemId,
  localizacao,
  codigoCaixa,
}) {
  const cx = String(codigoCaixa || '').trim();
  if (!cx || !stockSerialId) return null;

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
}

async function removerDuplicadosSerialSujo(client) {
  const allQ = await client.query(
    `SELECT id, item_id, armazem_id, localizacao, serialnumber, status
     FROM stock_serial
     ORDER BY item_id, id`
  );
  const byItemSn = new Map();
  for (const row of allQ.rows || []) {
    const snKey = String(row.serialnumber || '').trim().toUpperCase();
    const k = `${row.item_id}::${snKey}`;
    if (!byItemSn.has(k)) byItemSn.set(k, []);
    byItemSn.get(k).push(row);
  }

  let removed = 0;
  for (const row of allQ.rows || []) {
    const raw = String(row.serialnumber || '').trim();
    const { sn, caixa } = serialLimpoDeLinhaComCaixa(raw);
    if (!sn || sn.toUpperCase() === raw.toUpperCase()) continue;

    const cleanKey = `${row.item_id}::${sn.toUpperCase()}`;
    const siblings = byItemSn.get(cleanKey) || [];
    const cleanRow = siblings.find((r) => String(r.serialnumber || '').trim().toUpperCase() === sn.toUpperCase());
    if (!cleanRow || cleanRow.id === row.id) continue;

    console.log(
      `[duplicado] item=${row.item_id} sujo="${raw}" → manter="${cleanRow.serialnumber}"` +
        (caixa ? ` caixa=${caixa}` : '')
    );

    if (!dryRun) {
      if (caixa) {
        const linkQ = await client.query(
          `SELECT c.codigo_caixa
           FROM stock_caixa_seriais cs
           INNER JOIN stock_caixas c ON c.id = cs.caixa_id
           WHERE cs.stock_serial_id = $1
           LIMIT 1`,
          [cleanRow.id]
        );
        const jaTem = String(linkQ.rows[0]?.codigo_caixa || '').trim();
        if (!jaTem) {
          await vincularSerialACaixa(client, {
            stockSerialId: cleanRow.id,
            itemId: cleanRow.item_id,
            armazemId: cleanRow.armazem_id,
            localizacao: cleanRow.localizacao,
            codigoCaixa: caixa,
          });
        }
      }
      await client.query('DELETE FROM stock_serial WHERE id = $1', [row.id]);
    }
    removed += 1;
  }
  return removed;
}

async function carregarMapaCaixaPorItemSerial(client, hasCodigoCaixaCol) {
  const map = new Map();

  if (hasCodigoCaixaCol) {
    const q = await client.query(
      `SELECT ri.item_id,
              UPPER(TRIM(ris.serialnumber)) AS sn_key,
              TRIM(ris.codigo_caixa) AS codigo_caixa
       FROM requisicoes_itens_seriais ris
       INNER JOIN requisicoes_itens ri ON ri.id = ris.requisicao_item_id
       WHERE NULLIF(TRIM(ris.codigo_caixa), '') IS NOT NULL
         AND NULLIF(TRIM(ris.serialnumber), '') IS NOT NULL
       ORDER BY ris.id DESC`
    );
    for (const row of q.rows || []) {
      const k = `${row.item_id}::${row.sn_key}`;
      if (!map.has(k)) map.set(k, row.codigo_caixa);
    }
  }

  const blobQ = await client.query(
    `SELECT item_id, serialnumber
     FROM requisicoes_itens
     WHERE serialnumber IS NOT NULL AND TRIM(serialnumber) <> ''`
  );
  for (const row of blobQ.rows || []) {
    const bySn = caixaPorSerialFromBlob(row.serialnumber);
    for (const [snKey, cx] of bySn.entries()) {
      const k = `${row.item_id}::${snKey}`;
      if (!map.has(k)) map.set(k, cx);
    }
  }

  return map;
}

async function vincularCaixasEmFalta(client, mapaCaixa) {
  const semCaixaQ = await client.query(
    `SELECT ss.id, ss.item_id, ss.armazem_id, ss.localizacao, ss.serialnumber
     FROM stock_serial ss
     LEFT JOIN stock_caixa_seriais cs ON cs.stock_serial_id = ss.id
     WHERE cs.id IS NULL
     ORDER BY ss.id`
  );

  let linked = 0;
  let skipped = 0;

  for (const row of semCaixaQ.rows || []) {
    const snKey = String(row.serialnumber || '').trim().toUpperCase();
    const k = `${row.item_id}::${snKey}`;
    let codigoCaixa = mapaCaixa.get(k) || '';

    if (!codigoCaixa) {
      const parsed = serialLimpoDeLinhaComCaixa(row.serialnumber);
      if (parsed.caixa && parsed.sn.toUpperCase() === snKey) {
        codigoCaixa = parsed.caixa;
      }
    }

    if (!codigoCaixa) {
      skipped += 1;
      continue;
    }

    console.log(
      `[vínculo] serial=${row.serialnumber} item=${row.item_id} loc=${row.localizacao} caixa=${codigoCaixa}`
    );

    if (!dryRun) {
      await vincularSerialACaixa(client, {
        stockSerialId: row.id,
        itemId: row.item_id,
        armazemId: row.armazem_id,
        localizacao: row.localizacao,
        codigoCaixa,
      });
    }
    linked += 1;
  }

  return { linked, skipped };
}

async function run() {
  const t = getConnectionTargetInfo();
  console.log(
    `[REPAIR] ${dryRun ? '(dry-run) ' : ''}host=${t.host} db=${t.database}`
  );

  const client = await pool.connect();
  try {
    if (!(await tableExists(client, 'stock_serial'))) {
      console.log('Tabela stock_serial inexistente — nada a reparar.');
      return;
    }
    if (!(await tableExists(client, 'stock_caixas'))) {
      console.log('Tabela stock_caixas inexistente — nada a reparar.');
      return;
    }

    const hasRis = await tableExists(client, 'requisicoes_itens_seriais');
    const hasCodigoCaixaCol = hasRis && (await columnExists(client, 'requisicoes_itens_seriais', 'codigo_caixa'));
    if (!hasCodigoCaixaCol) {
      console.log('AVISO: coluna requisicoes_itens_seriais.codigo_caixa ausente; usa só blob de requisicoes_itens.');
    }

    await client.query('BEGIN');

    const dupRemoved = await removerDuplicadosSerialSujo(client);
    const mapaCaixa = await carregarMapaCaixaPorItemSerial(client, hasCodigoCaixaCol);
    console.log(`Mapa caixa→serial: ${mapaCaixa.size} entradas`);

    const { linked, skipped } = await vincularCaixasEmFalta(client, mapaCaixa);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Dry-run concluído (nenhuma alteração gravada).');
    } else {
      await client.query('COMMIT');
      console.log('Reparo concluído.');
    }

    console.log(`Duplicados removidos: ${dupRemoved}`);
    console.log(`Vínculos criados/atualizados: ${linked}`);
    console.log(`Seriais sem caixa conhecida: ${skipped}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro no reparo:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
