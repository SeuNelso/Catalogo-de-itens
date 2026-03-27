/**
 * Smoke test manual da API de integração v1.
 * Uso:
 *   node server/scripts/integration-v1-smoke.js
 *
 * Requer env:
 *   INTEGRATION_BASE_URL=http://localhost:3001/api/integrations/v1
 *   INTEGRATION_CLIENT_ID=...
 *   INTEGRATION_CLIENT_SECRET=...
 */

const baseUrl = process.env.INTEGRATION_BASE_URL || 'http://localhost:3001/api/integrations/v1';
const clientId = process.env.INTEGRATION_CLIENT_ID || '';
const clientSecret = process.env.INTEGRATION_CLIENT_SECRET || '';

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('Defina INTEGRATION_CLIENT_ID e INTEGRATION_CLIENT_SECRET.');
  }

  const tokenResp = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'catalog:read warehouses:read transfers:read'
    })
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok) {
    throw new Error(`Falha token: ${JSON.stringify(tokenData)}`);
  }
  const accessToken = tokenData.access_token;

  const health = await fetch(`${baseUrl}/health`);
  console.log('health:', health.status);

  const items = await fetch(`${baseUrl}/items`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  console.log('items:', items.status);

  const warehouses = await fetch(`${baseUrl}/warehouses`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  console.log('warehouses:', warehouses.status);

  const transfers = await fetch(`${baseUrl}/transfers`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  console.log('transfers:', transfers.status);
}

main().catch((err) => {
  console.error('[integration-v1-smoke] erro:', err.message);
  process.exit(1);
});
