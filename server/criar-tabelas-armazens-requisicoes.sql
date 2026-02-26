-- Execute este script INTEIRO no DBeaver
-- Menu: SQL Editor → Execute → Execute SQL Script (Ctrl+Shift+Enter)
-- Ou: selecione TUDO (Ctrl+A) e Execute Script

-- 1. Função
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Tabela armazens
CREATE TABLE IF NOT EXISTS armazens (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(50) NOT NULL UNIQUE,
  descricao VARCHAR(255) NOT NULL,
  localizacao TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_armazens_updated_at ON armazens;
CREATE TRIGGER update_armazens_updated_at BEFORE UPDATE ON armazens
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- 2b. Tabela de localizações do armazém (múltiplas por armazém)
CREATE TABLE IF NOT EXISTS armazens_localizacoes (
  id SERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_armazens_localizacoes_armazem_id ON armazens_localizacoes(armazem_id);

-- 3. Tabela requisicoes (requer: usuarios e armazens existirem)
CREATE TABLE IF NOT EXISTS requisicoes (
  id SERIAL PRIMARY KEY,
  armazem_origem_id INTEGER REFERENCES armazens(id) ON DELETE SET NULL,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE RESTRICT,
  localizacao TEXT,
  status VARCHAR(50) DEFAULT 'pendente' CHECK (status IN ('pendente', 'atendida', 'cancelada')),
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_requisicoes_updated_at ON requisicoes;
CREATE TRIGGER update_requisicoes_updated_at BEFORE UPDATE ON requisicoes
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- 4. Tabela requisicoes_itens (requer: requisicoes e itens existirem)
CREATE TABLE IF NOT EXISTS requisicoes_itens (
  id SERIAL PRIMARY KEY,
  requisicao_id INTEGER NOT NULL REFERENCES requisicoes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  quantidade_preparada INTEGER DEFAULT 0,
  localizacao_origem VARCHAR(255),
  localizacao_destino VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requisicao_id, item_id)
);

ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS quantidade_preparada INTEGER DEFAULT 0;
ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS localizacao_origem VARCHAR(255);
ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS localizacao_destino VARCHAR(255);

-- 5. Índices
CREATE INDEX IF NOT EXISTS idx_armazens_ativo ON armazens(ativo);
CREATE INDEX IF NOT EXISTS idx_armazens_codigo ON armazens(codigo);
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_id ON requisicoes(armazem_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_origem_id ON requisicoes(armazem_origem_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_status ON requisicoes(status);
CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_requisicao_id ON requisicoes_itens(requisicao_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_item_id ON requisicoes_itens(item_id);

-- 6. Dados iniciais
INSERT INTO armazens (codigo, descricao, localizacao) VALUES
  ('V848', 'BBCH06', NULL),
  ('V100', 'Armazém Norte', NULL),
  ('V101', 'Armazém Sul', NULL),
  ('V102', 'Armazém Leste', NULL),
  ('V103', 'Armazém Oeste', NULL)
ON CONFLICT (codigo) DO NOTHING;
