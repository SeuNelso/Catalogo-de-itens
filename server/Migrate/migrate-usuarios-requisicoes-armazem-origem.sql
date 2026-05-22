-- Restringe utilizadores (não admin/controller) às requisições cujo armazém de origem é o indicado.
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS requisicoes_armazem_origem_id INTEGER REFERENCES armazens(id) ON DELETE SET NULL;

COMMENT ON COLUMN usuarios.requisicoes_armazem_origem_id IS 'Armazém central: utilizador só vê/altera requisições com este armazem_origem_id (admin/controller ignoram).';

CREATE INDEX IF NOT EXISTS idx_usuarios_requisicoes_armazem_origem
  ON usuarios (requisicoes_armazem_origem_id)
  WHERE requisicoes_armazem_origem_id IS NOT NULL;
