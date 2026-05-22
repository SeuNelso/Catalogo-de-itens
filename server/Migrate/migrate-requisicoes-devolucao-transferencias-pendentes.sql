-- Registo de documentos do fluxo "Transferências pendentes" da devolução.
-- Execute: npm run db:migrate:requisicoes-devolucao-transferencias-pendentes

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_tra_apeados_gerada_em TIMESTAMP;

ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_trfl_pendente_gerada_em TIMESTAMP;

