-- Nome/sobrenome separados e telemóvel (cadastro alargado)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sobrenome VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telemovel VARCHAR(50);

COMMENT ON COLUMN usuarios.sobrenome IS 'Apelido(s). Nome completo: nome + sobrenome.';
COMMENT ON COLUMN usuarios.telemovel IS 'Contacto telefónico (opcional)';
