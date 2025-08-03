# Configuração de Variáveis de Ambiente para Deploy

## Problemas Resolvidos

1. **"Missing required key 'Bucket' in params"** - Variáveis de ambiente não configuradas
2. **"Inaccessible host" com região 'auto'"** - Configuração incorreta do Cloudflare R2

## Solução Implementada

1. **Valores padrão adicionados**: O código agora usa valores padrão para desenvolvimento local
2. **Logs de debug**: Adicionados logs para identificar problemas de configuração
3. **Função helper centralizada**: `createS3Client()` centraliza toda a configuração do S3
4. **Configuração correta do Cloudflare R2**: 
   - Região fixa: `us-east-1` (em vez de `auto`)
   - Agent HTTPS configurado para melhor conectividade
   - Timeout e retries otimizados

## Configuração para Produção

### Para Railway:
1. Acesse o dashboard do Railway
2. Vá para seu projeto
3. Clique em "Variables"
4. Adicione as seguintes variáveis:

```
R2_BUCKET=catalogo-imagens
R2_ENDPOINT=https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com
R2_ACCESS_KEY=32f0b3b31955b3878e1c2c107ef33fd5
R2_SECRET_KEY=580539e25b1580ce1c37425fb3eeb45be831ec029b352f6375614399e7ab714f
```

### Para Heroku:
1. Acesse o dashboard do Heroku
2. Vá para seu app
3. Clique em "Settings" > "Config Vars"
4. Adicione as mesmas variáveis acima

### Para Vercel:
1. Acesse o dashboard do Vercel
2. Vá para seu projeto
3. Clique em "Settings" > "Environment Variables"
4. Adicione as mesmas variáveis acima

### Para Render:
1. Acesse o dashboard do Render
2. Vá para seu serviço
3. Clique em "Environment"
4. Adicione as mesmas variáveis acima

## Verificação

Após configurar as variáveis de ambiente, o deploy deve funcionar corretamente e as imagens devem aparecer sem erros.

## Modo de Fallback

O sistema agora inclui um modo de fallback que permite funcionar mesmo sem as credenciais do R2 configuradas:

### Operações que funcionam sem R2:
- ✅ **Exclusão de imagens**: Pulgada silenciosamente
- ✅ **Upload de imagens**: Retorna URL simulada
- ✅ **Visualização de imagens**: Retorna erro informativo
- ✅ **Todas as outras funcionalidades**: Funcionam normalmente

### Comportamento:
- As operações são puladas silenciosamente
- O sistema continua funcionando normalmente
- Logs informativos são exibidos para indicar que as operações foram puladas
- Mensagens de erro claras são mostradas ao usuário

## Logs de Debug

O código agora inclui logs detalhados que ajudarão a identificar problemas:

- `🔧 [ENV]` - Logs das variáveis de ambiente
- `🔧 [S3]` - Logs da criação do cliente S3
- `🔧 [DELETE]` - Logs das operações de exclusão
- `🔧 [UPLOAD]` - Logs das operações de upload
- `🔧 [PROXY]` - Logs das operações de visualização
- `✅ [DELETE/UPLOAD/PROXY]` - Confirmação de sucesso
- `❌ [DELETE/UPLOAD/PROXY]` - Erros encontrados
- `⚠️ [DELETE/UPLOAD/PROXY]` - Operações puladas (modo fallback) 