-- Armazém APEADO destino usado na TRA APEADOS da devolução.
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_apeado_destino_id INTEGER NULL;

COMMENT ON COLUMN requisicoes.devolucao_apeado_destino_id IS
  'ID do armazém APEADO selecionado ao gerar TRA APEADOS da devolução; usado para rastreio no Clog.';
