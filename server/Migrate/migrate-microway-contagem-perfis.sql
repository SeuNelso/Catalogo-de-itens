-- Perfis de exportação Contagem Microway (por utilizador).

CREATE TABLE IF NOT EXISTS microway_contagem_perfis (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome VARCHAR(120) NOT NULL,
  descricao TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(usuario_id, nome)
);

CREATE TABLE IF NOT EXISTS microway_contagem_perfil_itens (
  id SERIAL PRIMARY KEY,
  perfil_id INTEGER NOT NULL REFERENCES microway_contagem_perfis(id) ON DELETE CASCADE,
  codigo VARCHAR(100) NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  UNIQUE(perfil_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_mw_contagem_perfis_usuario
  ON microway_contagem_perfis(usuario_id);

CREATE INDEX IF NOT EXISTS idx_mw_contagem_perfil_itens_perfil
  ON microway_contagem_perfil_itens(perfil_id);

COMMENT ON TABLE microway_contagem_perfis IS 'Listas guardadas de artigos ERP para exportação Microway (por utilizador).';
COMMENT ON TABLE microway_contagem_perfil_itens IS 'Códigos ERP de cada perfil Microway.';
