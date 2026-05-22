-- Alinha com init-db.sql: colunas de tempo e triggers update_*_updated_at.
-- itens / itens_nao_cadastrados: created_at + updated_at
-- itens_compostos: só updated_at se existir trigger legado (init-db original só tinha created_at)
ALTER TABLE itens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE itens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE itens_nao_cadastrados ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE itens_nao_cadastrados ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE itens_compostos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
