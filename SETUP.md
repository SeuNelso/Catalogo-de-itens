# Guia de Configuração do Ambiente

Este guia irá ajudá-lo a configurar o ambiente de desenvolvimento do projeto Catálogo de Itens.

## 📋 Pré-requisitos

- Node.js (versão 16 ou superior)
- PostgreSQL (ou acesso a um banco PostgreSQL remoto)
- npm ou yarn
- Git

## 🚀 Passo a Passo

### 1. Instalar Dependências

#### Backend
```bash
npm install
```

#### Frontend
```bash
cd client
npm install
cd ..
```

Ou use o script automatizado:
```bash
npm run install-all
```

### 2. Configurar Variáveis de Ambiente

#### Criar arquivo `.env` no diretório `server/`

Copie o arquivo de exemplo:
```bash
cp server/env.example server/.env
```

#### Editar o arquivo `server/.env`

Configure as seguintes variáveis:

```env
# Banco de Dados PostgreSQL
DATABASE_URL=postgres://usuario:senha@host:porta/database

# Ou configure individualmente:
DB_HOST=localhost
DB_PORT=5432
DB_NAME=catalogo
DB_USER=seu_usuario
DB_PASSWORD=sua_senha

# Servidor
PORT=3001
NODE_ENV=development

# JWT Secret (GERE UMA CHAVE SEGURA!)
JWT_SECRET=sua-chave-secreta-aqui

# Cloudflare R2 (Opcional - para armazenamento de imagens)
R2_BUCKET=seu-bucket-name
R2_ENDPOINT=https://seu-endpoint.r2.cloudflarestorage.com
R2_ACCESS_KEY=sua-access-key
R2_SECRET_KEY=sua-secret-key
```

**⚠️ IMPORTANTE:** 
- O arquivo `.env` já está no `.gitignore` e não será commitado
- NUNCA compartilhe suas credenciais
- Em produção, use variáveis de ambiente do seu provedor de hospedagem

### 3. Configurar Banco de Dados

#### Opção A: PostgreSQL Local

1. Instale o PostgreSQL
2. Crie um banco de dados:
```sql
CREATE DATABASE catalogo;
```

3. Configure a `DATABASE_URL` no arquivo `.env`

4. Execute os scripts SQL na ordem (use as credenciais do seu `.env`):
```bash
# 1. Estrutura base (usuários, itens, etc.)
psql -U seu_usuario -d catalogo -f server/init-db.sql

# 2. Tabelas de armazéns e requisições
psql -U seu_usuario -d catalogo -f server/create-armazens-requisicoes-v2.sql
```

Se a tabela `requisicoes` já existia, execute também a migração para armazém origem:
```bash
psql -U seu_usuario -d catalogo -f server/migrate-requisicoes-armazem-origem.sql
```

Se usar **pgAdmin** ou outro cliente gráfico: abra cada arquivo `.sql` e execute no banco.

#### Opção B: PostgreSQL Remoto (Railway, Heroku, etc.)

1. Obtenha a connection string do seu provedor
2. Configure a `DATABASE_URL` no arquivo `.env`

### 4. Criar Estrutura de Diretórios

O projeto criará automaticamente os diretórios necessários, mas você pode criá-los manualmente:

```bash
mkdir -p server/uploads
```

### 5. Iniciar o Desenvolvimento

#### Modo Desenvolvimento (Backend + Frontend)
```bash
npm run dev
```

Isso iniciará:
- Backend na porta 3001 (ou a porta configurada em PORT)
- Frontend na porta 3000

#### Apenas Backend
```bash
npm run server
```

#### Apenas Frontend
```bash
npm run client
```

### 6. Verificar Instalação

1. Acesse `http://localhost:3000` no navegador
2. Você deve ver a página inicial do sistema
3. Tente fazer login (se já houver usuários cadastrados)

## 🔧 Configurações Opcionais

### Google Drive (Armazenamento Alternativo)

1. Siga o guia em `GOOGLE_DRIVE_SETUP.md`
2. Coloque o arquivo `credentials.json` na raiz do projeto
3. Configure `GOOGLE_DRIVE_FOLDER_ID` no `.env`

### Google Cloud Vision (Reconhecimento de Imagens)

1. Configure as credenciais do Google Cloud
2. Configure `GOOGLE_APPLICATION_CREDENTIALS` no `.env`

## 🐛 Solução de Problemas

### Erro: "npm não é reconhecido como comando"
- **Node.js não está instalado ou não está no PATH**
- Consulte o arquivo **TROUBLESHOOTING_NPM.md** para solução detalhada
- Verifique: `node --version` e `npm --version` no terminal
- Se não funcionar, instale Node.js de https://nodejs.org/ (versão LTS)

### Erro: "Cannot find module"
- Execute `npm install` novamente
- Verifique se está no diretório correto
- Limpe o cache: `npm cache clean --force`

### Erro: "Connection refused" (PostgreSQL)
- Verifique se o PostgreSQL está rodando
- Confirme as credenciais no arquivo `.env`
- Teste a conexão: `psql -h host -U usuario -d database`

### Erro: "Port already in use"
- Altere a porta no arquivo `.env`
- Ou pare o processo que está usando a porta

### Imagens não aparecem
- Verifique se as credenciais do R2 estão configuradas
- O sistema funcionará sem R2, mas com funcionalidades limitadas

## 📝 Próximos Passos

1. ✅ Ambiente configurado
2. ⏭️ Criar primeiro usuário administrador
3. ⏭️ Começar a cadastrar itens
4. ⏭️ Configurar armazenamento de imagens (R2 ou Google Drive)

## 🔒 Segurança

- ✅ Credenciais movidas para variáveis de ambiente
- ✅ Arquivo `.env` no `.gitignore`
- ✅ Sem credenciais hardcoded no código
- ⚠️ Gere uma chave JWT_SECRET segura para produção

---

**Desenvolvido com ❤️ para facilitar o gerenciamento de inventários**
