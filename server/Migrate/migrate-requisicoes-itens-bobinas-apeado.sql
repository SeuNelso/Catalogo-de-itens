ALTER TABLE requisicoes_itens_bobinas
ADD COLUMN IF NOT EXISTS apeado BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ri_bobinas_apeado
  ON requisicoes_itens_bobinas(requisicao_item_id, apeado);
