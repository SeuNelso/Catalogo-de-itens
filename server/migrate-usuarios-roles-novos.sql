-- Permitir os novos roles na tabela usuarios (admin continua podendo alterar na tela)
-- Remove qualquer check constraint na coluna role (nome pode variar conforme a instalação)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'usuarios' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check CHECK (
  role IN (
    'admin', 'controller', 'usuario', 'basico',
    'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem', 'operador'
  )
);
