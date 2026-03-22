-- Estende tipos de armazém: APEADO e EPI (uma localização igual ao código)
ALTER TABLE armazens DROP CONSTRAINT IF EXISTS armazens_tipo_check;
ALTER TABLE armazens ADD CONSTRAINT armazens_tipo_check
  CHECK (tipo IN ('central', 'viatura', 'apeado', 'epi'));
COMMENT ON COLUMN armazens.tipo IS 'central | viatura | apeado | epi (uma loc. = código)';
