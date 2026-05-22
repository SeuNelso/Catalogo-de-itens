-- Regista data/hora real de entrega da requisição
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS entregue_em TIMESTAMPTZ;

COMMENT ON COLUMN requisicoes.entregue_em IS
  'Data/hora em que a requisição foi marcada como Entregue';
