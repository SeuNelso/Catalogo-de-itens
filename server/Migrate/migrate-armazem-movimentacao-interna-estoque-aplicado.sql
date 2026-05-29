-- Stock de tickets de movimentação interna só é transferido após TRFL/TRA (estoque_aplicado_em).

ALTER TABLE armazem_movimentacao_interna
  ADD COLUMN IF NOT EXISTS estoque_aplicado_em TIMESTAMPTZ;

COMMENT ON COLUMN armazem_movimentacao_interna.estoque_aplicado_em IS
  'Quando o stock foi efetivamente movido origem→destino (na geração TRFL/TRA APEADO, não na criação do ticket).';

-- Tickets já concluídos (TRFL/TRA gerados) assumem stock já aplicado no fluxo anterior.
UPDATE armazem_movimentacao_interna
SET estoque_aplicado_em = COALESCE(trfl_gerada_em, tra_apeado_gerada_em, created_at)
WHERE estoque_aplicado_em IS NULL
  AND (trfl_gerada_em IS NOT NULL OR tra_apeado_gerada_em IS NOT NULL);
