-- Regista data/hora real de finalização da requisição
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS finalizado_em TIMESTAMPTZ;

COMMENT ON COLUMN requisicoes.finalizado_em IS
  'Data/hora em que a requisição foi marcada como FINALIZADO';
