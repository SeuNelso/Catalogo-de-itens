BEGIN;

ALTER TABLE requisicoes_itens
  ADD COLUMN IF NOT EXISTS observacoes TEXT;

COMMIT;
