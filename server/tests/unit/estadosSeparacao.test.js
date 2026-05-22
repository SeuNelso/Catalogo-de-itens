const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { completarSeparacao } = require('../../services/requisicoes/estadosSeparacao');

describe('completarSeparacao', () => {
  it('rejeita quando itens sem preparacao_confirmada', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM requisicoes WHERE')) {
          return { rows: [{ id: 1, status: 'pendente', observacoes: '' }] };
        }
        if (sql.includes('requisicoes_itens')) {
          return { rows: [{ preparacao_confirmada: false }] };
        }
        return { rows: [] };
      },
    };
    await assert.rejects(
      () => completarSeparacao(pool, { requisicaoId: 1, hasRecebimentoMarker: () => false }),
      (err) => err.status === 400
    );
  });

  it('recebimento transferência → EM EXPEDICAO', async () => {
    const updates = [];
    const pool = {
      query: async (sql, params) => {
        if (sql.includes('FROM requisicoes WHERE')) {
          return { rows: [{ id: 1, status: 'pendente', observacoes: 'RECEBIMENTO_TRANSFERENCIA_V1' }] };
        }
        if (sql.includes('requisicoes_itens')) {
          return { rows: [{ preparacao_confirmada: true }] };
        }
        if (sql.startsWith('UPDATE requisicoes SET status')) {
          updates.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    await completarSeparacao(pool, {
      requisicaoId: 1,
      hasRecebimentoMarker: (r) => String(r.observacoes || '').startsWith('RECEBIMENTO_TRANSFERENCIA_V1'),
    });
    assert.deepEqual(updates[0], ['EM EXPEDICAO', 1]);
  });
});
