-- Permitir os novos roles na tabela usuarios (admin continua podendo alterar na tela)
-- Idempotente: remove o constraint pelo nome habitual e qualquer CHECK na coluna `role`
-- (o script antigo usava pg_get_constraintdef LIKE '%role%', que por vezes não apanha o constraint)
--
-- Na coluna `role` gravam-se códigos em minúsculas (ex.: supervisor_armazem), não o rótulo da UI.
-- Perfis longos: backoffice_operations (22). Largura mínima segura: VARCHAR(64).

ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.usuarios'::regclass
      AND c.contype = 'c'
      AND c.conkey IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS ck(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
        WHERE a.attname = 'role'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.usuarios ALTER COLUMN role TYPE VARCHAR(64);

ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_role_check CHECK (
  role IN (
    'admin', 'controller', 'usuario', 'basico',
    'backoffice_operations', 'backoffice_armazem', 'supervisor_armazem', 'operador'
  )
);

COMMENT ON COLUMN public.usuarios.role IS 'Código do perfil (ex.: supervisor_armazem). Ver ROLE_OPTIONS no client.';
