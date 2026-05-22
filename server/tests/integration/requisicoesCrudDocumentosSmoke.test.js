const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadTestEnv } = require('../helpers/loadTestEnv');

loadTestEnv();

/** Smoke HTTP: rotas montadas via crud.js e documentos.js respondem sem 500 de arranque. */
describe('Requisições — smoke CRUD/documentos', () => {
  let app;

  before(() => {
    const { createTestApp } = require('../helpers/createTestApp');
    app = createTestApp();
  });

  it('GET /api/requisicoes/ sem token → 401', async () => {
    const res = await request(app).get('/api/requisicoes/');
    assert.equal(res.status, 401);
  });

  it('GET /api/requisicoes/1/export-excel sem token → 401', async () => {
    const res = await request(app).get('/api/requisicoes/1/export-excel');
    assert.equal(res.status, 401);
  });
});
