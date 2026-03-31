const { pool } = require('../db/pool');

let _cachePodeControloStock = null;
let _cachePodeConsultaMovimentos = null;

/** Coluna usuarios.pode_controlo_stock (migração migrate-usuarios-pode-controlo-stock.sql). */
async function usuariosTemColunaPodeControloStock() {
  if (_cachePodeControloStock !== null) return _cachePodeControloStock;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'pode_controlo_stock'
       LIMIT 1`,
    );
    _cachePodeControloStock = r.rows.length > 0;
  } catch (err) {
    console.error('[DB] Falha ao verificar coluna pode_controlo_stock:', err.message);
    _cachePodeControloStock = false;
  }
  return _cachePodeControloStock;
}

/** Coluna usuarios.pode_consulta_movimentos (migração migrate-usuarios-pode-consulta-movimentos.sql). */
async function usuariosTemColunaPodeConsultaMovimentos() {
  if (_cachePodeConsultaMovimentos === true) return true;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'pode_consulta_movimentos'
       LIMIT 1`,
    );
    if (r.rows.length > 0) {
      _cachePodeConsultaMovimentos = true;
      return true;
    }
  } catch (err) {
    console.error('[DB] Falha ao verificar coluna pode_consulta_movimentos:', err.message);
  }
  return false;
}

/** Sem bypass por role: só utiliza flag no utilizador (JWT sincronizado com BD). */
function usuarioTemPermissaoControloStock(req) {
  if (!req || !req.user) return false;
  return req.user.pode_controlo_stock === true;
}

/** Sem bypass por role: só utiliza flag no utilizador (JWT sincronizado com BD). */
function usuarioTemPermissaoConsultaMovimentos(req) {
  if (!req || !req.user) return false;
  return req.user.pode_consulta_movimentos === true;
}

let _cacheMovInt = null;

/** Tabela armazem_movimentacao_interna (tickets / fila TRFL). */
async function armazemMovimentacaoInternaTableExists() {
  if (_cacheMovInt !== null) return _cacheMovInt;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'armazem_movimentacao_interna' LIMIT 1`,
    );
    _cacheMovInt = r.rows.length > 0;
  } catch (err) {
    console.error('[DB] Falha ao verificar tabela armazem_movimentacao_interna:', err.message);
    _cacheMovInt = false;
  }
  return _cacheMovInt;
}

module.exports = {
  usuariosTemColunaPodeControloStock,
  usuariosTemColunaPodeConsultaMovimentos,
  usuarioTemPermissaoControloStock,
  usuarioTemPermissaoConsultaMovimentos,
  armazemMovimentacaoInternaTableExists,
};
