-- Código de caixa esperado por linha de S/N (ex.: importação recebimento mercadoria).
ALTER TABLE requisicoes_itens_seriais
  ADD COLUMN IF NOT EXISTS codigo_caixa TEXT;

COMMENT ON COLUMN requisicoes_itens_seriais.codigo_caixa IS
  'Referência de caixa associada ao S/N na criação da tarefa (opcional).';
