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

function usuarioIdFromReq(req) {
  const id = Number(req.user?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeCodigosList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    const cod = String(c || '').trim();
    if (!cod) continue;
    const key = cod.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cod);
  }
  return out;
}

function sanitizeDownloadFileName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return cleaned || 'Reporte';
}

async function fetchPerfilRow(pool, perfilId, usuarioId) {
  const r = await pool.query(
    `SELECT id, nome, descricao, created_at, updated_at
     FROM microway_contagem_perfis
     WHERE id = $1 AND usuario_id = $2`,
    [perfilId, usuarioId]
  );
  return r.rows[0] || null;
}

async function fetchPerfilCodigos(pool, perfilId) {
  const r = await pool.query(
    `SELECT codigo FROM microway_contagem_perfil_itens
     WHERE perfil_id = $1
     ORDER BY ordem ASC, codigo ASC`,
    [perfilId]
  );
  return (r.rows || []).map((row) => String(row.codigo || '').trim()).filter(Boolean);
}

async function fetchPerfilItensComDescricao(pool, perfilId) {
  const r = await pool.query(
    `SELECT pi.codigo,
            COALESCE(NULLIF(TRIM(i.descricao), ''), '') AS descricao,
            (i.id IS NOT NULL) AS no_catalogo
     FROM microway_contagem_perfil_itens pi
     LEFT JOIN itens i ON UPPER(TRIM(i.codigo)) = UPPER(TRIM(pi.codigo))
     WHERE pi.perfil_id = $1
     ORDER BY pi.ordem ASC, pi.codigo ASC`,
    [perfilId]
  );
  return (r.rows || []).map((row) => ({
    codigo: String(row.codigo || '').trim(),
    descricao: String(row.descricao || '').trim(),
    no_catalogo: row.no_catalogo === true,
  })).filter((row) => row.codigo);
}

async function resolverCodigosCatalogo(pool, codigos) {
  const list = normalizeCodigosList(codigos);
  if (!list.length) return [];

  const r = await pool.query(
    `SELECT codigo, descricao FROM itens WHERE UPPER(TRIM(codigo)) = ANY($1::text[])`,
    [list.map((c) => c.toUpperCase())]
  );
  const byCodigo = new Map(
    (r.rows || []).map((row) => [
      String(row.codigo || '').trim().toUpperCase(),
      {
        codigo: String(row.codigo || '').trim(),
        descricao: String(row.descricao || '').trim(),
        no_catalogo: true,
      },
    ])
  );

  return list.map((cod) => {
    const hit = byCodigo.get(cod.toUpperCase());
    if (hit) return hit;
    return { codigo: cod, descricao: '', no_catalogo: false };
  });
}

async function replacePerfilItens(client, perfilId, codigos) {
  await client.query('DELETE FROM microway_contagem_perfil_itens WHERE perfil_id = $1', [perfilId]);
  let ordem = 0;
  for (const codigo of codigos) {
    await client.query(
      `INSERT INTO microway_contagem_perfil_itens (perfil_id, codigo, ordem)
       VALUES ($1, $2, $3)`,
      [perfilId, codigo, ordem]
    );
    ordem += 1;
  }
  await client.query(
    'UPDATE microway_contagem_perfis SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [perfilId]
  );
}

function createMicrowayContagemRouter({ pool, authenticateToken }) {
  const router = express.Router();

  router.get('/perfis', authenticateToken, denyNonAdmin, async (req, res) => {
    try {
      const usuarioId = usuarioIdFromReq(req);
      if (!usuarioId) return res.status(401).json({ error: 'Utilizador não autenticado.' });

      const r = await pool.query(
        `SELECT p.id, p.nome, p.descricao, p.created_at, p.updated_at,
                COUNT(i.id)::int AS total_itens
         FROM microway_contagem_perfis p
         LEFT JOIN microway_contagem_perfil_itens i ON i.perfil_id = p.id
         WHERE p.usuario_id = $1
         GROUP BY p.id
         ORDER BY p.nome ASC`,
        [usuarioId]
      );
      return res.json({ perfis: r.rows || [] });
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Tabelas de perfis Microway não existem. Execute: npm run db:migrate:microway-contagem-perfis',
          code: 'MW_PERFIS_SCHEMA_MISSING',
        });
      }
      console.error('Erro GET contagem-microway/perfis:', e);
      return res.status(500).json({ error: 'Erro ao listar perfis', details: e.message });
    }
  });

  router.post('/perfis/resolver-codigos', authenticateToken, denyNonAdmin, async (req, res) => {
    try {
      const codigos = normalizeCodigosList(req.body?.codigos);
      if (!codigos.length) {
        return res.status(400).json({ error: 'Envie pelo menos um código ERP.' });
      }
      const itens = await resolverCodigosCatalogo(pool, codigos);
      return res.json({ itens });
    } catch (e) {
      console.error('Erro POST contagem-microway/perfis/resolver-codigos:', e);
      return res.status(500).json({ error: 'Erro ao resolver códigos', details: e.message });
    }
  });

  router.get('/perfis/:id', authenticateToken, denyNonAdmin, async (req, res) => {
    try {
      const usuarioId = usuarioIdFromReq(req);
      if (!usuarioId) return res.status(401).json({ error: 'Utilizador não autenticado.' });

      const perfilId = Number(req.params.id);
      if (!Number.isFinite(perfilId) || perfilId <= 0) {
        return res.status(400).json({ error: 'ID de perfil inválido.' });
      }

      const row = await fetchPerfilRow(pool, perfilId, usuarioId);
      if (!row) return res.status(404).json({ error: 'Perfil não encontrado.' });

      const itens = await fetchPerfilItensComDescricao(pool, perfilId);
      const codigos = itens.map((it) => it.codigo);
      return res.json({ ...row, codigos, itens });
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Tabelas de perfis Microway não existem. Execute: npm run db:migrate:microway-contagem-perfis',
          code: 'MW_PERFIS_SCHEMA_MISSING',
        });
      }
      console.error('Erro GET contagem-microway/perfis/:id:', e);
      return res.status(500).json({ error: 'Erro ao carregar perfil', details: e.message });
    }
  });

  router.post('/perfis', authenticateToken, denyNonAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const usuarioId = usuarioIdFromReq(req);
      if (!usuarioId) return res.status(401).json({ error: 'Utilizador não autenticado.' });

      const nome = String(req.body?.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'O nome do perfil é obrigatório.' });
      if (nome.length > 120) return res.status(400).json({ error: 'O nome do perfil não pode exceder 120 caracteres.' });

      const codigos = normalizeCodigosList(req.body?.codigos);
      if (!codigos.length) {
        return res.status(400).json({ error: 'Seleccione pelo menos um artigo para guardar no perfil.' });
      }

      const descricao = req.body?.descricao != null ? String(req.body.descricao).trim() : null;

      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO microway_contagem_perfis (usuario_id, nome, descricao)
         VALUES ($1, $2, $3)
         RETURNING id, nome, descricao, created_at, updated_at`,
        [usuarioId, nome, descricao || null]
      );
      const perfil = ins.rows[0];
      await replacePerfilItens(client, perfil.id, codigos);
      await client.query('COMMIT');

      return res.status(201).json({
        ...perfil,
        total_itens: codigos.length,
        codigos,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Já existe um perfil com este nome.' });
      }
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Tabelas de perfis Microway não existem. Execute: npm run db:migrate:microway-contagem-perfis',
          code: 'MW_PERFIS_SCHEMA_MISSING',
        });
      }
      console.error('Erro POST contagem-microway/perfis:', e);
      return res.status(500).json({ error: 'Erro ao criar perfil', details: e.message });
    } finally {
      client.release();
    }
  });

  router.put('/perfis/:id', authenticateToken, denyNonAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const usuarioId = usuarioIdFromReq(req);
      if (!usuarioId) return res.status(401).json({ error: 'Utilizador não autenticado.' });

      const perfilId = Number(req.params.id);
      if (!Number.isFinite(perfilId) || perfilId <= 0) {
        return res.status(400).json({ error: 'ID de perfil inválido.' });
      }

      const existing = await fetchPerfilRow(pool, perfilId, usuarioId);
      if (!existing) return res.status(404).json({ error: 'Perfil não encontrado.' });

      const nome = req.body?.nome != null ? String(req.body.nome).trim() : existing.nome;
      if (!nome) return res.status(400).json({ error: 'O nome do perfil é obrigatório.' });

      const codigos = req.body?.codigos != null
        ? normalizeCodigosList(req.body.codigos)
        : await fetchPerfilCodigos(pool, perfilId);
      if (!codigos.length) {
        return res.status(400).json({ error: 'O perfil deve ter pelo menos um artigo.' });
      }

      const descricao = req.body?.descricao != null
        ? (String(req.body.descricao).trim() || null)
        : existing.descricao;

      await client.query('BEGIN');
      await client.query(
        `UPDATE microway_contagem_perfis
         SET nome = $1, descricao = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND usuario_id = $4`,
        [nome, descricao, perfilId, usuarioId]
      );
      await replacePerfilItens(client, perfilId, codigos);
      await client.query('COMMIT');

      return res.json({
        id: perfilId,
        nome,
        descricao,
        total_itens: codigos.length,
        codigos,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Já existe um perfil com este nome.' });
      }
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Tabelas de perfis Microway não existem. Execute: npm run db:migrate:microway-contagem-perfis',
          code: 'MW_PERFIS_SCHEMA_MISSING',
        });
      }
      console.error('Erro PUT contagem-microway/perfis/:id:', e);
      return res.status(500).json({ error: 'Erro ao actualizar perfil', details: e.message });
    } finally {
      client.release();
    }
  });

  router.delete('/perfis/:id', authenticateToken, denyNonAdmin, async (req, res) => {
    try {
      const usuarioId = usuarioIdFromReq(req);
      if (!usuarioId) return res.status(401).json({ error: 'Utilizador não autenticado.' });

      const perfilId = Number(req.params.id);
      if (!Number.isFinite(perfilId) || perfilId <= 0) {
        return res.status(400).json({ error: 'ID de perfil inválido.' });
      }

      const del = await pool.query(
        'DELETE FROM microway_contagem_perfis WHERE id = $1 AND usuario_id = $2 RETURNING id',
        [perfilId, usuarioId]
      );
      if (!del.rows.length) return res.status(404).json({ error: 'Perfil não encontrado.' });
      return res.json({ ok: true, id: perfilId });
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Tabelas de perfis Microway não existem. Execute: npm run db:migrate:microway-contagem-perfis',
          code: 'MW_PERFIS_SCHEMA_MISSING',
        });
      }
      console.error('Erro DELETE contagem-microway/perfis/:id:', e);
      return res.status(500).json({ error: 'Erro ao apagar perfil', details: e.message });
    }
  });

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
            error: 'Envie novamente o ficheiro MW no campo "arquivo" ao gerar o reporte.',
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
        if (!linhas.length) {
          return res.status(400).json({
            error: 'Não foi possível gerar linhas do reporte. Verifique o ficheiro MW e os artigos seleccionados.',
          });
        }

        const stamp = new Date().toISOString().slice(0, 10);
        const nomeFicheiro = sanitizeDownloadFileName(req.body?.nome_ficheiro) || `Reporte ${stamp}`;
        const buffer = await buildStockMwWorkbookBuffer(linhas);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${nomeFicheiro}.xlsx"`);
        return res.send(Buffer.from(buffer));
      } catch (e) {
        console.error('Erro POST contagem-microway/gerar:', e);
        return res.status(500).json({ error: 'Erro ao gerar reporte', details: e.message });
      }
    }
  );

  return router;
}

module.exports = { createMicrowayContagemRouter };
