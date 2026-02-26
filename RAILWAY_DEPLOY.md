# Deploy no Railway – Checklist

Se o login retorna **500** ou **"Erro de conexão"**, confira:

## 1. Variáveis de ambiente no Railway

No projeto no Railway → **Variables**:

| Variável        | Obrigatório | Descrição |
|-----------------|-------------|-----------|
| `DATABASE_URL`  | **Sim**     | URL do PostgreSQL (ex.: `postgresql://user:pass@host:5432/dbname`). Pode usar o Postgres do Railway (Add Plugin → PostgreSQL) e ele preenche sozinho. |
| `JWT_SECRET`     | **Sim**     | Chave secreta para os tokens de login (ex.: uma string longa e aleatória). |
| `NODE_ENV`      | Opcional    | Use `production` em produção. |

Sem `DATABASE_URL` o servidor não consegue acessar o banco e o login falha com 500.

## 2. Banco de dados e tabela `usuarios`

O login usa a tabela **`usuarios`** com as colunas **`username`** e **`password`**.

- Se o banco já existia com outra estrutura (ex.: `email` e `senha`), rode a migração:
  - Arquivo: `server/migrate-usuarios-username-password.sql`
  - No Railway: use o **Query** do Postgres no dashboard ou conecte com um cliente (DBeaver, psql) usando a `DATABASE_URL` e execute o SQL.

- Se está criando do zero, crie a tabela e um usuário. Exemplo mínimo:

```sql
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255),
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255),
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user'
);

-- Inserir admin (gerar hash da senha com: node -e "console.log(require('bcryptjs').hashSync('admin123', 10))")
INSERT INTO usuarios (nome, username, email, password, role)
VALUES ('Administrador', 'admin', 'admin@exemplo.com', '<COLE_O_HASH_BCRYPT_AQUI>', 'admin')
ON CONFLICT (username) DO NOTHING;
```

## 3. Ver logs no Railway

Em **Deployments** → clique no deploy → **View Logs**.  
Erros como `[LOGIN] Erro no banco:` indicam problema de conexão ou tabela/coluna faltando.

## 4. Build

O script `start` do projeto sobe o servidor Node; o `heroku-postbuild` (usado pelo Railway) faz `npm install` no client, `npm run build` e o servidor serve a pasta `client/build`. Não é preciso configurar URL da API no front: ele usa o mesmo domínio (`/api/...`).
