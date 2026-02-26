-- Fases da requisição: pendente → separado → EM EXPEDICAO → Entregue (e cancelada)
-- 1. Primeiro alterar o constraint (senão o UPDATE falha porque 'separado' não era permitido)
ALTER TABLE requisicoes DROP CONSTRAINT IF EXISTS requisicoes_status_check;
ALTER TABLE requisicoes ADD CONSTRAINT requisicoes_status_check
  CHECK (status IN ('pendente', 'separado', 'EM EXPEDICAO', 'Entregue', 'cancelada'));

-- 2. Depois atualizar requisições que estavam 'atendida' para 'separado'
UPDATE requisicoes SET status = 'separado' WHERE status = 'atendida';

COMMENT ON COLUMN requisicoes.status IS 'pendente → separado (preparado) → EM EXPEDICAO (TRFL) → Entregue (TRA) ou cancelada';
