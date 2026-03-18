-- Adiciona status FINALIZADO às requisições
ALTER TABLE requisicoes DROP CONSTRAINT IF EXISTS requisicoes_status_check;
ALTER TABLE requisicoes ADD CONSTRAINT requisicoes_status_check
  CHECK (status IN ('pendente', 'separado', 'EM EXPEDICAO', 'Entregue', 'FINALIZADO', 'cancelada'));

COMMENT ON COLUMN requisicoes.status IS 'pendente → separado (preparado) → EM EXPEDICAO (TRFL) → Entregue (TRA) → FINALIZADO (fechado) ou cancelada';

