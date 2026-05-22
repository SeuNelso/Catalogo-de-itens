-- Script para criar tabelas de armazéns e atualizar sistema de requisições
-- Execute este script no banco de dados PostgreSQL

-- Função para updated_at (criar se não existir)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 1. Tabela de Armazéns
-- ============================================
-- ID do armazém = código da viatura que a requisição vai atender (ex: V848)
-- Descrição = identificação do armazém (ex: BBCH06). Exibição: "V848 - BBCH06"
CREATE TABLE IF NOT EXISTS armazens (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(50) NOT NULL UNIQUE,
  descricao VARCHAR(255) NOT NULL,
  localizacao TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para armazéns
CREATE INDEX IF NOT EXISTS idx_armazens_ativo ON armazens(ativo);
CREATE INDEX IF NOT EXISTS idx_armazens_codigo ON armazens(codigo);

-- Tabela de localizações do armazém (múltiplas por armazém)
CREATE TABLE IF NOT EXISTS armazens_localizacoes (
  id SERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_armazens_localizacoes_armazem_id ON armazens_localizacoes(armazem_id);
CREATE INDEX IF NOT EXISTS idx_armazens_descricao ON armazens(descricao);

-- Trigger para atualizar updated_at
CREATE TRIGGER update_armazens_updated_at BEFORE UPDATE ON armazens
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ============================================
-- 2. Tabela de requisições
-- ============================================
-- Fluxo: 1) Criar (origem, itens, destino) 2) Preparar/Atender (localização)
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

-- ============================================
-- 3. Tabela de relacionamento Requisições-Itens
-- ============================================
CREATE TABLE IF NOT EXISTS requisicoes_itens (
  id SERIAL PRIMARY KEY,
  requisicao_id INTEGER NOT NULL REFERENCES requisicoes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requisicao_id, item_id)
);

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_id ON requisicoes(armazem_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_origem_id ON requisicoes(armazem_origem_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_status ON requisicoes(status);
CREATE INDEX IF NOT EXISTS idx_requisicoes_usuario_id ON requisicoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_created_at ON requisicoes(created_at);
CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_requisicao_id ON requisicoes_itens(requisicao_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_item_id ON requisicoes_itens(item_id);

-- Trigger para atualizar updated_at
CREATE TRIGGER update_requisicoes_updated_at BEFORE UPDATE ON requisicoes
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ============================================
-- 4. Comentários
-- ============================================
COMMENT ON TABLE armazens IS 'Tabela de armazéns (viaturas) cadastrados no sistema';
COMMENT ON COLUMN armazens.codigo IS 'Código da viatura (ex: V848) - identificador do armazém';
COMMENT ON COLUMN armazens.descricao IS 'Descrição do armazém (ex: BBCH06). Exibição: codigo - descricao';
COMMENT ON TABLE requisicoes IS 'Tabela de requisições de itens para armazéns';
COMMENT ON TABLE requisicoes_itens IS 'Relacionamento muitos-para-muitos entre requisições e itens';
COMMENT ON COLUMN requisicoes.armazem_origem_id IS 'Armazém de origem (etapa 1 - criação)';
COMMENT ON COLUMN requisicoes.armazem_id IS 'Armazém de destino (etapa 1 - criação)';
COMMENT ON COLUMN requisicoes.localizacao IS 'Localização no destino (etapa 2 - preparação/atendimento)';
COMMENT ON COLUMN requisicoes_itens.quantidade IS 'Quantidade do item na requisição';

-- ============================================
-- 5. Dados iniciais (opcional)
-- ============================================
INSERT INTO armazens (codigo, descricao, localizacao) VALUES
  ('V848', 'BBCH06', NULL),
  ('V100', 'Armazém Norte', NULL),
  ('V101', 'Armazém Sul', NULL),
  ('V102', 'Armazém Leste', NULL),
  ('V103', 'Armazém Oeste', NULL)
ON CONFLICT (codigo) DO NOTHING;
