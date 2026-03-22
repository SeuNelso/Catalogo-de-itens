-- Correcção pontual: o CHECK em `usuarios.role` não inclui `supervisor_armazem`
-- (o pg_get_constraintdef mostra algo como role = ANY (ARRAY['admin'::text, ...]) sem supervisor).
-- Executar no Postgres de produção (Query do Railway ou psql com URL direta :5432).
-- Depois: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usuarios_role_check';

ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;

ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_role_check CHECK (
  role = ANY (ARRAY[
    'admin'::text,
    'controller'::text,
    'usuario'::text,
    'basico'::text,
    'backoffice_operations'::text,
    'backoffice_armazem'::text,
    'supervisor_armazem'::text,
    'operador'::text
  ])
);
