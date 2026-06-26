-- Ocultação admin/teste da card Zona de receção (não altera stock físico).
ALTER TABLE armazens
  ADD COLUMN IF NOT EXISTS monitor_rececao_oculto_teste BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN armazens.monitor_rececao_oculto_teste IS
  'Quando true, o monitor da zona de receção devolve lista vazia (somente ocultação UI para testes admin).';
