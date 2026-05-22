-- TRA APEADO na fila de tickets: ficheiro gerado vs Nº TRA registado (conclusão).

ALTER TABLE armazem_movimentacao_interna
  ADD COLUMN IF NOT EXISTS tra_apeado_gerada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tra_apeado_numero TEXT;

CREATE INDEX IF NOT EXISTS idx_ami_tra_apeado_pendente
  ON armazem_movimentacao_interna (armazem_id)
  WHERE tra_apeado_numero IS NULL OR TRIM(tra_apeado_numero) = '';

COMMENT ON COLUMN armazem_movimentacao_interna.tra_apeado_gerada_em IS 'Excel TRA APEADO transferido; ticket continua pendente até tra_apeado_numero.';
COMMENT ON COLUMN armazem_movimentacao_interna.tra_apeado_numero IS 'Nº TRA registado; com valor preenchido o ticket fica concluído no fluxo APEADO.';
