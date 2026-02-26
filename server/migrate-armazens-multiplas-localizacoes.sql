-- Migração: múltiplas localizações por armazém
-- Cria tabela armazens_localizacoes e migra dados existentes da coluna localizacao

CREATE TABLE IF NOT EXISTS armazens_localizacoes (
  id SERIAL PRIMARY KEY,
  armazem_id INTEGER NOT NULL REFERENCES armazens(id) ON DELETE CASCADE,
  localizacao VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_armazens_localizacoes_armazem_id ON armazens_localizacoes(armazem_id);

-- Migrar dados existentes: se armazens.localizacao tem valor, inserir em armazens_localizacoes
INSERT INTO armazens_localizacoes (armazem_id, localizacao)
SELECT a.id, a.localizacao FROM armazens a
WHERE a.localizacao IS NOT NULL AND a.localizacao <> ''
  AND NOT EXISTS (SELECT 1 FROM armazens_localizacoes al WHERE al.armazem_id = a.id AND al.localizacao = a.localizacao);

COMMENT ON TABLE armazens_localizacoes IS 'Localizações de cada armazém (um armazém pode ter várias)';
