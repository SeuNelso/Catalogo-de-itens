const { pool } = require('../db/pool');
const { isAdmin } = require('../utils/roles');

/** Quem ignora o filtro de armazém nas requisições (apenas admin). */
function roleComAcessoTotalRequisicoes(role) {
  return isAdmin(role);
}

/** Perfis sem módulo de requisições (API 403 em /api/requisicoes). */
function perfilSemAcessoModuloRequisicoes(role) {
  return role === 'basico' || role === 'controller';
}

function requisicaoPerfilNegadoMiddleware(req, res, next) {
  try {
    const role = req.user && req.user.role;
    if (perfilSemAcessoModuloRequisicoes(role)) {
      return res.status(403).json({
        error: 'Este perfil não tem acesso a requisições.',
        code: 'REQUISICOES_PERFIL_NEGADO',
      });
    }
    next();
  } catch (e) {
    next(e);
  }
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

/** Lista de armazéns de origem permitidos para requisições (por utilizador). */
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

/** Scope após requisicaoScopeMiddleware: requisicaoArmazemOrigemIds = ids permitidos (vazio para não admin ⇒ sem acesso a requisições). */
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

/**
 * Consulta / gravação de stock por localização num armazém central: admin sem limite;
 * backoffice/supervisor só nos armazéns cadastrados no utilizador (origem de requisições).
 */
async function usuarioPodeConsultarEstoqueLocalizacaoArmazem(req, armazemId) {
  const id = parseInt(armazemId, 10);
  if (!Number.isFinite(id) || !req.user) return false;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return true;
  const role = req.user.role;
  if (role !== 'backoffice_armazem' && role !== 'supervisor_armazem') return false;
  const allowed = await fetchRequisicoesArmazemIdsForUser(req.user.id);
  if (!allowed.length) return false;
  return allowed.includes(id);
}

/** Listar localizações com stock ao preparar requisição: admin ou armazém de origem permitido ao utilizador. */
function usuarioPodeConsultarStockPreparacaoRequisicao(req, armazemId) {
  const sid = parseInt(armazemId, 10);
  if (!Number.isFinite(sid) || !req.user) return false;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return true;
  const allowed = req.requisicaoArmazemOrigemIds;
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(sid);
}

/** Devolução: origem viatura → destino armazém central (escopo pelo central, não pela viatura). */
function isFluxoDevolucaoViaturaCentral(origemTipo, destTipo) {
  return (
    String(origemTipo || '').trim().toLowerCase() === 'viatura' &&
    String(destTipo || '').trim().toLowerCase() === 'central'
  );
}

/**
 * @param {object} [opts]
 * @param {object} [opts.requisicao] — linha com armazem_id, armazem_origem_tipo, armazem_destino_tipo (ex.: JOIN armazens)
 */
function requisicaoArmazemOrigemAcessoPermitido(req, armazemOrigemId, opts) {
  if (!req.user) return false;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return true;
  const allowed = req.requisicaoArmazemOrigemIds;
  /** Sem armazéns atribuídos ⇒ não acede a requisições (não é “ver tudo”). */
  if (!allowed || allowed.length === 0) return false;
  const rec = opts && opts.requisicao;
  if (
    rec &&
    rec.armazem_id != null &&
    rec.armazem_id !== '' &&
    isFluxoDevolucaoViaturaCentral(rec.armazem_origem_tipo, rec.armazem_destino_tipo)
  ) {
    const did = parseInt(rec.armazem_id, 10);
    if (!Number.isNaN(did)) return allowed.includes(did);
  }
  const sid =
    armazemOrigemId != null && armazemOrigemId !== '' ? parseInt(armazemOrigemId, 10) : NaN;
  if (Number.isNaN(sid)) return false;
  return allowed.includes(sid);
}

/** Utilizadores com escopo por armazém (não admin) sem nenhum armazém de origem atribuído. */
function usuarioEscopadoSemArmazensAtribuidos(req) {
  if (!req.user) return false;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return false;
  const allowed = req.requisicaoArmazemOrigemIds;
  return !allowed || allowed.length === 0;
}

/** Valida scope para exportação multi; lanha se algum id fora dos armazéns permitidos. */
async function assertIdsRequisicoesPermitidas(req, idsRaw) {
  const idsClean = [...new Set((idsRaw || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (idsClean.length === 0) return;
  if (roleComAcessoTotalRequisicoes(req.user.role)) return;
  const allowed = req.requisicaoArmazemOrigemIds;
  if (!allowed || allowed.length === 0) {
    const e = new Error('Nenhum armazém de origem atribuído ao seu utilizador.');
    e.statusCode = 403;
    throw e;
  }
  const bad = await pool.query(
    `SELECT r.id FROM requisicoes r
     LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
     INNER JOIN armazens ad ON r.armazem_id = ad.id
     WHERE r.id = ANY($1::int[])
       AND NOT (
         (r.armazem_origem_id IS NOT NULL AND r.armazem_origem_id = ANY($2::int[]))
         OR (
           LOWER(TRIM(COALESCE(ao.tipo, ''))) = 'viatura'
           AND LOWER(TRIM(COALESCE(ad.tipo, ''))) = 'central'
           AND r.armazem_id = ANY($2::int[])
         )
       )
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
  return [authenticateToken, requisicaoPerfilNegadoMiddleware, requisicaoScopeMiddleware];
}

module.exports = {
  requisicaoScopeMiddleware,
  requisicaoPerfilNegadoMiddleware,
  isFluxoDevolucaoViaturaCentral,
  requisicaoArmazemOrigemAcessoPermitido,
  usuarioEscopadoSemArmazensAtribuidos,
  assertIdsRequisicoesPermitidas,
  createRequisicaoAuth,
  usuarioPodeConsultarEstoqueLocalizacaoArmazem,
  usuarioPodeConsultarStockPreparacaoRequisicao,
  /** Usado no login / verify-token para incluir armazéns de origem no JWT e no utilizador. */
  fetchRequisicoesArmazemIdsForUser,
  /** Introspecção BD para listagem/edição de utilizadores e requisições. */
  usuarioRequisicaoArmazemJunctionTableExists,
  usuariosTemColunaRequisicoesArmazemOrigem,
};
