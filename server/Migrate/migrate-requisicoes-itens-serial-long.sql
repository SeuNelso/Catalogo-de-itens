-- Aumenta capacidade de serialnumber para suportar múltiplos S/N no mesmo item.
ALTER TABLE requisicoes_itens
  ALTER COLUMN serialnumber TYPE TEXT;

-- Bobinas também podem carregar serials maiores.
ALTER TABLE requisicoes_itens_bobinas
  ALTER COLUMN serialnumber TYPE TEXT;

COMMENT ON COLUMN requisicoes_itens.serialnumber IS
  'Serial number(s) do item; para S/N pode conter múltiplos valores separados por quebra de linha.';
