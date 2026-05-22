-- Utilizador que iniciou a separação (preparação) — bloqueia outros operadores até admin/controller.
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS separador_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_requisicoes_separador_usuario_id ON requisicoes(separador_usuario_id);

COMMENT ON COLUMN requisicoes.separador_usuario_id IS 'Definido ao primeiro preparar item — só este user (ou admin/controller) pode alterar a separação.';
