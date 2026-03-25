-- APEADOS: novo estado para devoluções após Em processo (EM EXPEDICAO).
-- Execute: npm run db:migrate:requisicoes-status-apeados

ALTER TABLE requisicoes
  DROP CONSTRAINT IF EXISTS requisicoes_status_check;

ALTER TABLE requisicoes
  ADD CONSTRAINT requisicoes_status_check
  CHECK (
    status IN (
      'pendente',
      'EM SEPARACAO',
      'separado',
      'EM EXPEDICAO',
      'APEADOS',
      'Entregue',
      'FINALIZADO',
      'cancelada'
    )
  );

