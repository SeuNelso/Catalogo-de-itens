-- Permissão explícita para funcionalidades de controlo de stock (consulta/gestão por localização).
-- Só administradores definem este campo (API); o valor entra no JWT após login / verify-token.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS pode_controlo_stock BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN usuarios.pode_controlo_stock IS 'Se true: acesso a consulta/gestão de stock por localização em armazéns centrais (além do perfil). Admin ignora na API.';

CREATE INDEX IF NOT EXISTS idx_usuarios_pode_controlo_stock ON usuarios (pode_controlo_stock) WHERE pode_controlo_stock = true;
