-- Script de inicialização do banco de dados
-- Execute este script após criar o banco de dados PostgreSQL

-- Tabela de usuários (usa username/password para login)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255),
  numero_colaborador VARCHAR(100) UNIQUE,
  role VARCHAR(50) DEFAULT 'usuario' CHECK (role IN ('admin', 'controller', 'usuario')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de itens
CREATE TABLE IF NOT EXISTS itens (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(100) UNIQUE NOT NULL,
  descricao TEXT NOT NULL,
  familia VARCHAR(255),
  subfamilia VARCHAR(255),
  quantidade INTEGER DEFAULT 0,
  categoria VARCHAR(255),
  tipo_controle VARCHAR(50),
  unidade_armazenamento VARCHAR(50),
  dimensoes VARCHAR(255),
  peso DECIMAL(10, 2),
  observacoes TEXT,
  ativo BOOLEAN DEFAULT true,
  composto BOOLEAN DEFAULT false,
  imagem_completa_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de setores dos itens (relação muitos-para-muitos)
CREATE TABLE IF NOT EXISTS itens_setores (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  setor VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de imagens dos itens
CREATE TABLE IF NOT EXISTS imagens_itens (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  ordem INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de itens compostos (componentes)
CREATE TABLE IF NOT EXISTS itens_compostos (
  id SERIAL PRIMARY KEY,
  item_pai_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  item_componente_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_pai_id, item_componente_id)
);

-- Tabela de itens não cadastrados (sincronização)
CREATE TABLE IF NOT EXISTS itens_nao_cadastrados (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(100) NOT NULL,
  descricao TEXT,
  setor VARCHAR(100),
  quantidade INTEGER DEFAULT 0,
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_codigo ON itens(codigo);
CREATE INDEX IF NOT EXISTS idx_itens_ativo ON itens(ativo);
CREATE INDEX IF NOT EXISTS idx_itens_setores_item_id ON itens_setores(item_id);
CREATE INDEX IF NOT EXISTS idx_imagens_itens_item_id ON imagens_itens(item_id);
CREATE INDEX IF NOT EXISTS idx_itens_compostos_pai ON itens_compostos(item_pai_id);
CREATE INDEX IF NOT EXISTS idx_itens_compostos_componente ON itens_compostos(item_componente_id);
CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_codigo ON itens_nao_cadastrados(codigo);

-- Função para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para atualizar updated_at
CREATE TRIGGER update_usuarios_updated_at BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_itens_updated_at BEFORE UPDATE ON itens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_itens_nao_cadastrados_updated_at BEFORE UPDATE ON itens_nao_cadastrados
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Inserir usuário administrador padrão (senha: admin123)
-- ALTERE A SENHA APÓS O PRIMEIRO LOGIN!
-- Hash bcrypt de 'admin123'
INSERT INTO usuarios (nome, username, email, password, role) 
VALUES ('Administrador', 'admin', 'admin@catalogo.com', '$2a$10$rOzJqJqJqJqJqJqJqJqJqOqJqJqJqJqJqJqJqJqJqJqJqJqJqJqJq', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Comentários das tabelas
COMMENT ON TABLE usuarios IS 'Tabela de usuários do sistema';
COMMENT ON TABLE itens IS 'Tabela principal de itens do catálogo';
COMMENT ON TABLE itens_setores IS 'Relação muitos-para-muitos entre itens e setores';
COMMENT ON TABLE imagens_itens IS 'Imagens associadas aos itens';
COMMENT ON TABLE itens_compostos IS 'Componentes de itens compostos';
COMMENT ON TABLE itens_nao_cadastrados IS 'Itens temporários aguardando cadastro';
