-- Um registo por número de série por linha de requisição (S/N).
-- Evita agregar centenas de S/N num único campo requisicoes_itens.serialnumber.

CREATE TABLE IF NOT EXISTS requisicoes_itens_seriais (
  id SERIAL PRIMARY KEY,
  requisicao_item_id INTEGER NOT NULL REFERENCES requisicoes_itens(id) ON DELETE CASCADE,
  serialnumber TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_requisicao_item_serial UNIQUE (requisicao_item_id, serialnumber)
);

CREATE INDEX IF NOT EXISTS idx_requisicoes_itens_seriais_item_ordem
  ON requisicoes_itens_seriais (requisicao_item_id, ordem, id);

COMMENT ON TABLE requisicoes_itens_seriais IS
  'S/N por linha de requisição; ordem = sequência de preparação.';

-- Migra dados existentes a partir de requisicoes_itens.serialnumber (várias linhas com \n).
INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem)
SELECT ri.id, trim(both from s.x), s.ord::integer
FROM requisicoes_itens ri
INNER JOIN itens i ON i.id = ri.item_id AND UPPER(TRIM(COALESCE(i.tipocontrolo, ''))) = 'S/N'
CROSS JOIN LATERAL unnest(
  string_to_array(
    regexp_replace(trim(both from COALESCE(ri.serialnumber, '')), E'\\r\\n', E'\n', 'g'),
    E'\n'
  )
) WITH ORDINALITY AS s(x, ord)
WHERE trim(both from COALESCE(ri.serialnumber, '')) <> ''
  AND trim(both from s.x) <> ''
ON CONFLICT (requisicao_item_id, serialnumber) DO NOTHING;

-- Deixa de duplicar texto longo na coluna agregada quando já existem linhas filhas.
UPDATE requisicoes_itens ri
SET serialnumber = NULL
WHERE EXISTS (
  SELECT 1 FROM requisicoes_itens_seriais s WHERE s.requisicao_item_id = ri.id
);
