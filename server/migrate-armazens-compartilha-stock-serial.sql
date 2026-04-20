-- Flag por armazém para controlar se os seriais são compartilhados
-- no fluxo de preparação/transferência.
ALTER TABLE armazens
ADD COLUMN IF NOT EXISTS compartilha_stock_serial BOOLEAN NOT NULL DEFAULT true;

-- Defaults operacionais iniciais:
-- viatura / epi começam sem compartilhamento;
-- central / apeado mantêm compartilhamento.
UPDATE armazens
SET compartilha_stock_serial = false
WHERE LOWER(TRIM(COALESCE(tipo, ''))) IN ('viatura', 'epi')
  AND compartilha_stock_serial IS DISTINCT FROM false;
