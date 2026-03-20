-- Fase intermédia: após preparar o primeiro item → EM SEPARACAO; após «Completar separação» → separado (Separadas)
-- Requer migrações anteriores: status com FINALIZADO (migrate-requisicoes-status-finalizado.sql) e coluna preparacao_confirmada nos itens.
ALTER TABLE requisicoes DROP CONSTRAINT IF EXISTS requisicoes_status_check;
ALTER TABLE requisicoes ADD CONSTRAINT requisicoes_status_check
  CHECK (status IN ('pendente', 'EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'Entregue', 'FINALIZADO', 'cancelada'));

-- Backfill: requisições ainda «pendente» mas com pelo menos um item já preparado passam a «Em separação»
-- (Não usa separador_usuario_id — essa coluna é de outra migração; pode correr npm run db:migrate:requisicoes-separador depois.)
UPDATE requisicoes r
SET status = 'EM SEPARACAO'
WHERE r.status = 'pendente'
  AND EXISTS (
    SELECT 1 FROM requisicoes_itens ri
    WHERE ri.requisicao_id = r.id AND ri.preparacao_confirmada = true
  );

COMMENT ON COLUMN requisicoes.status IS 'pendente → EM SEPARACAO (separação em curso) → separado/Separadas → EM EXPEDICAO → Entregue → FINALIZADO ou cancelada';
