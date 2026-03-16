ALTER TABLE requisicoes_itens
  ADD COLUMN IF NOT EXISTS lote VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_lote
  ON requisicoes_itens(lote);

