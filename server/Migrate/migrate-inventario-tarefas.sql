-- Tarefas de inventário com segregação de funções:
-- backoffice cria/justifica, operador conta, supervisor aprova/rejeita/aplica.
CREATE TABLE IF NOT EXISTS inventario_tarefas (
  id BIGSERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id),
  localizacao_id INTEGER NOT NULL REFERENCES armazens_localizacoes(id),
  item_id INTEGER NOT NULL REFERENCES itens(id),
  status TEXT NOT NULL DEFAULT 'ABERTA',
  qtd_sistema_snapshot NUMERIC(18, 4) NOT NULL DEFAULT 0,
  qtd_fisica NUMERIC(18, 4) NULL,
  delta NUMERIC(18, 4) NULL,
  justificativa_backoffice TEXT NULL,
  decisao_supervisor TEXT NULL,
  supervisor_decisao_motivo TEXT NULL,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  contado_por INTEGER NULL REFERENCES usuarios(id),
  justificado_por INTEGER NULL REFERENCES usuarios(id),
  decidido_por INTEGER NULL REFERENCES usuarios(id),
  aplicado_por INTEGER NULL REFERENCES usuarios(id),
  contado_em TIMESTAMP NULL,
  justificado_em TIMESTAMP NULL,
  decidido_em TIMESTAMP NULL,
  aplicado_em TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventario_tarefas_status ON inventario_tarefas(status);
CREATE INDEX IF NOT EXISTS idx_inventario_tarefas_armazem ON inventario_tarefas(armazem_id);
CREATE INDEX IF NOT EXISTS idx_inventario_tarefas_updated ON inventario_tarefas(updated_at DESC);
