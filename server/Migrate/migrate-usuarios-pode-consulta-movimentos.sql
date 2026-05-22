-- Permissão para aceder à lista de movimentos (consulta Clog).
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS pode_consulta_movimentos BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN usuarios.pode_consulta_movimentos IS
  'Se true: acesso à página de consulta de movimentos e endpoints de consulta Clog.';

CREATE INDEX IF NOT EXISTS idx_usuarios_pode_consulta_movimentos
  ON usuarios (pode_consulta_movimentos)
  WHERE pode_consulta_movimentos = true;
