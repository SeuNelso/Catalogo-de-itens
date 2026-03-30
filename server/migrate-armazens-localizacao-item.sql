-- Estoque por localização: quantidades de artigos por linha em armazens_localizacoes

CREATE TABLE IF NOT EXISTS armazens_localizacao_item (
  id SERIAL PRIMARY KEY,
  localizacao_id INTEGER NOT NULL REFERENCES armazens_localizacoes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(localizacao_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_armazens_localizacao_item_loc ON armazens_localizacao_item(localizacao_id);
CREATE INDEX IF NOT EXISTS idx_armazens_localizacao_item_item ON armazens_localizacao_item(item_id);

COMMENT ON TABLE armazens_localizacao_item IS 'Controlo de stock: quantidade por item por localização (uso previsto: armazéns centrais; a API restringe a tipo central)';
