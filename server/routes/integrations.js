const express = require('express');
const crypto = require('crypto');
const {
  createRequestIdMiddleware,
  createIntegrationRateLimiter,
  createIntegrationOAuthHelpers,
  sha256,
} = require('../middleware/integrationAuth');

const SUPPORTED_SCOPES = Object.freeze([
  'catalog:read',
  'catalog:write',
  'warehouses:read',
  'requests:read',
  'requests:write',
  'requests:status',
  'transfers:read',
  'transfers:write',
  'transfers:status',
  'returns:read',
  'returns:write',
  'returns:status',
  'webhooks:manage',
]);

function normTipo(v) {
  return String(v || '').trim().toLowerCase();
}

function isTransferFlow(origemTipo, destinoTipo) {
  const o = normTipo(origemTipo);
  const d = normTipo(destinoTipo);
  return (o === 'central' && d === 'apeado') || (o === 'apeado' && d === 'central') || (o === 'central' && d === 'central');
}

function isReturnFlow(origemTipo, destinoTipo) {
  return normTipo(origemTipo) === 'viatura' && normTipo(destinoTipo) === 'central';
}

function createIntegrationRouter({ pool, authenticateToken }) {
  const router = express.Router();
  const oauth = createIntegrationOAuthHelpers(pool);
  const requestId = createRequestIdMiddleware();
  const rateLimiter = createIntegrationRateLimiter();

  async function withAudit(req, res, next) {
    const start = Date.now();
    const end = res.end;
    res.end = async function patchedEnd(...args) {
      res.end = end;
      try {
        const duration = Date.now() - start;
        await pool.query(
          `INSERT INTO integration_audit_log
           (request_id, client_id, method, endpoint, status_code, duration_ms, error_code, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.integrationRequestId,
            req.integrationClient?.client_id || null,
            req.method,
            req.originalUrl,
            res.statusCode || 200,
            duration,
            res.locals?.integration_error_code || null,
            res.locals?.integration_error_message || null,
          ]
        );
      } catch (_) {}
      return end.apply(this, args);
    };
    next();
  }

  async function tryIdempotency(req, res, next) {
    if (!['POST'].includes(req.method)) return next();
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (!key || !req.integrationClient?.client_id) return next();

    const endpoint = req.baseUrl + req.path;
    const requestHash = sha256(JSON.stringify(req.body || {}));
    const clientId = req.integrationClient.client_id;
    const q = await pool.query(
      `SELECT id, request_hash, status_code, response_body
       FROM integration_idempotency_keys
       WHERE client_id = $1 AND idempotency_key = $2 AND method = $3 AND endpoint = $4
       LIMIT 1`,
      [clientId, key, req.method, endpoint]
    );
    if (q.rows.length > 0) {
      const row = q.rows[0];
      if (row.request_hash !== requestHash) {
        res.locals.integration_error_code = 'IDEMPOTENCY_CONFLICT';
        res.locals.integration_error_message = 'Idempotency-Key reutilizada com payload diferente.';
        return res.status(409).json({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency-Key reutilizada com payload diferente.',
          request_id: req.integrationRequestId,
        });
      }
      return res.status(row.status_code).json(row.response_body || {});
    }

    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      const statusCode = res.statusCode || 200;
      try {
        await pool.query(
          `INSERT INTO integration_idempotency_keys
           (client_id, idempotency_key, method, endpoint, request_hash, status_code, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [clientId, key, req.method, endpoint, requestHash, statusCode, JSON.stringify(body || {})]
        );
      } catch (_) {}
      return originalJson(body);
    };
    next();
  }

  async function queueWebhookEvent(clientId, eventName, payload) {
    const sub = await pool.query(
      `SELECT id FROM integration_webhook_subscriptions
       WHERE client_id = $1 AND event_name = $2 AND ativo = TRUE`,
      [clientId, eventName]
    );
    for (const row of sub.rows) {
      await pool.query(
        `INSERT INTO integration_webhook_deliveries (subscription_id, event_name, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [row.id, eventName, JSON.stringify(payload || {})]
      );
    }
  }

  function fail(res, req, status, code, message) {
    res.locals.integration_error_code = code;
    res.locals.integration_error_message = message;
    return res.status(status).json({
      code,
      message,
      request_id: req.integrationRequestId,
    });
  }

  router.use(requestId);
  router.use(withAudit);

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'integrations-v1', time: new Date().toISOString() });
  });

  router.get('/meta/scopes', (_req, res) => {
    res.json({ scopes: SUPPORTED_SCOPES });
  });

  router.get('/meta/version', (_req, res) => {
    res.json({ version: 'v1', auth: 'oauth2-client-credentials' });
  });

  router.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
    const grantType = String(req.body?.grant_type || '').trim();
    if (grantType !== 'client_credentials') {
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Apenas client_credentials é suportado.',
      });
    }
    const result = await oauth.issueToken({
      clientId: req.body?.client_id,
      clientSecret: req.body?.client_secret,
      scopeText: req.body?.scope,
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        error_description: result.error_description,
      });
    }
    return res.json(result);
  });

  // Cadastro de clientes M2M por admin interno.
  router.post('/admin/clients', authenticateToken, async (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    const nomeSistema = String(req.body?.nome_sistema || '').trim();
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
    const invalid = scopes.filter((s) => !SUPPORTED_SCOPES.includes(String(s)));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Scopes inválidos: ${invalid.join(', ')}` });
    }
    const created = await oauth.createClient({ nomeSistema, scopes });
    return res.status(201).json(created);
  });

  // Autenticação obrigatória abaixo.
  router.use(oauth.authenticateBearer);
  router.use(rateLimiter);
  router.use(tryIdempotency);

  router.get('/items', oauth.requireScopes(['catalog:read']), async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = await pool.query(
      `SELECT id, codigo, descricao, familia, subfamilia, unidade_armazenamento, updated_at
       FROM catalog
       ORDER BY id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ data: rows.rows, limit, offset });
  });

  router.get('/items/:id', oauth.requireScopes(['catalog:read']), async (req, res) => {
    const { id } = req.params;
    const row = await pool.query(
      `SELECT id, codigo, descricao, familia, subfamilia, unidade_armazenamento, updated_at
       FROM catalog WHERE id = $1`,
      [id]
    );
    if (row.rows.length === 0) return fail(res, req, 404, 'NOT_FOUND', 'Item não encontrado.');
    res.json(row.rows[0]);
  });

  router.get('/warehouses', oauth.requireScopes(['warehouses:read']), async (_req, res) => {
    const q = await pool.query(
      `SELECT id, codigo, descricao, tipo, ativo
       FROM armazens
       ORDER BY codigo ASC`
    );
    res.json({ data: q.rows });
  });

  router.get('/requests', oauth.requireScopes(['requests:read']), async (req, res) => {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const params = [];
    let query = `
      SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.observacoes, r.created_at, r.updated_at
      FROM requisicoes r
      LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
      LEFT JOIN armazens ad ON ad.id = r.armazem_id
      WHERE NOT (
        (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'viatura' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
        OR (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'central' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'apeado')
        OR (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'apeado' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
        OR (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'central' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
      )
    `;
    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }
    params.push(limit, offset);
    query += ` ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const q = await pool.query(query, params);
    res.json({ data: q.rows, limit, offset });
  });

  router.post('/requests', oauth.requireScopes(['requests:write']), async (req, res) => {
    const { armazem_origem_id, armazem_id, observacoes, itens } = req.body || {};
    if (!armazem_id || !Array.isArray(itens) || itens.length === 0) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'armazem_id e itens são obrigatórios.');
    }
    const ins = await pool.query(
      `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
       VALUES ($1, $2, $3, NULL, 'pendente')
       RETURNING id, status, armazem_origem_id, armazem_id, observacoes, created_at`,
      [armazem_origem_id || null, armazem_id, observacoes || null]
    );
    const requisicao = ins.rows[0];
    for (const it of itens) {
      const itemId = parseInt(it.item_id, 10);
      const qtd = Math.max(0, parseInt(it.quantidade, 10) || 0);
      if (!itemId || qtd <= 0) continue;
      await pool.query(
        `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
         VALUES ($1, $2, $3)`,
        [requisicao.id, itemId, qtd]
      );
    }
    await queueWebhookEvent(req.integrationClient.client_id, 'request.created', requisicao);
    res.status(201).json(requisicao);
  });

  router.patch('/requests/:id/status', oauth.requireScopes(['requests:status']), async (req, res) => {
    const { id } = req.params;
    const status = String(req.body?.status || '').trim();
    if (!status) return fail(res, req, 400, 'VALIDATION_ERROR', 'status é obrigatório.');
    const up = await pool.query(
      `UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [status, id]
    );
    if (up.rows.length === 0) return fail(res, req, 404, 'NOT_FOUND', 'Requisição não encontrada.');
    await queueWebhookEvent(req.integrationClient.client_id, 'request.status_changed', up.rows[0]);
    res.json(up.rows[0]);
  });

  router.get('/transfers', oauth.requireScopes(['transfers:read']), async (req, res) => {
    const status = String(req.query.status || '').trim();
    const params = [];
    let query = `
      SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.observacoes, r.created_at, r.updated_at
      FROM requisicoes r
      LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
      LEFT JOIN armazens ad ON ad.id = r.armazem_id
      WHERE (
        (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'central' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'apeado')
        OR (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'apeado' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
        OR (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'central' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
      )
    `;
    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }
    query += ' ORDER BY r.created_at DESC LIMIT 500';
    const q = await pool.query(query, params);
    res.json({ data: q.rows });
  });

  router.post('/transfers', oauth.requireScopes(['transfers:write']), async (req, res) => {
    const { armazem_origem_id, armazem_id, observacoes, itens } = req.body || {};
    if (!armazem_origem_id || !armazem_id || !Array.isArray(itens) || itens.length === 0) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'armazem_origem_id, armazem_id e itens são obrigatórios.');
    }
    const arm = await pool.query(
      `SELECT id, tipo FROM armazens WHERE id = ANY($1::int[])`,
      [[parseInt(armazem_origem_id, 10), parseInt(armazem_id, 10)]]
    );
    const map = new Map(arm.rows.map((r) => [Number(r.id), normTipo(r.tipo)]));
    const origemTipo = map.get(Number(armazem_origem_id));
    const destinoTipo = map.get(Number(armazem_id));
    if (!isTransferFlow(origemTipo, destinoTipo)) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'Fluxo inválido para transferências.');
    }
    const ins = await pool.query(
      `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
       VALUES ($1, $2, $3, NULL, 'pendente')
       RETURNING id, status, armazem_origem_id, armazem_id, observacoes, created_at`,
      [armazem_origem_id, armazem_id, observacoes || null]
    );
    const row = ins.rows[0];
    for (const it of itens) {
      const itemId = parseInt(it.item_id, 10);
      const qtd = Math.max(0, parseInt(it.quantidade, 10) || 0);
      if (!itemId || qtd <= 0) continue;
      await pool.query(
        `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
         VALUES ($1, $2, $3)`,
        [row.id, itemId, qtd]
      );
    }
    await queueWebhookEvent(req.integrationClient.client_id, 'transfer.created', row);
    res.status(201).json(row);
  });

  router.patch('/transfers/:id/status', oauth.requireScopes(['transfers:status']), async (req, res) => {
    const { id } = req.params;
    const status = String(req.body?.status || '').trim();
    if (!status) return fail(res, req, 400, 'VALIDATION_ERROR', 'status é obrigatório.');
    const up = await pool.query(
      `UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [status, id]
    );
    if (up.rows.length === 0) return fail(res, req, 404, 'NOT_FOUND', 'Transferência não encontrada.');
    await queueWebhookEvent(req.integrationClient.client_id, 'transfer.status_changed', up.rows[0]);
    res.json(up.rows[0]);
  });

  router.get('/returns', oauth.requireScopes(['returns:read']), async (req, res) => {
    const status = String(req.query.status || '').trim();
    const params = [];
    let query = `
      SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.observacoes, r.created_at, r.updated_at
      FROM requisicoes r
      LEFT JOIN armazens ao ON ao.id = r.armazem_origem_id
      LEFT JOIN armazens ad ON ad.id = r.armazem_id
      WHERE (LOWER(TRIM(COALESCE(ao.tipo,''))) = 'viatura' AND LOWER(TRIM(COALESCE(ad.tipo,''))) = 'central')
    `;
    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }
    query += ' ORDER BY r.created_at DESC LIMIT 500';
    const q = await pool.query(query, params);
    res.json({ data: q.rows });
  });

  router.post('/returns', oauth.requireScopes(['returns:write']), async (req, res) => {
    const { armazem_origem_id, armazem_id, observacoes, itens } = req.body || {};
    if (!armazem_origem_id || !armazem_id || !Array.isArray(itens) || itens.length === 0) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'armazem_origem_id, armazem_id e itens são obrigatórios.');
    }
    const arm = await pool.query(
      `SELECT id, tipo FROM armazens WHERE id = ANY($1::int[])`,
      [[parseInt(armazem_origem_id, 10), parseInt(armazem_id, 10)]]
    );
    const map = new Map(arm.rows.map((r) => [Number(r.id), normTipo(r.tipo)]));
    const origemTipo = map.get(Number(armazem_origem_id));
    const destinoTipo = map.get(Number(armazem_id));
    if (!isReturnFlow(origemTipo, destinoTipo)) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'Fluxo inválido para devoluções (esperado viatura -> central).');
    }
    const ins = await pool.query(
      `INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
       VALUES ($1, $2, $3, NULL, 'pendente')
       RETURNING id, status, armazem_origem_id, armazem_id, observacoes, created_at`,
      [armazem_origem_id, armazem_id, observacoes || null]
    );
    const row = ins.rows[0];
    for (const it of itens) {
      const itemId = parseInt(it.item_id, 10);
      const qtd = Math.max(0, parseInt(it.quantidade, 10) || 0);
      if (!itemId || qtd <= 0) continue;
      await pool.query(
        `INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
         VALUES ($1, $2, $3)`,
        [row.id, itemId, qtd]
      );
    }
    await queueWebhookEvent(req.integrationClient.client_id, 'return.created', row);
    res.status(201).json(row);
  });

  router.patch('/returns/:id/status', oauth.requireScopes(['returns:status']), async (req, res) => {
    const { id } = req.params;
    const status = String(req.body?.status || '').trim();
    if (!status) return fail(res, req, 400, 'VALIDATION_ERROR', 'status é obrigatório.');
    const up = await pool.query(
      `UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [status, id]
    );
    if (up.rows.length === 0) return fail(res, req, 404, 'NOT_FOUND', 'Devolução não encontrada.');
    await queueWebhookEvent(req.integrationClient.client_id, 'return.status_changed', up.rows[0]);
    res.json(up.rows[0]);
  });

  // Webhooks (fundação)
  router.get('/webhooks/subscriptions', oauth.requireScopes(['webhooks:manage']), async (req, res) => {
    const q = await pool.query(
      `SELECT id, event_name, callback_url, ativo, created_at, updated_at
       FROM integration_webhook_subscriptions
       WHERE client_id = $1
       ORDER BY id DESC`,
      [req.integrationClient.client_id]
    );
    res.json({ data: q.rows });
  });

  router.post('/webhooks/subscriptions', oauth.requireScopes(['webhooks:manage']), async (req, res) => {
    const eventName = String(req.body?.event_name || '').trim();
    const callbackUrl = String(req.body?.callback_url || '').trim();
    if (!eventName || !callbackUrl) {
      return fail(res, req, 400, 'VALIDATION_ERROR', 'event_name e callback_url são obrigatórios.');
    }
    const signingSecret = crypto.randomBytes(24).toString('base64url');
    const signingSecretHash = sha256(signingSecret);
    const ins = await pool.query(
      `INSERT INTO integration_webhook_subscriptions (client_id, event_name, callback_url, signing_secret_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, event_name, callback_url, ativo, created_at`,
      [req.integrationClient.client_id, eventName, callbackUrl, signingSecretHash]
    );
    res.status(201).json({
      ...ins.rows[0],
      signing_secret: signingSecret,
    });
  });

  router.patch('/webhooks/subscriptions/:id', oauth.requireScopes(['webhooks:manage']), async (req, res) => {
    const { id } = req.params;
    const ativo = req.body?.ativo;
    const callbackUrl = req.body?.callback_url;
    const up = await pool.query(
      `UPDATE integration_webhook_subscriptions
       SET ativo = COALESCE($1, ativo),
           callback_url = COALESCE($2, callback_url),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND client_id = $4
       RETURNING id, event_name, callback_url, ativo, updated_at`,
      [typeof ativo === 'boolean' ? ativo : null, callbackUrl ? String(callbackUrl).trim() : null, id, req.integrationClient.client_id]
    );
    if (up.rows.length === 0) return fail(res, req, 404, 'NOT_FOUND', 'Subscription não encontrada.');
    res.json(up.rows[0]);
  });

  router.get('/webhooks/deliveries', oauth.requireScopes(['webhooks:manage']), async (req, res) => {
    const q = await pool.query(
      `SELECT d.id, d.subscription_id, d.event_name, d.status, d.attempts, d.next_retry_at, d.last_error, d.delivered_at, d.created_at
       FROM integration_webhook_deliveries d
       INNER JOIN integration_webhook_subscriptions s ON s.id = d.subscription_id
       WHERE s.client_id = $1
       ORDER BY d.id DESC
       LIMIT 500`,
      [req.integrationClient.client_id]
    );
    res.json({ data: q.rows });
  });

  return router;
}

module.exports = {
  createIntegrationRouter,
  SUPPORTED_SCOPES,
};
