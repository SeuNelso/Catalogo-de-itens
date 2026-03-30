const { pool } = require('../db/pool');

let _cachePodeControloStock = null;

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

/** Admin: sempre. Outros: flag no utilizador (JWT / req.user). */
function usuarioTemPermissaoControloStock(req) {
  if (!req || !req.user) return false;
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'supervisor_armazem') return true;
  return req.user.pode_controlo_stock === true;
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
  usuarioTemPermissaoControloStock,
  armazemMovimentacaoInternaTableExists,
};
