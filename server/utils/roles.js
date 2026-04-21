/**
 * Perfis: coluna `usuarios.role` (minúsculas), alinhada a migrate-usuarios-roles-novos.sql.
 *
 * ADMIN — valor `admin`: acesso sem limites ao sistema nas verificações de API e UI que
 * usam isAdmin() ou `role === 'admin'`. Inclui gestão de utilizadores, importações
 * restritas, operações destrutivas e ignora filtros de armazém/requisição onde o código
 * trata admin como exceção. Outros perfis têm permissões por rota/tela.
 */

const ROLES = Object.freeze({
  ADMIN: 'admin',
  CONTROLLER: 'controller',
  ANALISTA: 'analista',
  USUARIO: 'usuario',
  BASICO: 'basico',
  BACKOFFICE_OPERATIONS: 'backoffice_operations',
  BACKOFFICE_ARMAZEM: 'backoffice_armazem',
  SUPERVISOR_ARMAZEM: 'supervisor_armazem',
  OPERADOR: 'operador',
});

const ROLES_VALIDOS = Object.values(ROLES);

function isAdmin(role) {
  return role === ROLES.ADMIN;
}

function isOperador(role) {
  return role === ROLES.OPERADOR;
}

function isSupervisorArmazem(role) {
  return role === ROLES.SUPERVISOR_ARMAZEM;
}

/** Sinónimo de isAdmin — “acesso total” na documentação de negócio. */
function hasUnrestrictedSystemAccess(role) {
  return isAdmin(role);
}

module.exports = {
  ROLES,
  ROLES_VALIDOS,
  isAdmin,
  isOperador,
  isSupervisorArmazem,
  hasUnrestrictedSystemAccess,
};
