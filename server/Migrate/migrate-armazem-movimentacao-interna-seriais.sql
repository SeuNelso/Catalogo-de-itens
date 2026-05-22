-- Rastreabilidade de seriais escolhidos por ticket de movimentação interna.
-- Permite auditar quais serial numbers foram movimentados em cada TRFL/TRA APEADO.

CREATE TABLE IF NOT EXISTS armazem_movimentacao_interna_seriais (
  id BIGSERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES armazem_movimentacao_interna(id) ON DELETE CASCADE,
  stock_serial_id INTEGER REFERENCES stock_serial(id) ON DELETE SET NULL,
  serialnumber TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ami_seriais_ticket_serial
  ON armazem_movimentacao_interna_seriais (ticket_id, serialnumber);

CREATE INDEX IF NOT EXISTS idx_ami_seriais_ticket
  ON armazem_movimentacao_interna_seriais (ticket_id);

CREATE INDEX IF NOT EXISTS idx_ami_seriais_serial
  ON armazem_movimentacao_interna_seriais (serialnumber);
