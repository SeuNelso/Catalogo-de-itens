-- Overrides administrativos para linhas da Consulta de movimentos (Clog).
CREATE TABLE IF NOT EXISTS requisicoes_movimentos_overrides (
  id SERIAL PRIMARY KEY,
  mov_key TEXT NOT NULL UNIQUE,
  patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted BOOLEAN NOT NULL DEFAULT false,
  updated_by INTEGER NULL REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_req_mov_overrides_mov_key
  ON requisicoes_movimentos_overrides (mov_key);
