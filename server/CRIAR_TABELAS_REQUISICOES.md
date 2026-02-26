# Criar tabelas de Requisições e Armazéns

Se o servidor mostra erros **"relation requisicoes does not exist"** ou **"relation armazens does not exist"**, execute o script SQL no seu banco PostgreSQL.

## Opção 1: Linha de comando (psql)

```bash
# Windows (PowerShell ou CMD)
psql -h switchyard.proxy.rlwy.net -p 10773 -U postgres -d railway -f server/create-armazens-requisicoes-v2.sql

# Se pedir senha, use a variável PGPASSWORD ou digite quando solicitado
```

## Opção 2: pgAdmin / DBeaver / outro cliente

1. Conecte ao banco (Railway ou seu PostgreSQL).
2. Abra um novo "Query" / "SQL Editor".
3. Copie todo o conteúdo do arquivo **`server/create-armazens-requisicoes-v2.sql`**.
4. Cole no editor e execute (F5 ou botão Executar).

## Opção 3: Railway (se usar Railway)

1. Acesse o dashboard do Railway.
2. Abra o serviço PostgreSQL.
3. Vá em "Data" ou "Query".
4. Cole e execute o conteúdo de `create-armazens-requisicoes-v2.sql`.

## Depois de executar

- Reinicie o servidor: pare com `Ctrl+C` e rode de novo `npm start` (ou `npm run dev`).
- As telas **Requisições** e **Armazéns** passarão a funcionar normalmente.
- O script ainda insere alguns armazéns de exemplo (Central, Norte, Sul, Leste, Oeste).

## Observação

Enquanto as tabelas não existirem, o servidor **continua rodando**. As rotas de listagem de armazéns e requisições devolvem lista vazia `[]` em vez de erro, para não quebrar o resto do sistema.
