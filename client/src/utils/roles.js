/**
 * Perfis (JWT / `usuarios.role`). Manter alinhado a `server/utils/roles.js`.
 *
 * ADMIN (`admin`): acesso sem limites onde a UI verifica `user.role === 'admin'` ou isAdmin().
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  CONTROLLER: 'controller',
  USUARIO: 'usuario',
  BASICO: 'basico',
  BACKOFFICE_OPERATIONS: 'backoffice_operations',
  BACKOFFICE_ARMAZEM: 'backoffice_armazem',
  SUPERVISOR_ARMAZEM: 'supervisor_armazem',
  OPERADOR: 'operador',
});

export function isAdmin(role) {
  return role === ROLES.ADMIN;
}

export function isOperador(role) {
  return role === ROLES.OPERADOR;
}

export function isSupervisorArmazem(role) {
  return role === ROLES.SUPERVISOR_ARMAZEM;
}

/**
 * TRFL, TRA, Reporte, Clog, marcar em expedição, finalizar — não permitido ao operador.
 * `backoffice_armazem` e restantes não-operadores: true (inclui gestão completa de requisição além do operador).
 */
export function operadorPodeDocsELogisticaAposSeparacao(role) {
  return !isOperador(role);
}

/** Perfis que podem usar o módulo de requisições (UI e âmbito alinhados à API). */
export const ROLES_COM_ACESSO_REQUISICOES = Object.freeze([
  ROLES.ADMIN,
  ROLES.USUARIO,
  ROLES.BACKOFFICE_OPERATIONS,
  ROLES.BACKOFFICE_ARMAZEM,
  ROLES.SUPERVISOR_ARMAZEM,
  ROLES.OPERADOR,
]);

export function podeAcederRequisicoes(role) {
  return Boolean(role && ROLES_COM_ACESSO_REQUISICOES.includes(role));
}

/** Opções do select em AdminUsuarios (valor = coluna role). */
export const ROLE_OPTIONS = [
  { value: ROLES.ADMIN, label: 'Administrador (ADMIN)' },
  { value: ROLES.CONTROLLER, label: 'Controller' },
  { value: ROLES.BACKOFFICE_OPERATIONS, label: 'BACKOFFICE OPERATIONS' },
  { value: ROLES.BACKOFFICE_ARMAZEM, label: 'BACKOFFICE ARMAZEM' },
  { value: ROLES.SUPERVISOR_ARMAZEM, label: 'Supervisor armazém' },
  { value: ROLES.OPERADOR, label: 'OPERADOR' },
  { value: ROLES.BASICO, label: 'Básico' },
  { value: ROLES.USUARIO, label: 'Usuário' },
];

/** Rótulo na UI; na base `usuarios.role` guarda o código (ex.: supervisor_armazem). */
export function roleLabel(role) {
  if (role == null || role === '') return '—';
  const o = ROLE_OPTIONS.find((r) => r.value === role);
  return o ? o.label : String(role);
}
