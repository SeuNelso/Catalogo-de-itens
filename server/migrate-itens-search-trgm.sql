-- Pesquisas ILIKE %termo% mais rápidas (PostgreSQL pg_trgm)
-- Execute: npm run db:migrate:itens-trgm
-- Em alguns hosts é preciso permissão de superuser para CREATE EXTENSION

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_itens_codigo_trgm ON itens USING gin (codigo gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_itens_nome_trgm ON itens USING gin (nome gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_itens_familia_trgm ON itens USING gin (familia gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_itens_subfamilia_trgm ON itens USING gin (subfamilia gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_itens_setores_setor_trgm ON itens_setores USING gin (setor gin_trgm_ops);

ANALYZE itens;

ANALYZE itens_setores;
