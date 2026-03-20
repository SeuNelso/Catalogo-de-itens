const { pool } = require('../db/pool');

/** Quem ignora o filtro de armazém nas requisições */
function roleComAcessoTotalRequisicoes(role) {
  return role === 'admin' || role === 'controller';
}

/** Cache apenas quando a coluna existe (evita ficar preso a "false" após migração sem reinício). */
let _cacheUsuariosColReqArmOrigem = false;

async function usuariosTemColunaRequisicoesArmazemOrigem() {
  if (_cacheUsuariosColReqArmOrigem) {
    return true;
  }
  try {
    const r = await pool.query(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'usuarios'
         AND column_name = 'requisicoes_armazem_origem_id'
       LIMIT 1`,
    );
    if (r.rows.length > 0) {
      _cacheUsuariosColReqArmOrigem = true;
      return true;
    }
  } catch (err) {
    console.error('[DB] Falha ao verificar coluna requisicoes_armazem_origem_id:', err.message);
  }
  return false;
}

/** Tabela N:N usuario_requisicoes_armazens (migração multi-armazém). Cache só quando existe. */
let _cacheJunctionTableUsuariosArmazens = false;

async function usuarioRequisicaoArmazemJunctionTableExists() {
  if (_cacheJunctionTableUsuariosArmazens) return true;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'usuario_requisicoes_armazens' LIMIT 1`,
    );
    if (r.rows.length > 0) {
      _cacheJunctionTableUsuariosArmazens = true;
      return true;
    }
  } catch (err) {
    console.error('[DB] Falha ao verificar tabela usuario_requisicoes_armazens:', err.message);
  }
  return false;
}

/** Lista de armazéns de origem permitidos para requisições. Vazio = sem filtro extra. */
async function fetchRequisicoesArmazemIdsForUser(userId) {
  if (!userId) return [];
  if (await usuarioRequisicaoArmazemJunctionTableExists()) {
    const r = await pool.query(
      'SELECT armazem_id FROM usuario_requisicoes_armazens WHERE usuario_id = $1 ORDER BY armazem_id',
      [userId],
    );
    return r.rows.map((row) => parseInt(row.armazem_id, 10));
  }
  if (await usuariosTemColunaRequisicoesArmazemOrigem()) {
    const r = await pool.query(
      'SELECT requisicoes_armazem_origem_id FROM usuarios WHERE id = $1',
      [userId],
    );
    const v = r.rows[0]?.requisicoes_armazem_origem_id;
    if (v != null && v !== '') return [parseInt(v, 10)];
  }
  return [];
}

/** Scope após requisicaoScopeMiddleware: requisicaoArmazemOrigemIds = array; vazio ⇒ sem filtro */
async function requisicaoScopeMiddleware(req, res, next) {
  try {
    req.requisicaoArmazemOrigemIds = [];
    if (!req.user || !req.user.id) return next();
    if (roleComAcessoTotalRequisicoes(req.user.role)) {
      return next();
    }
    req.requisicaoArmazemOrigemIds = await fetchRequisicoesArmazemIdsForUser(req.user.id);
    next();
  } catch (e) {
    next(e);
  }
}

function requisicaoArmazemOrigemAcessoPermitido(req, armazemOrigemId) {
  if (!req.user) return false;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return true;
  const allowed = req.requisicaoArmazemOrigemIds;
  if (!allowed || allowed.length === 0) return true;
  const sid =
    armazemOrigemId != null && armazemOrigemId !== '' ? parseInt(armazemOrigemId, 10) : NaN;
  if (Number.isNaN(sid)) return false;
  return allowed.includes(sid);
}

/** Valida scope para exportação multi; lanha se algum id fora dos armazéns permitidos. */
async function assertIdsRequisicoesPermitidas(req, idsRaw) {
  const idsClean = [...new Set((idsRaw || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (idsClean.length === 0) return;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return;
  const allowed = req.requisicaoArmazemOrigemIds;
  if (!allowed || allowed.length === 0) return;
  const bad = await pool.query(
    `SELECT id FROM requisicoes WHERE id = ANY($1::int[])
     AND (armazem_origem_id IS NULL OR NOT (armazem_origem_id = ANY($2::int[])))
     LIMIT 1`,
    [idsClean, allowed],
  );
  if (bad.rows.length > 0) {
    const e = new Error('Acesso negado a uma ou mais requisições.');
    e.statusCode = 403;
    throw e;
  }
}

function createRequisicaoAuth(authenticateToken) {
  return [authenticateToken, requisicaoScopeMiddleware];
}

module.exports = {
  requisicaoScopeMiddleware,
  requisicaoArmazemOrigemAcessoPermitido,
  assertIdsRequisicoesPermitidas,
  createRequisicaoAuth,
  /** Usado no login / verify-token para incluir armazéns de origem no JWT e no utilizador. */
  fetchRequisicoesArmazemIdsForUser,
  /** Introspecção BD para listagem/edição de utilizadores e requisições. */
  usuarioRequisicaoArmazemJunctionTableExists,
  usuariosTemColunaRequisicoesArmazemOrigem,
};
