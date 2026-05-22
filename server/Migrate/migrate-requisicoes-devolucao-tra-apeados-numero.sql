-- Número da TRA de APEADOS (fluxo de devolução), preenchido manualmente na UI.
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS devolucao_tra_apeados_numero TEXT NULL;

COMMENT ON COLUMN requisicoes.devolucao_tra_apeados_numero IS
  'Número da TRA APEADOS preenchido manualmente após gerar TRA APEADOS; obrigatório para finalizar devoluções com APEADOS.';
