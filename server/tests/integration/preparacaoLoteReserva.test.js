const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadTestEnv } = require('../helpers/loadTestEnv');

loadTestEnv();

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe('PATCH atender-item — reserva LOTE', { skip: !hasDb ? 'TEST_DATABASE_URL não definido' : false }, () => {
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

  it('bobinas reservam metros em stock_lote', async () => {
    const {
      requireStockTables,
      seedLotePreparacaoScenario,
      getStockLoteRow,
    } = require('../helpers/dbFixture');
    const { authHeader } = require('../helpers/auth');
    const client = await pool.connect();
    try {
      await requireStockTables(client);
      const fx = await seedLotePreparacaoScenario(client);
      global.__lastFx = fx;

      const res = await request(app)
        .patch(`/api/requisicoes/${fx.requisicaoId}/atender-item`)
        .set(authHeader(token))
        .send({
          requisicao_item_id: fx.requisicaoItemId,
          quantidade_preparada: 30,
          localizacao_origem: fx.loc,
          bobinas: [{ lote: fx.lote, metros: 30 }],
        });

      assert.equal(res.status, 200, JSON.stringify(res.body));

      const row = await getStockLoteRow(client, {
        itemId: fx.itemId,
        armazemId: fx.armOrigemId,
        localizacao: fx.loc,
        lote: fx.lote,
      });
      assert.ok(row);
      assert.equal(Number(row.quantidade_disponivel), 70);
      assert.equal(Number(row.quantidade_reservada), 30);
    } finally {
      client.release();
    }
  });

  it('re-preparar libera e reaplica reserva', async () => {
    const { seedLotePreparacaoScenario, getStockLoteRow } = require('../helpers/dbFixture');
    const { authHeader } = require('../helpers/auth');
    const client = await pool.connect();
    try {
      const fx = await seedLotePreparacaoScenario(client);
      global.__lastFx = fx;

      await request(app)
        .patch(`/api/requisicoes/${fx.requisicaoId}/atender-item`)
        .set(authHeader(token))
        .send({
          requisicao_item_id: fx.requisicaoItemId,
          quantidade_preparada: 20,
          localizacao_origem: fx.loc,
          bobinas: [{ lote: fx.lote, metros: 20 }],
        });

      await request(app)
        .patch(`/api/requisicoes/${fx.requisicaoId}/atender-item`)
        .set(authHeader(token))
        .send({
          requisicao_item_id: fx.requisicaoItemId,
          quantidade_preparada: 40,
          localizacao_origem: fx.loc,
          bobinas: [{ lote: fx.lote, metros: 40 }],
        });

      const row = await getStockLoteRow(client, {
        itemId: fx.itemId,
        armazemId: fx.armOrigemId,
        localizacao: fx.loc,
        lote: fx.lote,
      });
      assert.equal(Number(row.quantidade_disponivel), 60);
      assert.equal(Number(row.quantidade_reservada), 40);
    } finally {
      client.release();
    }
  });
});
