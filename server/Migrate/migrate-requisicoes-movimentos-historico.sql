-- Snapshot persistido das linhas da Consulta de movimentos (Clog), para alta escala.
CREATE TABLE IF NOT EXISTS requisicoes_movimentos_historico (
  id BIGSERIAL PRIMARY KEY,
  mov_key TEXT NOT NULL UNIQUE,
  requisicao_id INTEGER NULL,
  row_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_req_mov_hist_req_id
  ON requisicoes_movimentos_historico (requisicao_id);
