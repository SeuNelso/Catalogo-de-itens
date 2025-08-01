-- Criar tabela para itens compostos
CREATE TABLE IF NOT EXISTS itens_compostos (
    id SERIAL PRIMARY KEY,
    item_principal_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
    item_componente_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
    quantidade_componente DECIMAL(10,2) DEFAULT 1,
    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_principal_id, item_componente_id)
);

-- Criar índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_compostos_principal ON itens_compostos(item_principal_id);
CREATE INDEX IF NOT EXISTS idx_itens_compostos_componente ON itens_compostos(item_componente_id);

-- Adicionar comentários para documentação
COMMENT ON TABLE itens_compostos IS 'Tabela que relaciona itens principais com seus componentes';
COMMENT ON COLUMN itens_compostos.item_principal_id IS 'ID do item principal (composto)';
COMMENT ON COLUMN itens_compostos.item_componente_id IS 'ID do item componente';
COMMENT ON COLUMN itens_compostos.quantidade_componente IS 'Quantidade do componente necessária para o item principal'; 