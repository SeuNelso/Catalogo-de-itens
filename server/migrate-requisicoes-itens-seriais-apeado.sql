ALTER TABLE requisicoes_itens_seriais
ADD COLUMN IF NOT EXISTS apeado BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_seriais_apeado
  ON requisicoes_itens_seriais (requisicao_item_id, apeado, ordem, id);
