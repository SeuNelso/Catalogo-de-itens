-- Quantidade APEADOS por item (devolução viatura -> central)
-- Serve para dividir o destino da TRFL entre zona FERR e zona normal.
--
-- Execute: npm run db:migrate:requisicoes-itens-quantidade-apeados

ALTER TABLE requisicoes_itens
  ADD COLUMN IF NOT EXISTS quantidade_apeados INTEGER DEFAULT 0;

COMMENT ON COLUMN requisicoes_itens.quantidade_apeados IS 'Quantidade (unidades) do item que deve ser tratada como APEADOS no destino FERR (TRFL de devolução).';

