# Deploy no Railway – Checklist

Se o login retorna **500** ou **"Erro de conexão"**, confira:

## 1. Variáveis de ambiente no Railway

No projeto no Railway → **Variables**:

| Variável        | Obrigatório | Descrição |
|-----------------|-------------|-----------|
| `DATABASE_URL`  | **Sim**     | URL do PostgreSQL (ex.: `postgresql://user:pass@host:5432/dbname`). Pode usar o Postgres do Railway (Add Plugin → PostgreSQL) e ele preenche sozinho. |
| `JWT_SECRET`     | **Sim**     | Chave secreta para os tokens de login (ex.: uma string longa e aleatória). |
| `NODE_ENV`      | Opcional    | Use `production` em produção. |
| `PGPOOL_MAX`    | Opcional    | Máx. de ligações do pool Node→Postgres (omissão **25**). Suba para **35–50** se tiver muitos utilizadores em paralelo e o Postgres permitir (`max_connections`). |
| `PGPOOL_IDLE_MS` | Opcional   | Fechar ligações ociosas após N ms (omissão **30000**). |
| `PGPOOL_CONN_TIMEOUT_MS` | Opcional | Tempo máx. à espera de uma ligação livre (omissão **10000**). |
| `TRUST_PROXY`   | Opcional    | `1` ou `true` se estiver atrás de nginx/Railway proxy e precisar de `req.ip` / HTTPS correto. |
| `JSON_BODY_LIMIT` | Opcional  | Limite do body JSON (omissão **12mb**). |

Sem `DATABASE_URL` o servidor não consegue acessar o banco e o login falha com 500.

### Desenvolvimento local apontando para o Postgres do Railway

1. No Railway, abra o serviço **PostgreSQL** → **Variables** ou **Connect** e copie a `DATABASE_URL` (em geral a variável pública, se existir separada da rede interna).
2. No seu PC, em `server/.env`, defina **só** essa linha (ajuste o valor):

   `DATABASE_URL=postgresql://...`

   Pode comentar ou ignorar `DB_HOST`, `DB_USER`, etc.; o pool usa `DATABASE_URL` com prioridade.
3. O backend já usa **SSL** quando o host não é `localhost`, compatível com o Postgres gerido do Railway.
4. `JWT_SECRET` no `.env` local pode ser qualquer valor em desenvolvimento; se for diferente do Railway, só precisa voltar a fazer login após mudar.

### Importar Stock Nacional → itens não cadastrados

A importação grava em `itens_nao_cadastrados` colunas **`armazens`** (JSON) e **`data_importacao`**. Bases antigas criadas só com `init-db.sql` antigo podem não ter essas colunas — a inserção falha em silêncio no lote. Execute **uma vez**:

`npm run db:migrate:itens-nao-cadastrados`

### Desempenho (índices na BD)

Com muitos utilizadores, execute uma vez na base (local ou Railway → Query):

`npm run db:migrate:performance-indexes`

Isso cria índices extra (login, listagens de requisições, stocks por item) e corre `ANALYZE`. Requer tabelas `usuarios`, `requisicoes` e `armazens_item` já existentes.

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

### Erro ao conectar no PC (dev local)

- **`password authentication failed for user "usuario"`** — o `DATABASE_URL` no `server/.env` ainda é o exemplo (`localhost` / `usuario`) ou está vazio e cai nos placeholders. Cole a URL **pública** do Postgres (Railway → PostgreSQL → **Connect**).
- **`getaddrinfo ENOTFOUND postgres.railway.internal`** (ou timeout) — você está usando a URL **interna** do Railway. No notebook ela não resolve; use a conexão **pública** / TCP proxy (host do tipo `*.proxy.rlwy.net` ou o que o painel mostrar em “Public network”).

## 4. Build

O script `start` do projeto sobe o servidor Node; o `heroku-postbuild` (usado pelo Railway) faz `npm install` no client, `npm run build` e o servidor serve a pasta `client/build`. Não é preciso configurar URL da API no front: ele usa o mesmo domínio (`/api/...`).
