ALTER TABLE requisicoes_itens
  ADD COLUMN IF NOT EXISTS serialnumber VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_serialnumber
  ON requisicoes_itens(serialnumber);

