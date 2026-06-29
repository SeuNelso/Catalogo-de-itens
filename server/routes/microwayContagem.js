const express = require('express');
const multer = require('multer');
const { isAdmin } = require('../utils/roles');
const {
  parseMwArtigosFromBuffer,
  agregarStockMicrowayFromMwFile,
  buildStockMwWorkbookBuffer,
} = require('../services/microway/contagemStock');

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

function denyNonAdmin(req, res, next) {
  if (!req.user || !isAdmin(req.user.role)) {
    return res.status(403).json({
      error: 'Apenas administradores podem executar esta operação.',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

function parseJsonField(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return fallback;
  }
}

function createMicrowayContagemRouter({ pool, authenticateToken }) {
  const router = express.Router();

  router.post(
    '/parse',
    authenticateToken,
    denyNonAdmin,
    uploadMw.single('arquivo'),
    async (req, res) => {
      try {
        if (!req.file?.buffer?.length) {
          return res.status(400).json({ error: 'Envie um ficheiro Excel (.xlsx) no campo "arquivo".' });
        }
        const ext = String(req.file.originalname || '').split('.').pop().toLowerCase();
        if (ext !== 'xlsx' && ext !== 'xls') {
          return res.status(400).json({ error: 'Formato inválido. Use ficheiro .xlsx ou .xls.' });
        }

        const artigos = await parseMwArtigosFromBuffer(req.file.buffer, pool);
        if (!artigos.length) {
          return res.status(400).json({
            error: 'Nenhum artigo encontrado. Verifique se o ficheiro segue o formato MW (colunas Item, Stock, Warehouse, Location).',
          });
        }

        const codigos = artigos.map((a) => a.codigo);
        const metaQ = await pool.query(
          `SELECT codigo, descricao FROM itens WHERE codigo = ANY($1::text[])`,
          [codigos]
        );
        const descBd = new Map(
          (metaQ.rows || []).map((r) => [String(r.codigo || '').trim().toUpperCase(), String(r.descricao || '').trim()])
        );

        const itens = artigos.map((a) => {
          const key = String(a.codigo).toUpperCase();
          return {
            codigo: a.codigo,
            descricao_mw: a.descricao_mw || '',
            descricao_bd: descBd.get(key) || '',
            descricao: descBd.get(key) || a.descricao_mw || '',
            stock_mw: Number(a.stock_mw) || 0,
            linhas_mw: Number(a.linhas_mw) || 0,
            no_catalogo: descBd.has(key),
          };
        });

        return res.json({
          total: itens.length,
          itens,
        });
      } catch (e) {
        console.error('Erro POST contagem-microway/parse:', e);
        return res.status(500).json({ error: 'Erro ao ler ficheiro MW', details: e.message });
      }
    }
  );

  router.post(
    '/gerar',
    authenticateToken,
    denyNonAdmin,
    uploadMw.single('arquivo'),
    async (req, res) => {
      try {
        if (!req.file?.buffer?.length) {
          return res.status(400).json({
            error: 'Envie novamente o ficheiro MW no campo "arquivo" ao gerar o STOCK MW.',
          });
        }

        const raw = parseJsonField(req.body?.codigos, []);
        if (!Array.isArray(raw) || raw.length === 0) {
          return res.status(400).json({ error: 'Envie "codigos": array não vazio com os artigos seleccionados.' });
        }
        const codigos = [...new Set(raw.map((c) => String(c || '').trim()).filter(Boolean))];
        if (!codigos.length) {
          return res.status(400).json({ error: 'Nenhum código de artigo válido.' });
        }

        const descMwByCodigo = new Map();
        const descricoesMw = parseJsonField(req.body?.descricoes_mw, {});
        if (descricoesMw && typeof descricoesMw === 'object') {
          for (const [cod, desc] of Object.entries(descricoesMw)) {
            const k = String(cod || '').trim().toUpperCase();
            if (!k) continue;
            descMwByCodigo.set(k, { descricao_mw: String(desc || '').trim() });
          }
        }

        const { centrais, linhas } = await agregarStockMicrowayFromMwFile(
          pool,
          req.file.buffer,
          codigos,
          descMwByCodigo
        );
        if (!centrais.length) {
          return res.status(400).json({
            error: 'Não existem armazéns centrais activos na base de dados.',
          });
        }

        const buffer = await buildStockMwWorkbookBuffer(linhas);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="STOCK MW ${stamp}.xlsx"`);
        return res.send(Buffer.from(buffer));
      } catch (e) {
        console.error('Erro POST contagem-microway/gerar:', e);
        return res.status(500).json({ error: 'Erro ao gerar STOCK MW', details: e.message });
      }
    }
  );

  return router;
}

module.exports = { createMicrowayContagemRouter };
