-- Índice btree em serialnumber falha com blobs grandes (>8KB).
-- Seriais vivem em requisicoes_itens_seriais; a coluna agregada fica NULL.
DROP INDEX IF EXISTS idx_requisicoes_itens_serialnumber;

UPDATE requisicoes_itens ri
SET serialnumber = NULL
WHERE serialnumber IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM requisicoes_itens_seriais s WHERE s.requisicao_item_id = ri.id
  );
