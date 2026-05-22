-- Tickets de movimentação interna (origem → destino no mesmo central) para fila e exportação TRFL.

CREATE TABLE IF NOT EXISTS armazem_movimentacao_interna (
  id SERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  origem_localizacao_id INTEGER NOT NULL REFERENCES armazens_localizacoes(id) ON DELETE RESTRICT,
  destino_localizacao_id INTEGER NOT NULL REFERENCES armazens_localizacoes(id) ON DELETE RESTRICT,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE RESTRICT,
  quantidade NUMERIC(18, 4) NOT NULL CHECK (quantidade > 0),
  trfl_gerada_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ami_armazem_created ON armazem_movimentacao_interna (armazem_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ami_trfl_null ON armazem_movimentacao_interna (armazem_id) WHERE trfl_gerada_em IS NULL;

COMMENT ON TABLE armazem_movimentacao_interna IS 'Registo por linha após transferência de stock entre localizações do mesmo central; TRFL gerada a partir destes tickets.';
