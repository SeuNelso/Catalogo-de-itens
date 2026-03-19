-- Vários armazéns centrais por utilizador (acesso às requisições por origem).
-- Compatível: copia dados de usuarios.requisicoes_armazem_origem_id se existir (ver run-usuario-requisicoes-armazens-multi.js).

CREATE TABLE IF NOT EXISTS usuario_requisicoes_armazens (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, armazem_id)
);

CREATE INDEX IF NOT EXISTS idx_ura_usuario ON usuario_requisicoes_armazens(usuario_id);
CREATE INDEX IF NOT EXISTS idx_ura_armazem ON usuario_requisicoes_armazens(armazem_id);

COMMENT ON TABLE usuario_requisicoes_armazens IS 'Armazéns centrais: utilizador só vê requisições cuja origem está nesta lista (admin/controller ignoram). Lista vazia = sem restrição.';
