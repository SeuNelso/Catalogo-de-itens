-- Baseline de stock na zona de receção após «limpar» admin: o monitor só mostra entradas desde o snapshot.
ALTER TABLE armazens
  ADD COLUMN IF NOT EXISTS monitor_rececao_baseline JSONB NULL;

ALTER TABLE armazens
  ADD COLUMN IF NOT EXISTS monitor_rececao_limpo_em TIMESTAMPTZ NULL;

COMMENT ON COLUMN armazens.monitor_rececao_baseline IS
  'Snapshot { recebimento: {COD: qtd}, apeados: {COD: qtd} } ao limpar a card; o monitor exibe apenas stock acima deste baseline.';

COMMENT ON COLUMN armazens.monitor_rececao_limpo_em IS
  'Momento do último limpar da zona de receção (admin/teste).';
