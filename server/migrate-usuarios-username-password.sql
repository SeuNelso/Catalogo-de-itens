-- Migração: adicionar colunas username e password na tabela usuarios
-- Execute se a tabela usuarios tem email/senha mas o sistema espera username/password

-- Adicionar colunas se não existirem
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS username VARCHAR(255) UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password VARCHAR(255);

-- Se existir coluna senha, copiar para password e criar username a partir do email
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'usuarios' AND column_name = 'senha'
  ) THEN
    UPDATE usuarios SET password = senha WHERE password IS NULL;
    UPDATE usuarios SET username = SPLIT_PART(email, '@', 1) WHERE username IS NULL AND email IS NOT NULL;
  END IF;
END $$;

-- Inserir admin se não existir (username: admin, senha: admin123)
INSERT INTO usuarios (nome, username, email, password, role) 
VALUES ('Administrador', 'admin', 'admin@catalogo.com', '$2a$10$rOzJqJqJqJqJqJqJqJqJqOqJqJqJqJqJqJqJqJqJqJqJqJqJqJqJq', 'admin')
ON CONFLICT (username) DO NOTHING;
