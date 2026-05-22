-- Script para criar tabela de requisições
-- Execute este script no banco de dados PostgreSQL

-- Tabela de requisições
CREATE TABLE IF NOT EXISTS requisicoes (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  armazem_destino VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'pendente' CHECK (status IN ('pendente', 'atendida', 'cancelada')),
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_requisicoes_item_id ON requisicoes(item_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_status ON requisicoes(status);
CREATE INDEX IF NOT EXISTS idx_requisicoes_usuario_id ON requisicoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_destino ON requisicoes(armazem_destino);
CREATE INDEX IF NOT EXISTS idx_requisicoes_created_at ON requisicoes(created_at);

-- Trigger para atualizar updated_at automaticamente
CREATE TRIGGER update_requisicoes_updated_at BEFORE UPDATE ON requisicoes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comentários
COMMENT ON TABLE requisicoes IS 'Tabela de requisições de itens para armazéns';
COMMENT ON COLUMN requisicoes.item_id IS 'Referência ao item requisitado';
COMMENT ON COLUMN requisicoes.quantidade IS 'Quantidade requisitada';
COMMENT ON COLUMN requisicoes.armazem_destino IS 'Armazém de destino da requisição';
COMMENT ON COLUMN requisicoes.status IS 'Status da requisição: pendente, atendida ou cancelada';
COMMENT ON COLUMN requisicoes.usuario_id IS 'Usuário que criou a requisição';
