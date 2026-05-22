-- Marca quando a TRA foi gerada pela primeira vez
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS tra_gerada_em TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_requisicoes_tra_gerada_em
  ON requisicoes(tra_gerada_em);

