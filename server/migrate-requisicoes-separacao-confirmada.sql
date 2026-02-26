-- Confirmar separação: após os itens serem recolhidos/preparados
ALTER TABLE requisicoes ADD COLUMN IF NOT EXISTS separacao_confirmada BOOLEAN DEFAULT false;
ALTER TABLE requisicoes ADD COLUMN IF NOT EXISTS separacao_confirmada_em TIMESTAMP;

COMMENT ON COLUMN requisicoes.separacao_confirmada IS 'True quando a separação física foi confirmada (após itens recolhidos)';
COMMENT ON COLUMN requisicoes.separacao_confirmada_em IS 'Data/hora em que a separação foi confirmada';
