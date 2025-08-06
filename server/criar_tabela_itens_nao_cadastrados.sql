-- Criar tabela itens_nao_cadastrados se não existir
CREATE TABLE IF NOT EXISTS itens_nao_cadastrados (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(255) NOT NULL UNIQUE,
    descricao TEXT NOT NULL,
    armazens JSONB DEFAULT '{}',
    data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_codigo ON itens_nao_cadastrados(codigo);
CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_data ON itens_nao_cadastrados(data_importacao);

-- Inserir alguns dados de exemplo (opcional)
INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens) VALUES
('TEST001', 'Item de teste 1', '{"Armazém A": 10, "Armazém B": 5}'),
('TEST002', 'Item de teste 2', '{"Armazém A": 15}'),
('TEST003', 'Item de teste 3', '{}');

-- Verificar se a tabela foi criada
SELECT 'Tabela itens_nao_cadastrados criada com sucesso!' as status;
SELECT COUNT(*) as total_registros FROM itens_nao_cadastrados; 