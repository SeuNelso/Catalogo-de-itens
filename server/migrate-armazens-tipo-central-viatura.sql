-- Tipo de armazém: central (várias localizações, recebimento + expedição) ou viatura (2 locs, uma .FERR)
ALTER TABLE armazens ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'viatura';
ALTER TABLE armazens DROP CONSTRAINT IF EXISTS armazens_tipo_check;
ALTER TABLE armazens ADD CONSTRAINT armazens_tipo_check CHECK (tipo IN ('central', 'viatura'));
COMMENT ON COLUMN armazens.tipo IS 'central = armazém central (recebimento + expedição); viatura = 2 localizações (uma .FERR)';

-- Tipo de cada localização: recebimento, expedição, normal ou FERR
ALTER TABLE armazens_localizacoes ADD COLUMN IF NOT EXISTS tipo_localizacao VARCHAR(20) DEFAULT 'normal';
ALTER TABLE armazens_localizacoes DROP CONSTRAINT IF EXISTS armazens_localizacoes_tipo_check;
ALTER TABLE armazens_localizacoes ADD CONSTRAINT armazens_localizacoes_tipo_check
  CHECK (tipo_localizacao IN ('recebimento', 'expedicao', 'normal', 'FERR'));
COMMENT ON COLUMN armazens_localizacoes.tipo_localizacao IS 'recebimento | expedicao | normal (central); FERR ou normal (viatura)';

-- Backfill: localizações que terminam em .FERR passam a tipo_localizacao = FERR
UPDATE armazens_localizacoes SET tipo_localizacao = 'FERR'
WHERE UPPER(TRIM(localizacao)) LIKE '%.FERR';
