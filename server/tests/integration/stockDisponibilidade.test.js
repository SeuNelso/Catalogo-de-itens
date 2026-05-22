const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadTestEnv } = require('../helpers/loadTestEnv');

loadTestEnv();

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe('GET stock/disponibilidade', { skip: !hasDb ? 'TEST_DATABASE_URL não definido' : false }, () => {
  let app;
  let pool;
  let token;

  before(async () => {
    if (!hasDb) return;
    const helpers = require('../helpers/createTestApp');
    app = helpers.createTestApp();
    pool = helpers.pool;
    const { signTestToken } = require('../helpers/auth');
    token = signTestToken({ role: 'admin', id: 1 });
  });

  afterEach(async () => {
    if (!pool || !global.__lastFx) return;
    const client = await pool.connect();
    try {
      const { cleanupLotePreparacaoScenario } = require('../helpers/dbFixture');
      await cleanupLotePreparacaoScenario(client, global.__lastFx);
    } finally {
      client.release();
      global.__lastFx = null;
    }
  });

  it('devolve lotes com disponivel e reservada', async () => {
    const { requireStockTables, seedLotePreparacaoScenario } = require('../helpers/dbFixture');
    const { authHeader } = require('../helpers/auth');
    const client = await pool.connect();
    try {
      await requireStockTables(client);
      const fx = await seedLotePreparacaoScenario(client);
      global.__lastFx = fx;

      const res = await request(app)
        .get('/api/requisicoes/stock/disponibilidade')
        .query({ item_id: fx.itemId, armazem_id: fx.armOrigemId, localizacao: fx.loc })
        .set(authHeader(token));

      assert.equal(res.status, 200);
      const lotes = res.body.lotes || [];
      const hit = lotes.find((l) => String(l.lote).toUpperCase() === fx.lote.toUpperCase());
      assert.ok(hit, 'lote esperado na resposta');
      assert.equal(Number(hit.quantidade_disponivel), 100);
      assert.equal(Number(hit.quantidade_reservada), 0);
    } finally {
      client.release();
    }
  });
});
