-- Controle rastreável de stock por serial/lote/caixa

CREATE TABLE IF NOT EXISTS stock_serial (
  id BIGSERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(120) NOT NULL,
  serialnumber VARCHAR(180) NOT NULL,
  lote VARCHAR(180),
  status VARCHAR(20) NOT NULL DEFAULT 'disponivel',
  requisicao_id INTEGER REFERENCES requisicoes(id) ON DELETE SET NULL,
  requisicao_item_id INTEGER REFERENCES requisicoes_itens(id) ON DELETE SET NULL,
  reservado_em TIMESTAMP NULL,
  consumido_em TIMESTAMP NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stock_serial_status_ck CHECK (status IN ('disponivel', 'reservado', 'consumido'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_serial_item_serial
  ON stock_serial (item_id, serialnumber);
CREATE INDEX IF NOT EXISTS idx_stock_serial_status
  ON stock_serial (status);
CREATE INDEX IF NOT EXISTS idx_stock_serial_item_armazem_loc
  ON stock_serial (item_id, armazem_id, localizacao);
CREATE INDEX IF NOT EXISTS idx_stock_serial_req_item
  ON stock_serial (requisicao_item_id);

CREATE TABLE IF NOT EXISTS stock_lote (
  id BIGSERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(120) NOT NULL,
  lote VARCHAR(180) NOT NULL,
  quantidade_disponivel NUMERIC(14, 3) NOT NULL DEFAULT 0,
  quantidade_reservada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  quantidade_consumida NUMERIC(14, 3) NOT NULL DEFAULT 0,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stock_lote_quantidades_ck CHECK (
    quantidade_disponivel >= 0 AND
    quantidade_reservada >= 0 AND
    quantidade_consumida >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_lote_item_arm_loc_lote
  ON stock_lote (item_id, armazem_id, localizacao, lote);
CREATE INDEX IF NOT EXISTS idx_stock_lote_item_arm_loc
  ON stock_lote (item_id, armazem_id, localizacao);

CREATE TABLE IF NOT EXISTS stock_caixas (
  id BIGSERIAL PRIMARY KEY,
  codigo_caixa VARCHAR(120) NOT NULL,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'aberta',
  criado_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stock_caixas_status_ck CHECK (status IN ('aberta', 'fechada', 'consumida'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_caixas_codigo
  ON stock_caixas (codigo_caixa);
CREATE INDEX IF NOT EXISTS idx_stock_caixas_item_arm_loc
  ON stock_caixas (item_id, armazem_id, localizacao);

CREATE TABLE IF NOT EXISTS stock_caixa_seriais (
  id BIGSERIAL PRIMARY KEY,
  caixa_id BIGINT NOT NULL REFERENCES stock_caixas(id) ON DELETE CASCADE,
  stock_serial_id BIGINT NOT NULL REFERENCES stock_serial(id) ON DELETE CASCADE,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_caixa_seriais_caixa_serial
  ON stock_caixa_seriais (caixa_id, stock_serial_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_caixa_seriais_serial_unico
  ON stock_caixa_seriais (stock_serial_id);

CREATE TABLE IF NOT EXISTS stock_movimentos_auditoria (
  id BIGSERIAL PRIMARY KEY,
  tipo VARCHAR(40) NOT NULL,
  item_id INTEGER REFERENCES itens(id) ON DELETE SET NULL,
  armazem_id INTEGER REFERENCES armazens(id) ON DELETE SET NULL,
  localizacao VARCHAR(120),
  lote VARCHAR(180),
  serialnumber VARCHAR(180),
  quantidade NUMERIC(14, 3),
  requisicao_id INTEGER REFERENCES requisicoes(id) ON DELETE SET NULL,
  requisicao_item_id INTEGER REFERENCES requisicoes_itens(id) ON DELETE SET NULL,
  caixa_id BIGINT REFERENCES stock_caixas(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  payload JSONB,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_mov_aud_tipo_criado
  ON stock_movimentos_auditoria (tipo, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mov_aud_req_item
  ON stock_movimentos_auditoria (requisicao_item_id);
