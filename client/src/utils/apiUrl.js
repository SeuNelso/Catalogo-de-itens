/**
 * URL absoluta para pedidos à API. Em desenvolvimento, o CRA faz proxy de /api
 * para o servidor (client/package.json → proxy). Se o proxy falhar, defina no client:
 *   REACT_APP_API_URL=http://localhost:3001
 * (reiniciar npm start)
 */
export function apiUrl(path) {
  const base = String(process.env.REACT_APP_API_URL || '').replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}
