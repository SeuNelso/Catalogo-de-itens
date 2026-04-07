CREATE TABLE IF NOT EXISTS inventario_contagem_semanal_tarefas (
  id BIGSERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id),
  atribuido_para_user_id INTEGER NOT NULL REFERENCES usuarios(id),
  criado_por_user_id INTEGER NOT NULL REFERENCES usuarios(id),
  status TEXT NOT NULL DEFAULT 'ABERTA',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventario_contagem_semanal_linhas (
  id BIGSERIAL PRIMARY KEY,
  tarefa_id BIGINT NOT NULL REFERENCES inventario_contagem_semanal_tarefas(id) ON DELETE CASCADE,
  artigo TEXT NOT NULL,
  descricao TEXT NULL,
  qtd NUMERIC(18, 4) NOT NULL DEFAULT 0,
  qtd_ape NUMERIC(18, 4) NOT NULL DEFAULT 0,
  total NUMERIC(18, 4) NOT NULL DEFAULT 0,
  quantidade_sistema NUMERIC(18, 4) NOT NULL DEFAULT 0,
  diferenca NUMERIC(18, 4) NOT NULL DEFAULT 0,
  atualizado_por_user_id INTEGER NULL REFERENCES usuarios(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_tarefa_updated
  ON inventario_contagem_semanal_tarefas(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_tarefa_user
  ON inventario_contagem_semanal_tarefas(atribuido_para_user_id, criado_por_user_id);

CREATE INDEX IF NOT EXISTS idx_inv_cont_sem_linhas_tarefa
  ON inventario_contagem_semanal_linhas(tarefa_id);
