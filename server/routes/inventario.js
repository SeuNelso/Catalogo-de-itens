const express = require('express');
const { isAdmin } = require('../utils/roles');

const INVENTARIO_ROLES = new Set(['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador']);
const ROLES_CRIAR_JUSTIFICAR = new Set(['admin', 'backoffice_armazem']);
const ROLES_CONTAR = new Set(['admin', 'operador']);
const ROLES_DECIDIR_APLICAR = new Set(['admin', 'supervisor_armazem']);
const ROLES_GERIR_CONTAGEM_SEMANAL = new Set(['admin', 'backoffice_armazem', 'supervisor_armazem']);

function canAccessInventario(role) {
  return INVENTARIO_ROLES.has(String(role || '').trim());
}

function canCriarJustificar(role) {
  return ROLES_CRIAR_JUSTIFICAR.has(String(role || '').trim());
}

function canContar(role) {
  return ROLES_CONTAR.has(String(role || '').trim());
}

function canDecidirAplicar(role) {
  return ROLES_DECIDIR_APLICAR.has(String(role || '').trim());
}

function canGerirContagemSemanal(role) {
  return ROLES_GERIR_CONTAGEM_SEMANAL.has(String(role || '').trim());
}

async function ensureContagemSemanalSchema(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS inventario_contagem_semanal_tarefas (
      id BIGSERIAL PRIMARY KEY,
      armazem_id INTEGER NOT NULL REFERENCES armazens(id),
      atribuido_para_user_id INTEGER NOT NULL REFERENCES usuarios(id),
      criado_por_user_id INTEGER NOT NULL REFERENCES usuarios(id),
      status TEXT NOT NULL DEFAULT 'ABERTA',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS inventario_contagem_semanal_linhas (
      id BIGSERIAL PRIMARY KEY,
      tarefa_id BIGINT NOT NULL REFERENCES inventario_contagem_semanal_tarefas(id) ON DELETE CASCADE,
      artigo TEXT NOT NULL,
      descricao TEXT NULL,
      qtd NUMERIC(18, 4) NOT NULL DEFAULT 0,
      qtd_ape NUMERIC(18, 4) NOT NULL DEFAULT 0,
      total NUMERIC(18, 4) NOT NULL DEFAULT 0,
      quantidade_sistema NUMERIC(18, 4) NOT NULL DEFAULT 0,
      diferenca NUMERIC(18, 4) NOT NULL DEFAULT 0,
      atualizado_por_user_id INTEGER NULL REFERENCES usuarios(id),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_tarefa_updated
     ON inventario_contagem_semanal_tarefas(updated_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_tarefa_user
     ON inventario_contagem_semanal_tarefas(atribuido_para_user_id, criado_por_user_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_linhas_tarefa
     ON inventario_contagem_semanal_linhas(tarefa_id)`
  );
}

function createInventarioRouter(deps = {}) {
  const router = express.Router();
  const { pool, requisicaoAuth } = deps;
  if (!pool || !requisicaoAuth) {
    throw new Error('createInventarioRouter: deps.pool e deps.requisicaoAuth são obrigatórios.');
  }

  router.use(...requisicaoAuth);

  router.use((req, res, next) => {
    const isContagemSemanalRoute = String(req.path || '').startsWith('/contagem-semanal');
    if (isContagemSemanalRoute) {
      // As permissões específicas da contagem semanal são validadas endpoint a endpoint
      // (ex.: criar tarefa, listar apenas tarefas atribuídas/criadas, editar linha).
      return next();
    }
    const isAdminUser = isAdmin(req.user?.role);
    if (
      !canAccessInventario(req.user?.role) ||
      (!isAdminUser && req.user?.pode_controlo_stock !== true)
    ) {
      return res.status(403).json({ error: 'Sem acesso ao módulo de inventário.' });
    }
    return next();
  });

  const allowedArmazensClause = (req, params, startIndex) => {
    if (isAdmin(req.user?.role)) return '';
    const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
    if (!allowed.length) return ' AND 1 = 0 ';
    params.push(allowed);
    return ` AND a.id = ANY($${startIndex}::int[]) `;
  };

  router.get('/armazens', async (req, res) => {
    try {
      const params = [];
      let idx = 1;
      const scopeSql = allowedArmazensClause(req, params, idx);
      if (scopeSql.includes(`$${idx}`)) idx += 1;
      const q = await pool.query(
        `SELECT a.id, a.codigo, a.descricao,
                COALESCE(
                  (
                    SELECT json_agg(json_build_object('id', al.id, 'localizacao', al.localizacao, 'tipo_localizacao', al.tipo_localizacao) ORDER BY al.id)
                    FROM armazens_localizacoes al
                    WHERE al.armazem_id = a.id
                  ),
                  '[]'::json
                ) AS localizacoes
         FROM armazens a
         WHERE LOWER(TRIM(COALESCE(a.tipo, ''))) = 'central'
           ${scopeSql}
         ORDER BY a.codigo, a.descricao`,
        params
      );
      return res.json(q.rows || []);
    } catch (e) {
      console.error('Erro ao listar armazéns inventário:', e);
      return res.status(500).json({ error: 'Erro ao listar armazéns', details: e.message });
    }
  });

  router.get('/itens', async (req, res) => {
    try {
      const armazemId = Number(req.query.armazem_id);
      const localizacaoId = Number(req.query.localizacao_id);
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!Number.isFinite(armazemId) || !Number.isFinite(localizacaoId)) {
        return res.status(400).json({ error: 'armazem_id e localizacao_id são obrigatórios.' });
      }
      if (!isAdmin(req.user?.role)) {
        const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
        if (!allowed.includes(armazemId)) return res.status(403).json({ error: 'Sem acesso a este armazém.' });
      }
      const params = [armazemId, localizacaoId];
      let whereQ = '';
      if (q) {
        params.push(`%${q}%`, `%${q}%`);
        whereQ = ` AND (LOWER(i.codigo) LIKE $3 OR LOWER(i.descricao) LIKE $4) `;
      }
      const itens = await pool.query(
        `SELECT i.id AS item_id, i.codigo, i.descricao, ali.quantidade::numeric AS quantidade_sistema
         FROM armazens_localizacao_item ali
         INNER JOIN itens i ON i.id = ali.item_id
         INNER JOIN armazens_localizacoes al ON al.id = ali.localizacao_id
         WHERE al.armazem_id = $1
           AND al.id = $2
           ${whereQ}
         ORDER BY i.codigo
         LIMIT 80`,
        params
      );
      return res.json(itens.rows || []);
    } catch (e) {
      console.error('Erro ao listar itens inventário:', e);
      return res.status(500).json({ error: 'Erro ao listar itens', details: e.message });
    }
  });

  // Preview provisório para "Contagem Semanal":
  // recebe linhas importadas e devolve stock agregado do armazém por artigo.
  router.post('/contagem-semanal/preview', async (req, res) => {
    try {
      const armazemId = Number(req.body?.armazem_id);
      const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!Number.isFinite(armazemId)) {
        return res.status(400).json({ error: 'armazem_id é obrigatório.' });
      }
      if (!isAdmin(req.user?.role)) {
        const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
        if (!allowed.includes(armazemId)) return res.status(403).json({ error: 'Sem acesso a este armazém.' });
      }

      const cleaned = rowsIn
        .map((r, idx) => ({
          idx,
          artigo: String(r?.artigo || r?.Artigo || '').trim(),
          descricao: String(r?.descricao || r?.Descricao || r?.DESCRICAO || '').trim(),
          qtd: Number(r?.qtd ?? r?.QTD ?? 0) || 0,
          qtd_ape: Number(r?.qtd_ape ?? r?.['QTD APE'] ?? r?.qtdApe ?? 0) || 0,
        }))
        .filter((r) => r.artigo);
      if (!cleaned.length) return res.json([]);

      const codigos = [...new Set(cleaned.map((r) => r.artigo))];
      const q = await pool.query(
        `SELECT
           i.codigo,
           i.descricao,
           COALESCE(SUM(ali.quantidade), 0)::numeric AS quantidade_sistema
         FROM itens i
         LEFT JOIN armazens_localizacao_item ali ON ali.item_id = i.id
         LEFT JOIN armazens_localizacoes al
           ON al.id = ali.localizacao_id
          AND al.armazem_id = $1
         WHERE i.codigo = ANY($2::text[])
         GROUP BY i.codigo, i.descricao`,
        [armazemId, codigos]
      );
      const byCodigo = new Map(
        (q.rows || []).map((x) => [String(x.codigo || '').trim(), {
          descricao: String(x.descricao || '').trim(),
          quantidade_sistema: Number(x.quantidade_sistema || 0),
        }])
      );

      const out = cleaned.map((r) => {
        const hit = byCodigo.get(r.artigo);
        const qtdSistema = Number(hit?.quantidade_sistema || 0);
        const total = Number(r.qtd || 0) + Number(r.qtd_ape || 0);
        return {
          artigo: r.artigo,
          descricao: r.descricao || String(hit?.descricao || ''),
          qtd: Number(r.qtd || 0),
          qtd_ape: Number(r.qtd_ape || 0),
          total,
          quantidade_sistema: qtdSistema,
          diferenca: total - qtdSistema,
          encontrado: Boolean(hit),
        };
      });
      return res.json(out);
    } catch (e) {
      console.error('Erro no preview de contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao gerar preview da contagem semanal', details: e.message });
    }
  });

  router.get('/contagem-semanal/armazens', async (req, res) => {
    try {
      const params = [];
      let idx = 1;
      const scopeSql = allowedArmazensClause(req, params, idx);
      if (scopeSql.includes(`$${idx}`)) idx += 1;
      const q = await pool.query(
        `SELECT a.id, a.codigo, a.descricao
         FROM armazens a
         WHERE LOWER(TRIM(COALESCE(a.tipo, ''))) = 'central'
           ${scopeSql}
         ORDER BY a.codigo, a.descricao`,
        params
      );
      return res.json(q.rows || []);
    } catch (e) {
      console.error('Erro ao listar armazéns da contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao listar armazéns', details: e.message });
    }
  });

  router.get('/contagem-semanal/utilizadores', async (req, res) => {
    try {
      await ensureContagemSemanalSchema(pool);
      if (!canGerirContagemSemanal(req.user?.role)) {
        return res.status(403).json({ error: 'Sem permissão para atribuir tarefa.' });
      }
      const q = await pool.query(
        `SELECT u.id, u.username, u.nome, u.role
         FROM usuarios u
         WHERE LOWER(TRIM(COALESCE(u.role, ''))) = ANY($1::text[])
         ORDER BY COALESCE(NULLIF(TRIM(u.nome), ''), TRIM(u.username)), u.id`,
        [['admin', 'operador', 'backoffice_armazem', 'supervisor_armazem']]
      );
      return res.json(q.rows || []);
    } catch (e) {
      console.error('Erro ao listar utilizadores da contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao listar utilizadores', details: e.message });
    }
  });

  router.post('/contagem-semanal/tarefas', async (req, res) => {
    try {
      await ensureContagemSemanalSchema(pool);
      if (!canGerirContagemSemanal(req.user?.role)) {
        return res.status(403).json({ error: 'Sem permissão para criar tarefa.' });
      }
      const armazemId = Number(req.body?.armazem_id);
      const atribuidoParaUserId = Number(req.body?.atribuido_para_user_id);
      const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!Number.isFinite(armazemId) || !Number.isFinite(atribuidoParaUserId) || !rowsIn.length) {
        return res.status(400).json({ error: 'armazem_id, atribuido_para_user_id e rows são obrigatórios.' });
      }
      if (!isAdmin(req.user?.role)) {
        const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
        if (!allowed.includes(armazemId)) return res.status(403).json({ error: 'Sem acesso a este armazém.' });
      }

      const cleaned = rowsIn
        .map((r) => ({
          artigo: String(r?.artigo || '').trim(),
          descricao: String(r?.descricao || '').trim(),
          qtd: Number(r?.qtd || 0) || 0,
          qtd_ape: Number(r?.qtd_ape || 0) || 0,
        }))
        .filter((r) => r.artigo);
      if (!cleaned.length) return res.status(400).json({ error: 'Nenhuma linha válida para criar tarefa.' });

      const codigos = [...new Set(cleaned.map((r) => r.artigo))];
      const stockQ = await pool.query(
        `SELECT
           i.codigo,
           i.descricao,
           COALESCE(SUM(ali.quantidade), 0)::numeric AS quantidade_sistema
         FROM itens i
         LEFT JOIN armazens_localizacao_item ali ON ali.item_id = i.id
         LEFT JOIN armazens_localizacoes al
           ON al.id = ali.localizacao_id
          AND al.armazem_id = $1
         WHERE i.codigo = ANY($2::text[])
         GROUP BY i.codigo, i.descricao`,
        [armazemId, codigos]
      );
      const byCodigo = new Map(
        (stockQ.rows || []).map((x) => [String(x.codigo || '').trim(), {
          descricao: String(x.descricao || '').trim(),
          quantidade_sistema: Number(x.quantidade_sistema || 0),
        }])
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const created = await client.query(
          `INSERT INTO inventario_contagem_semanal_tarefas
             (armazem_id, atribuido_para_user_id, criado_por_user_id, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'ABERTA', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [armazemId, atribuidoParaUserId, req.user.id]
        );
        const tarefaId = Number(created.rows[0]?.id);
        for (const row of cleaned) {
          const hit = byCodigo.get(row.artigo);
          const qtdSistema = Number(hit?.quantidade_sistema || 0);
          const total = Number(row.qtd || 0) + Number(row.qtd_ape || 0);
          await client.query(
            `INSERT INTO inventario_contagem_semanal_linhas
               (tarefa_id, artigo, descricao, qtd, qtd_ape, total, quantidade_sistema, diferenca, created_at, updated_at)
             VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              tarefaId,
              row.artigo,
              row.descricao || String(hit?.descricao || ''),
              Number(row.qtd || 0),
              Number(row.qtd_ape || 0),
              total,
              qtdSistema,
              total - qtdSistema,
            ]
          );
        }
        await client.query('COMMIT');
        return res.json({ id: tarefaId });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao criar tarefa de contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao criar tarefa de contagem semanal', details: e.message });
    }
  });

  router.get('/contagem-semanal/tarefas', async (req, res) => {
    try {
      await ensureContagemSemanalSchema(pool);
      const params = [];
      let idx = 1;
      let where = 'WHERE 1=1';
      if (!isAdmin(req.user?.role)) {
        where += ` AND (t.atribuido_para_user_id = $${idx} OR t.criado_por_user_id = $${idx}) `;
        params.push(req.user.id);
        idx += 1;
      }
      const q = await pool.query(
        `SELECT
           t.id,
           t.armazem_id,
           t.atribuido_para_user_id,
           t.criado_por_user_id,
           t.status,
           t.created_at,
           t.updated_at,
           a.codigo AS armazem_codigo,
           a.descricao AS armazem_descricao,
           ua.username AS atribuido_para_username,
           ua.nome AS atribuido_para_nome,
           uc.username AS criado_por_username,
           uc.nome AS criado_por_nome,
           (SELECT COUNT(1) FROM inventario_contagem_semanal_linhas l WHERE l.tarefa_id = t.id) AS linhas_total
         FROM inventario_contagem_semanal_tarefas t
         INNER JOIN armazens a ON a.id = t.armazem_id
         LEFT JOIN usuarios ua ON ua.id = t.atribuido_para_user_id
         LEFT JOIN usuarios uc ON uc.id = t.criado_por_user_id
         ${where}
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT 300`,
        params
      );
      return res.json(q.rows || []);
    } catch (e) {
      console.error('Erro ao listar tarefas da contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao listar tarefas da contagem semanal', details: e.message });
    }
  });

  router.get('/contagem-semanal/tarefas/:id', async (req, res) => {
    try {
      await ensureContagemSemanalSchema(pool);
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido.' });
      const t = await pool.query(
        `SELECT t.*, a.codigo AS armazem_codigo, a.descricao AS armazem_descricao
         FROM inventario_contagem_semanal_tarefas t
         INNER JOIN armazens a ON a.id = t.armazem_id
         WHERE t.id = $1
         LIMIT 1`,
        [id]
      );
      if (!t.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
      const tarefa = t.rows[0];
      const canView = isAdmin(req.user?.role) ||
        Number(tarefa.atribuido_para_user_id) === Number(req.user.id) ||
        Number(tarefa.criado_por_user_id) === Number(req.user.id);
      if (!canView) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });

      const l = await pool.query(
        `SELECT id, tarefa_id, artigo, descricao, qtd, qtd_ape, total, quantidade_sistema, diferenca, updated_at
         FROM inventario_contagem_semanal_linhas
         WHERE tarefa_id = $1
         ORDER BY id`,
        [id]
      );
      return res.json({ ...tarefa, linhas: l.rows || [] });
    } catch (e) {
      console.error('Erro ao consultar tarefa da contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao consultar tarefa da contagem semanal', details: e.message });
    }
  });

  router.patch('/contagem-semanal/tarefas/:id/linhas/:linhaId', async (req, res) => {
    try {
      await ensureContagemSemanalSchema(pool);
      const id = Number(req.params.id);
      const linhaId = Number(req.params.linhaId);
      const qtd = Number(req.body?.qtd);
      const qtdApe = Number(req.body?.qtd_ape);
      if (!Number.isFinite(id) || !Number.isFinite(linhaId) || !Number.isFinite(qtd) || !Number.isFinite(qtdApe) || qtd < 0 || qtdApe < 0) {
        return res.status(400).json({ error: 'ID, linha, qtd e qtd_ape válidos são obrigatórios.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const t = await client.query(
          `SELECT * FROM inventario_contagem_semanal_tarefas WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!t.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        const tarefa = t.rows[0];
        const canEdit = isAdmin(req.user?.role) ||
          Number(tarefa.atribuido_para_user_id) === Number(req.user.id) ||
          Number(tarefa.criado_por_user_id) === Number(req.user.id);
        if (!canEdit) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });

        const l = await client.query(
          `SELECT * FROM inventario_contagem_semanal_linhas WHERE id = $1 AND tarefa_id = $2 FOR UPDATE`,
          [linhaId, id]
        );
        if (!l.rows.length) return res.status(404).json({ error: 'Linha não encontrada.' });
        const qtdSistema = Number(l.rows[0].quantidade_sistema || 0);
        const total = Number(qtd || 0) + Number(qtdApe || 0);
        const dif = total - qtdSistema;
        await client.query(
          `UPDATE inventario_contagem_semanal_linhas
           SET qtd = $3::numeric,
               qtd_ape = $4::numeric,
               total = $5::numeric,
               diferenca = $6::numeric,
               atualizado_por_user_id = $7,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND tarefa_id = $2`,
          [linhaId, id, qtd, qtdApe, total, dif, req.user.id]
        );
        await client.query(
          `UPDATE inventario_contagem_semanal_tarefas
           SET status = CASE WHEN status = 'ABERTA' THEN 'EM_CONTAGEM' ELSE status END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, total, diferenca: dif });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao guardar linha da contagem semanal:', e);
      return res.status(500).json({ error: 'Erro ao guardar linha da contagem semanal', details: e.message });
    }
  });

  router.post('/tarefas', async (req, res) => {
    try {
      if (!canCriarJustificar(req.user?.role)) {
        return res.status(403).json({ error: 'Apenas backoffice armazém pode abrir pedido de contagem.' });
      }
      const armazemId = Number(req.body?.armazem_id);
      const localizacaoId = Number(req.body?.localizacao_id);
      const itemId = Number(req.body?.item_id);
      if (!Number.isFinite(armazemId) || !Number.isFinite(localizacaoId) || !Number.isFinite(itemId)) {
        return res.status(400).json({ error: 'armazem_id, localizacao_id e item_id são obrigatórios.' });
      }
      if (!isAdmin(req.user?.role)) {
        const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
        if (!allowed.includes(armazemId)) return res.status(403).json({ error: 'Sem acesso a este armazém.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const snapshot = await client.query(
          `SELECT ali.quantidade::numeric AS qtd_sistema
           FROM armazens_localizacao_item ali
           INNER JOIN armazens_localizacoes al ON al.id = ali.localizacao_id
           WHERE al.id = $1 AND al.armazem_id = $2 AND ali.item_id = $3
           LIMIT 1`,
          [localizacaoId, armazemId, itemId]
        );
        const qtdSistema = Number(snapshot.rows[0]?.qtd_sistema || 0);
        const ins = await client.query(
          `INSERT INTO inventario_tarefas (
             armazem_id, localizacao_id, item_id, status,
             qtd_sistema_snapshot, criado_por, created_at, updated_at
           )
           VALUES ($1, $2, $3, 'ABERTA', $4::numeric, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [armazemId, localizacaoId, itemId, qtdSistema, req.user.id]
        );
        await client.query('COMMIT');
        return res.json({ id: ins.rows[0]?.id });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao criar tarefa inventário:', e);
      return res.status(500).json({ error: 'Erro ao criar tarefa', details: e.message });
    }
  });

  router.get('/tarefas', async (req, res) => {
    try {
      const status = String(req.query.status || '').trim().toUpperCase();
      const params = [];
      let idx = 1;
      let where = ` WHERE 1 = 1 `;
      if (status) {
        where += ` AND t.status = $${idx++} `;
        params.push(status);
      }
      if (!isAdmin(req.user?.role)) {
        const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
        if (!allowed.length) return res.json([]);
        where += ` AND t.armazem_id = ANY($${idx++}::int[]) `;
        params.push(allowed);
      }
      const r = await pool.query(
        `SELECT
           t.*,
           a.codigo AS armazem_codigo,
           a.descricao AS armazem_descricao,
           al.localizacao,
           i.codigo AS item_codigo,
           i.descricao AS item_descricao,
           uc.username AS criado_por_username,
           ub.username AS justificado_por_username,
           us.username AS decidido_por_username
         FROM inventario_tarefas t
         INNER JOIN armazens a ON a.id = t.armazem_id
         INNER JOIN armazens_localizacoes al ON al.id = t.localizacao_id
         INNER JOIN itens i ON i.id = t.item_id
         LEFT JOIN usuarios uc ON uc.id = t.criado_por
         LEFT JOIN usuarios ub ON ub.id = t.justificado_por
         LEFT JOIN usuarios us ON us.id = t.decidido_por
         ${where}
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT 500`,
        params
      );
      return res.json(r.rows || []);
    } catch (e) {
      console.error('Erro ao listar tarefas inventário:', e);
      return res.status(500).json({ error: 'Erro ao listar tarefas', details: e.message });
    }
  });

  router.patch('/tarefas/:id/contar', async (req, res) => {
    try {
      if (!canContar(req.user?.role)) {
        return res.status(403).json({ error: 'Apenas operador pode preencher contagem física.' });
      }
      const id = Number(req.params.id);
      const qtdFisica = Number(req.body?.qtd_fisica);
      if (!Number.isFinite(id) || !Number.isFinite(qtdFisica) || qtdFisica < 0) {
        return res.status(400).json({ error: 'ID e qtd_fisica válidos são obrigatórios.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query(`SELECT * FROM inventario_tarefas WHERE id = $1 FOR UPDATE`, [id]);
        if (!lock.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        const row = lock.rows[0];
        if (!isAdmin(req.user?.role)) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (!allowed.includes(Number(row.armazem_id))) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });
        }
        if (String(row.status || '') !== 'ABERTA') {
          return res.status(400).json({ error: 'A contagem só pode ser preenchida em tarefas ABERTAS.' });
        }
        const qtdSistema = Number(row.qtd_sistema_snapshot || 0);
        const delta = qtdFisica - qtdSistema;
        await client.query(
          `UPDATE inventario_tarefas
           SET qtd_fisica = $2::numeric,
               delta = $3::numeric,
               contado_por = $4,
               contado_em = CURRENT_TIMESTAMP,
               status = 'CONTADA',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, qtdFisica, delta, req.user.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao contar inventário:', e);
      return res.status(500).json({ error: 'Erro ao guardar contagem', details: e.message });
    }
  });

  router.patch('/tarefas/:id/justificar', async (req, res) => {
    try {
      if (!canCriarJustificar(req.user?.role)) {
        return res.status(403).json({ error: 'Apenas backoffice armazém pode justificar o desvio.' });
      }
      const id = Number(req.params.id);
      const justificativa = String(req.body?.justificativa || '').trim();
      if (!Number.isFinite(id) || justificativa.length < 10) {
        return res.status(400).json({ error: 'Justificativa mínima de 10 caracteres.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query(`SELECT * FROM inventario_tarefas WHERE id = $1 FOR UPDATE`, [id]);
        if (!lock.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        const row = lock.rows[0];
        if (!isAdmin(req.user?.role)) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (!allowed.includes(Number(row.armazem_id))) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });
        }
        if (String(row.status || '') !== 'CONTADA') {
          return res.status(400).json({ error: 'Só é possível justificar tarefas CONTADAS.' });
        }
        await client.query(
          `UPDATE inventario_tarefas
           SET justificativa_backoffice = $2,
               justificado_por = $3,
               justificado_em = CURRENT_TIMESTAMP,
               status = 'JUSTIFICADA',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, justificativa, req.user.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao justificar tarefa inventário:', e);
      return res.status(500).json({ error: 'Erro ao justificar tarefa', details: e.message });
    }
  });

  router.patch('/tarefas/:id/decidir', async (req, res) => {
    try {
      if (!canDecidirAplicar(req.user?.role)) {
        return res.status(403).json({ error: 'Apenas supervisor armazém pode aprovar/rejeitar.' });
      }
      const id = Number(req.params.id);
      const acao = String(req.body?.acao || '').trim().toLowerCase();
      const motivo = String(req.body?.motivo || '').trim();
      if (!Number.isFinite(id) || !['aprovar', 'rejeitar'].includes(acao)) {
        return res.status(400).json({ error: 'ID e ação válidos são obrigatórios.' });
      }
      if (acao === 'rejeitar' && motivo.length < 5) {
        return res.status(400).json({ error: 'Motivo da rejeição mínimo de 5 caracteres.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query(`SELECT * FROM inventario_tarefas WHERE id = $1 FOR UPDATE`, [id]);
        if (!lock.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        const row = lock.rows[0];
        if (!isAdmin(req.user?.role)) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (!allowed.includes(Number(row.armazem_id))) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });
        }
        if (String(row.status || '') !== 'JUSTIFICADA') {
          return res.status(400).json({ error: 'Só é possível decidir tarefas JUSTIFICADAS.' });
        }
        const targetStatus = acao === 'aprovar' ? 'APROVADA_SUPERVISOR' : 'REJEITADA_SUPERVISOR';
        await client.query(
          `UPDATE inventario_tarefas
           SET status = $2,
               decisao_supervisor = $3,
               supervisor_decisao_motivo = $4,
               decidido_por = $5,
               decidido_em = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, targetStatus, acao === 'aprovar' ? 'APROVADA' : 'REJEITADA', motivo || null, req.user.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao decidir tarefa inventário:', e);
      return res.status(500).json({ error: 'Erro ao decidir tarefa', details: e.message });
    }
  });

  router.patch('/tarefas/:id/aplicar', async (req, res) => {
    try {
      if (!canDecidirAplicar(req.user?.role)) {
        return res.status(403).json({ error: 'Apenas supervisor armazém pode aplicar ajuste.' });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido.' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query(`SELECT * FROM inventario_tarefas WHERE id = $1 FOR UPDATE`, [id]);
        if (!lock.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
        const row = lock.rows[0];
        if (!isAdmin(req.user?.role)) {
          const allowed = Array.isArray(req.requisicaoArmazemOrigemIds) ? req.requisicaoArmazemOrigemIds : [];
          if (!allowed.includes(Number(row.armazem_id))) return res.status(403).json({ error: 'Sem acesso a esta tarefa.' });
        }
        if (String(row.status || '') !== 'APROVADA_SUPERVISOR') {
          return res.status(400).json({ error: 'Apenas tarefas aprovadas pelo supervisor podem ser aplicadas.' });
        }
        const localizacaoId = Number(row.localizacao_id);
        const itemId = Number(row.item_id);
        const delta = Number(row.delta || 0);
        const curQ = await client.query(
          `SELECT id, quantidade::numeric AS quantidade
           FROM armazens_localizacao_item
           WHERE localizacao_id = $1 AND item_id = $2
           FOR UPDATE`,
          [localizacaoId, itemId]
        );
        if (!curQ.rows.length) {
          if (delta < 0) {
            return res.status(400).json({ error: 'Não é possível reduzir stock inexistente.' });
          }
          await client.query(
            `INSERT INTO armazens_localizacao_item (localizacao_id, item_id, quantidade, created_at, updated_at)
             VALUES ($1, $2, $3::numeric, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [localizacaoId, itemId, delta]
          );
        } else {
          const atual = Number(curQ.rows[0].quantidade || 0);
          const novo = atual + delta;
          if (novo < -1e-9) {
            return res.status(400).json({ error: 'Ajuste deixaria stock negativo.' });
          }
          await client.query(
            `UPDATE armazens_localizacao_item
             SET quantidade = $3::numeric, updated_at = CURRENT_TIMESTAMP
             WHERE localizacao_id = $1 AND item_id = $2`,
            [localizacaoId, itemId, novo]
          );
        }
        await client.query(
          `UPDATE inventario_tarefas
           SET status = 'APLICADA',
               aplicado_por = $2,
               aplicado_em = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, req.user.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao aplicar ajuste inventário:', e);
      return res.status(500).json({ error: 'Erro ao aplicar ajuste', details: e.message });
    }
  });

  return router;
}

module.exports = { createInventarioRouter };
