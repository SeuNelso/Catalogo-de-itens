-- Script para migrar setores para suportar múltiplos valores
-- Execute este script no seu banco PostgreSQL

-- 1. Criar nova tabela para setores dos itens
CREATE TABLE IF NOT EXISTS itens_setores (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  setor TEXT NOT NULL,
  data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Migrar dados existentes da coluna setor para a nova tabela
INSERT INTO itens_setores (item_id, setor)
SELECT id, setor 
FROM itens 
WHERE setor IS NOT NULL AND setor != '';

-- 3. Adicionar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_itens_setores_item_id ON itens_setores(item_id);
CREATE INDEX IF NOT EXISTS idx_itens_setores_setor ON itens_setores(setor);

-- 4. Remover a coluna setor antiga (opcional - execute apenas se tiver certeza)
-- ALTER TABLE itens DROP COLUMN IF EXISTS setor;

-- 5. Verificar a migração
SELECT 
  i.id,
  i.codigo,
  i.nome,
  STRING_AGG(is2.setor, ', ') as setores
FROM itens i
LEFT JOIN itens_setores is2 ON i.id = is2.item_id
GROUP BY i.id, i.codigo, i.nome
LIMIT 10;
