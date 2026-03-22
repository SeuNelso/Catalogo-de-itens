-- Colunas usadas pela importação de Stock Nacional e pela API /api/itens-nao-cadastrados
ALTER TABLE itens_nao_cadastrados ADD COLUMN IF NOT EXISTS armazens JSONB;
ALTER TABLE itens_nao_cadastrados ADD COLUMN IF NOT EXISTS data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Um código por linha (upsert no login/import)
DELETE FROM itens_nao_cadastrados a
USING itens_nao_cadastrados b
WHERE a.id > b.id AND a.codigo = b.codigo;

CREATE UNIQUE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_codigo_unique ON itens_nao_cadastrados (codigo);
