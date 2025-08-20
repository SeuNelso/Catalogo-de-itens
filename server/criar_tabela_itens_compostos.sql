-- Criar tabela itens_compostos se não existir
CREATE TABLE IF NOT EXISTS itens_compostos (
    id SERIAL PRIMARY KEY,
    item_principal_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
    item_componente_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
    quantidade_componente DECIMAL(10,2) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Garantir que um item não pode ser componente de si mesmo
    CONSTRAINT check_self_component CHECK (item_principal_id != item_componente_id),
    
    -- Garantir que quantidade é positiva
    CONSTRAINT check_positive_quantity CHECK (quantidade_componente > 0)
);

-- Criar índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_compostos_principal ON itens_compostos(item_principal_id);
CREATE INDEX IF NOT EXISTS idx_itens_compostos_componente ON itens_compostos(item_componente_id);
CREATE INDEX IF NOT EXISTS idx_itens_compostos_unique ON itens_compostos(item_principal_id, item_componente_id);

-- Criar trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_itens_compostos_updated_at 
    BEFORE UPDATE ON itens_compostos 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Verificar se a tabela foi criada
SELECT 'Tabela itens_compostos criada com sucesso!' as status;
SELECT COUNT(*) as total_registros FROM itens_compostos;

