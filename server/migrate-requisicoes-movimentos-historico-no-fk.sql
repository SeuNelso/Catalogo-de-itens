-- Remove dependência direta com requisicoes para preservar histórico após delete.
-- Mantido sem bloco DO $$ para compatibilidade com o run-migration.js (split por ';').
ALTER TABLE requisicoes_movimentos_historico
  DROP CONSTRAINT IF EXISTS requisicoes_movimentos_historico_requisicao_id_fkey;

ALTER TABLE requisicoes_movimentos_historico
  ALTER COLUMN requisicao_id DROP NOT NULL;
