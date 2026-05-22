ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS cancelada_em_expedicao BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMP NULL;

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS cancelada_por_usuario_id INTEGER NULL REFERENCES usuarios(id);

CREATE INDEX IF NOT EXISTS idx_requisicoes_cancelada_em_expedicao
  ON requisicoes (cancelada_em_expedicao);

CREATE INDEX IF NOT EXISTS idx_requisicoes_cancelada_por_usuario_id
  ON requisicoes (cancelada_por_usuario_id);
