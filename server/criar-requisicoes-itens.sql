-- Cria APENAS a tabela requisicoes_itens (use se ela não existir)
-- Requer: tabelas requisicoes e itens já existirem

CREATE TABLE IF NOT EXISTS requisicoes_itens (
  id SERIAL PRIMARY KEY,
  requisicao_id INTEGER NOT NULL REFERENCES requisicoes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requisicao_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_requisicao_id ON requisicoes_itens(requisicao_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_item_id ON requisicoes_itens(item_id);

COMMENT ON TABLE requisicoes_itens IS 'Relacionamento entre requisições e itens';
COMMENT ON COLUMN requisicoes_itens.quantidade IS 'Quantidade do item na requisição';
