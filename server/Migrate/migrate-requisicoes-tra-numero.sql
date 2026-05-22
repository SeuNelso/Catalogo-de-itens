-- Número da TRA registado manualmente após geração do ficheiro.
ALTER TABLE requisicoes
  ADD COLUMN IF NOT EXISTS tra_numero TEXT NULL;

COMMENT ON COLUMN requisicoes.tra_numero IS
  'Número da TRA preenchido manualmente na UI após geração do ficheiro; obrigatório para finalizar requisições com TRA.';
