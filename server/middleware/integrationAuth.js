const crypto = require('crypto');

const DEFAULT_TOKEN_TTL_SECONDS = Math.max(300, parseInt(process.env.INTEGRATION_TOKEN_TTL_SECONDS || '3600', 10));
const DEFAULT_RATE_LIMIT_PER_MIN = Math.max(30, parseInt(process.env.INTEGRATION_RATE_LIMIT_PER_MIN || '300', 10));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomOpaqueToken() {
  return crypto.randomBytes(48).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeScopes(scopesText) {
  const raw = String(scopesText || '').trim();
  if (!raw) return [];
  const uniq = new Set(
    raw
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
  );
  return [...uniq];
}

function pickAllowedScopes(requested, allowed) {
  if (!requested || requested.length === 0) return allowed;
  const allowSet = new Set(allowed);
  return requested.filter((s) => allowSet.has(s));
}

function createRequestIdMiddleware() {
  return (req, _res, next) => {
    const fromHeader = String(req.headers['x-request-id'] || '').trim();
    req.integrationRequestId = fromHeader || `int_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    next();
  };
}

function createIntegrationRateLimiter() {
  const buckets = new Map();
  return (req, res, next) => {
    const clientId = req.integrationClient?.client_id || 'anonymous';
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `${clientId}:${minuteBucket}`;
    const current = (buckets.get(key) || 0) + 1;
    buckets.set(key, current);

    if (current > DEFAULT_RATE_LIMIT_PER_MIN) {
      return res.status(429).json({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Limite de requisições por minuto excedido.',
        request_id: req.integrationRequestId
      });
    }
    next();
  };
}

function createIntegrationOAuthHelpers(pool) {
  async function issueToken({ clientId, clientSecret, scopeText }) {
    if (!clientId || !clientSecret) {
      return { ok: false, status: 400, error: 'invalid_client', error_description: 'client_id e client_secret são obrigatórios.' };
    }
    const q = await pool.query(
      `SELECT client_id, client_secret_hash, scopes, ativo
       FROM integration_clients
       WHERE client_id = $1
       LIMIT 1`,
      [clientId]
    );
    if (q.rows.length === 0 || !q.rows[0].ativo) {
      return { ok: false, status: 401, error: 'invalid_client', error_description: 'Cliente inválido ou inativo.' };
    }

    const client = q.rows[0];
    const secretHash = sha256(clientSecret);
    if (secretHash !== client.client_secret_hash) {
      return { ok: false, status: 401, error: 'invalid_client', error_description: 'Credenciais inválidas.' };
    }

    const allowedScopes = Array.isArray(client.scopes) ? client.scopes : [];
    const requestedScopes = normalizeScopes(scopeText);
    const finalScopes = pickAllowedScopes(requestedScopes, allowedScopes);
    if (requestedScopes.length > 0 && finalScopes.length !== requestedScopes.length) {
      return { ok: false, status: 400, error: 'invalid_scope', error_description: 'Um ou mais scopes não são permitidos para este cliente.' };
    }

    const accessToken = randomOpaqueToken();
    const tokenHash = sha256(accessToken);
    const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_SECONDS * 1000);

    await pool.query(
      `INSERT INTO integration_access_tokens (client_id, token_hash, scopes, expires_at)
       VALUES ($1, $2, $3::text[], $4)`,
      [client.client_id, tokenHash, finalScopes, expiresAt]
    );

    return {
      ok: true,
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: DEFAULT_TOKEN_TTL_SECONDS,
      scope: finalScopes.join(' ')
    };
  }

  async function authenticateBearer(req, res, next) {
    try {
      const authHeader = String(req.headers.authorization || '');
      const [, token] = authHeader.split(' ');
      if (!token) {
        return res.status(401).json({
          code: 'TOKEN_REQUIRED',
          message: 'Bearer token é obrigatório.',
          request_id: req.integrationRequestId
        });
      }
      const tokenHash = sha256(token);
      const q = await pool.query(
        `SELECT t.client_id, t.scopes, t.expires_at, t.revoked_at, c.ativo
         FROM integration_access_tokens t
         INNER JOIN integration_clients c ON c.client_id = t.client_id
         WHERE t.token_hash = $1
         LIMIT 1`,
        [tokenHash]
      );
      if (q.rows.length === 0) {
        return res.status(401).json({
          code: 'TOKEN_INVALID',
          message: 'Token inválido.',
          request_id: req.integrationRequestId
        });
      }
      const row = q.rows[0];
      if (!row.ativo || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
        return res.status(401).json({
          code: 'TOKEN_EXPIRED',
          message: 'Token expirado, revogado ou cliente inativo.',
          request_id: req.integrationRequestId
        });
      }
      req.integrationClient = {
        client_id: row.client_id,
        scopes: Array.isArray(row.scopes) ? row.scopes : []
      };
      return next();
    } catch (err) {
      return res.status(500).json({
        code: 'AUTH_ERROR',
        message: 'Erro ao validar token de integração.',
        request_id: req.integrationRequestId
      });
    }
  }

  function requireScopes(requiredScopes = []) {
    const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
    return (req, res, next) => {
      const have = new Set(req.integrationClient?.scopes || []);
      const missing = required.filter((s) => !have.has(s));
      if (missing.length > 0) {
        return res.status(403).json({
          code: 'SCOPE_FORBIDDEN',
          message: `Scope insuficiente. Faltam: ${missing.join(', ')}`,
          request_id: req.integrationRequestId
        });
      }
      next();
    };
  }

  async function createClient({ nomeSistema, scopes }) {
    const clientId = `cli_${crypto.randomBytes(10).toString('hex')}`;
    const clientSecret = crypto.randomBytes(24).toString('base64url');
    const secretHash = sha256(clientSecret);
    const normalizedScopes = Array.isArray(scopes)
      ? [...new Set(scopes.map((s) => String(s || '').trim()).filter(Boolean))]
      : [];

    await pool.query(
      `INSERT INTO integration_clients (client_id, client_secret_hash, nome_sistema, scopes)
       VALUES ($1, $2, $3, $4::text[])`,
      [clientId, secretHash, nomeSistema || `Sistema ${nowIso()}`, normalizedScopes]
    );

    return { client_id: clientId, client_secret: clientSecret, scopes: normalizedScopes };
  }

  return {
    issueToken,
    authenticateBearer,
    requireScopes,
    createClient
  };
}

module.exports = {
  DEFAULT_TOKEN_TTL_SECONDS,
  DEFAULT_RATE_LIMIT_PER_MIN,
  createRequestIdMiddleware,
  createIntegrationRateLimiter,
  createIntegrationOAuthHelpers,
  sha256,
};
