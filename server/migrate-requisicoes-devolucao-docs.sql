-- Documentos de devolução (origem viatura → armazém central): TRA recebimento, TRFL interna.
-- Execute: npm run db:migrate:requisicoes-devolucao-docs
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_tra_gerada_em TIMESTAMP;

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_trfl_gerada_em TIMESTAMP;
