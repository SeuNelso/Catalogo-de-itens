# Guia para Verificar Informações do Cloudflare R2

## 🔧 Como encontrar as informações corretas:

### 1. Acesse o Dashboard do Cloudflare
- Vá para https://dash.cloudflare.com
- Faça login na sua conta

### 2. Vá para R2 Object Storage
- No menu lateral, clique em "R2 Object Storage"
- Ou procure por "R2" no dashboard

### 3. Encontre seu bucket
- Clique no bucket "catalogo-imagens"
- Vá para a aba "Settings" ou "Configuração"

### 4. Verifique as informações:
- **Account ID**: Deve estar na URL do dashboard
- **Bucket Name**: "catalogo-imagens"
- **API Token**: Vá em "Manage R2 API tokens"

### 5. Formato correto do endpoint:
O endpoint deve seguir este formato:
```
https://[ACCOUNT_ID].r2.cloudflarestorage.com
```

### 6. Exemplo de configuração correta:
```
R2_BUCKET=catalogo-imagens
R2_ENDPOINT=https://[SEU_ACCOUNT_ID].r2.cloudflarestorage.com
R2_ACCESS_KEY=[SEU_ACCESS_KEY]
R2_SECRET_KEY=[SEU_SECRET_KEY]
```

## 🔍 Problemas comuns:

1. **Account ID incorreto**: O Account ID deve ser o da sua conta Cloudflare
2. **Credenciais antigas**: As credenciais podem ter expirado
3. **Bucket não existe**: Verifique se o bucket "catalogo-imagens" existe
4. **Permissões**: Verifique se as credenciais têm permissão para o bucket

## 📋 Próximos passos:

1. Verifique o Account ID correto no dashboard
2. Gere novas credenciais se necessário
3. Atualize o arquivo .env com as informações corretas
4. Teste novamente com o script de teste 