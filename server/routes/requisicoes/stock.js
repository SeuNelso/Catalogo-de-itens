const express = require('express');
const ExcelJS = require('exceljs');
const {
  parseImportStockRows,
  validateImportPreviewRows,
  commitImportStock,
} = require('../../services/stock/import');
const {
  cadastroManualStock,
  listMeusArmazensStock,
  listItensNacionalPorArmazem,
} = require('../../services/stock/consulta');

function createStockRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyNonAdmin,
    stockImportUpload,
    isAdmin,
    requisicaoArmazemOrigemAcessoPermitido,
  } = deps;
  const router = express.Router();

  router.get('/disponibilidade', ...requisicaoAuth, async (req, res) => {
    try {
      const itemId = Number(req.query.item_id || 0);
      const armazemId = Number(req.query.armazem_id || 0);
      const localizacao = String(req.query.localizacao || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!itemId || !armazemId) {
        return res.status(400).json({ error: 'item_id e armazem_id são obrigatórios' });
      }
      const locCmp = `UPPER(TRIM(BOTH FROM replace(COALESCE(localizacao::text, ''), chr(160), ' ')))`;
      const reqCmp = `UPPER(TRIM(BOTH FROM replace($3::text, chr(160), ' ')))`;
      const [serialQ, lotesQ] = await Promise.all([
        pool.query(
          `SELECT id, serialnumber, lote
           FROM stock_serial
           WHERE item_id = $1 AND armazem_id = $2
             AND (
               $3 = ''
               OR ${locCmp} = ${reqCmp}
             )
             AND status = 'disponivel'
           ORDER BY serialnumber`,
          [itemId, armazemId, localizacao]
        ),
        pool.query(
          `SELECT id, lote, quantidade_disponivel, quantidade_reservada
           FROM stock_lote
           WHERE item_id = $1 AND armazem_id = $2
             AND (
               $3 = ''
               OR ${locCmp} = ${reqCmp}
             )
           ORDER BY lote`,
          [itemId, armazemId, localizacao]
        ),
      ]);
      return res.json({
        seriais: serialQ.rows || [],
        lotes: lotesQ.rows || [],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao consultar disponibilidade' });
    }
  });

  router.get('/import/template', ...requisicaoAuth, denyNonAdmin, async (_req, res) => {
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('template_stock');
      sheet.columns = [
        { header: 'artigo_codigo', key: 'artigo_codigo', width: 18 },
        { header: 'serialnumber', key: 'serialnumber', width: 24 },
        { header: 'lote', key: 'lote', width: 18 },
        { header: 'quantidade', key: 'quantidade', width: 14 },
        { header: 'caixa_codigo', key: 'caixa_codigo', width: 18 },
        { header: 'localizacao', key: 'localizacao', width: 20 },
      ];
      sheet.addRow({
        artigo_codigo: '3000331',
        serialnumber: 'SN-0001',
        quantidade: 1,
        caixa_codigo: 'CX-000123',
        localizacao: 'A1.01',
      });
      sheet.addRow({
        artigo_codigo: '3000331',
        lote: 'LOTE-ABC-001',
        quantidade: 2005,
        caixa_codigo: 'CX-000123',
        localizacao: 'A1.01',
      });
      sheet.getRow(1).font = { bold: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="template_import_stock_rastreavel.xlsx"');
      await workbook.xlsx.write(res);
      res.end();
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao gerar template de importação' });
    }
  });

  router.post(
    '/import/preview',
    ...requisicaoAuth,
    denyNonAdmin,
    stockImportUpload.single('arquivo'),
    async (req, res) => {
      try {
        const selectedArmazemId = Number(req.body?.armazem_id || 0);
        if (!selectedArmazemId) {
          return res.status(400).json({ error: 'armazem_id é obrigatório para importar.' });
        }
        console.log(
          `[stock-import][preview] início user=${req.user?.id || 'na'} armazem=${selectedArmazemId} arquivo=${req.file?.originalname || 'sem-arquivo'}`
        );
        const rows = await parseImportStockRows(req);
        const errors = await validateImportPreviewRows(pool, rows, selectedArmazemId);
        const payload = {
          total_linhas: rows.length,
          validas: Math.max(0, rows.length - errors.length),
          invalidas: errors.length,
          rows,
          erros: errors.slice(0, 500),
        };
        console.log(
          `[stock-import][preview] fim armazem=${selectedArmazemId} total=${payload.total_linhas} validas=${payload.validas} invalidas=${payload.invalidas}`
        );
        return res.json(payload);
      } catch (e) {
        console.error('[stock-import][preview] erro:', e.message);
        return res.status(400).json({ error: e.message || 'Erro no preview da importação' });
      }
    }
  );

  router.post(
    '/import/commit',
    ...requisicaoAuth,
    denyNonAdmin,
    stockImportUpload.single('arquivo'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const selectedArmazemId = Number(req.body?.armazem_id || 0);
        if (!selectedArmazemId) {
          return res.status(400).json({ error: 'armazem_id é obrigatório para importar.' });
        }
        const isRetry = Array.isArray(req.body?.rows);
        console.log(
          `[stock-import][commit] início modo=${isRetry ? 'retry' : 'arquivo'} user=${req.user?.id || 'na'} armazem=${selectedArmazemId} arquivo=${req.file?.originalname || 'sem-arquivo'}`
        );
        const rows = await parseImportStockRows(req);
        await client.query('BEGIN');
        const { imported, skipped, errors } = await commitImportStock(client, {
          rows,
          selectedArmazemId,
          usuarioId: req.user?.id || null,
        });
        await client.query('COMMIT');
        console.log(
          `[stock-import][commit] fim armazem=${selectedArmazemId} total=${rows.length} importadas=${imported} ignoradas=${skipped} erros=${errors.length}`
        );
        return res.json({
          ok: true,
          total: rows.length,
          importadas: imported,
          ignoradas: skipped,
          erros: errors.slice(0, 500),
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[stock-import][commit] erro:', e.message);
        return res.status(500).json({ error: e.message || 'Erro ao importar stock rastreável' });
      } finally {
        client.release();
      }
    }
  );

  router.post('/serial/manual', ...requisicaoAuth, denyNonAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await cadastroManualStock(client, req.body, req.user?.id || null);
      await client.query('COMMIT');
      return res.json({ ok: true, row });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      return res.status(500).json({ error: e.message || 'Erro ao cadastrar serial manualmente' });
    } finally {
      client.release();
    }
  });

  router.get('/meus-armazens', ...requisicaoAuth, async (req, res) => {
    try {
      const rows = await listMeusArmazensStock(pool, req.user, { isAdminRole: isAdmin });
      return res.json({ rows });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Erro ao obter armazéns do utilizador' });
    }
  });

  router.get('/itens-nacional-por-armazem', ...requisicaoAuth, async (req, res) => {
    try {
      const armazemId = Number(req.query.armazem_id || 0);
      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      if (!armazemId) return res.status(400).json({ error: 'armazem_id é obrigatório' });
      if (!requisicaoArmazemOrigemAcessoPermitido(req, armazemId)) {
        return res.status(403).json({ error: 'Sem acesso ao armazém informado.' });
      }
      const payload = await listItensNacionalPorArmazem(pool, { armazemId, q, limit, offset });
      return res.json(payload);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      return res.status(500).json({ error: e.message || 'Erro ao consultar artigos por armazém.' });
    }
  });

  return router;
}

module.exports = { createStockRouter };
