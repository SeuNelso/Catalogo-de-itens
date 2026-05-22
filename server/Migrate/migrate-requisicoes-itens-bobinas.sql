CREATE TABLE IF NOT EXISTS requisicoes_itens_bobinas (
  id SERIAL PRIMARY KEY,
  requisicao_item_id INTEGER NOT NULL REFERENCES requisicoes_itens(id) ON DELETE CASCADE,
  lote VARCHAR(100) NOT NULL,
  serialnumber VARCHAR(100),
  metros NUMERIC(12,3) NOT NULL CHECK (metros > 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ri_bobinas_requisicao_item_id
  ON requisicoes_itens_bobinas(requisicao_item_id);

