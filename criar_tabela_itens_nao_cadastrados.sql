-- Criar tabela para itens não cadastrados
CREATE TABLE IF NOT EXISTS itens_nao_cadastrados (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  armazens JSONB,
  data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_codigo ON itens_nao_cadastrados(codigo);
CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_data ON itens_nao_cadastrados(data_importacao); 