-- Migração: adicionar coluna codigo (código da viatura) na tabela armazens
-- Execute este script se a tabela armazens já existia sem a coluna codigo.
-- O ID do armazém passa a ser o código da viatura (ex: V848); descricao = ex: BBCH06. Exibição: "V848 - BBCH06"

-- 1. Adicionar coluna (aceita NULL inicialmente)
ALTER TABLE armazens ADD COLUMN IF NOT EXISTS codigo VARCHAR(50);

-- 2. Preencher códigos provisórios para registros existentes (V1, V2, ...)
UPDATE armazens SET codigo = 'V' || id WHERE codigo IS NULL;

-- 3. Tornar obrigatório e único
ALTER TABLE armazens ALTER COLUMN codigo SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS armazens_codigo_key ON armazens(codigo);

-- 4. Comentário
COMMENT ON COLUMN armazens.codigo IS 'Código da viatura (ex: V848) - identificador do armazém';

-- Depois de rodar, edite os armazéns na tela para ajustar os códigos (ex: V848) e descrições (ex: BBCH06) reais.
