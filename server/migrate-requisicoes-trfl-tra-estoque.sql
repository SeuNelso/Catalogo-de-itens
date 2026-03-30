-- Idempotência do stock na TRFL/TRA (requisições com origem central + armazens_localizacao_item).
-- Execute: npm run db:migrate:requisicoes-trfl-tra-estoque

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS trfl_estoque_aplicado_em TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS tra_baixa_expedicao_aplicada_em TIMESTAMPTZ NULL;

COMMENT ON COLUMN requisicoes.trfl_estoque_aplicado_em IS
  'Regista quando foi aplicado o movimento de stock prateleira → EXPEDICAO na primeira geração de TRFL (fluxo normal).';
COMMENT ON COLUMN requisicoes.tra_baixa_expedicao_aplicada_em IS
  'Regista quando foi aplicada a baixa na EXPEDICAO (e eventual entrada no destino central) na primeira geração de TRA.';
