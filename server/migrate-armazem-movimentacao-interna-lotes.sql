-- Rastreabilidade de lotes movidos por ticket de movimentação interna (TRFL / TRA APEADO).

CREATE TABLE IF NOT EXISTS armazem_movimentacao_interna_lotes (
  id BIGSERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES armazem_movimentacao_interna(id) ON DELETE CASCADE,
  lote TEXT NOT NULL,
  quantidade NUMERIC(18, 4) NOT NULL CHECK (quantidade > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ami_lotes_ticket_lote
  ON armazem_movimentacao_interna_lotes (ticket_id, lote);

CREATE INDEX IF NOT EXISTS idx_ami_lotes_ticket
  ON armazem_movimentacao_interna_lotes (ticket_id);
