const express = require('express');
const { isAdmin } = require('../utils/roles');

const INVENTARIO_ROLES = new Set(['admin', 'backoffice_armazem', 'supervisor_armazem', 'operador']);
const ROLES_CRIAR_JUSTIFICAR = new Set(['admin', 'backoffice_armazem']);
const ROLES_CONTAR = new Set(['admin', 'operador']);
const ROLES_DECIDIR_APLICAR = new Set(['admin', 'supervisor_armazem']);

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

function createInventarioRouter(deps = {}) {
  const router = express.Router();
  const { pool, requisicaoAuth } = deps;
  if (!pool || !requisicaoAuth) {
    throw new Error('createInventarioRouter: deps.pool e deps.requisicaoAuth são obrigatórios.');
  }

  router.use(...requisicaoAuth);

  router.use((req, res, next) => {
    if (!canAccessInventario(req.user?.role) || req.user?.pode_controlo_stock !== true) {
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
