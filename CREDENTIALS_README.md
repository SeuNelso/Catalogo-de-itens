# Configuração das Credenciais do Google Drive

## Arquivo credentials.json

Após baixar as credenciais do Google Cloud Console, renomeie o arquivo para `credentials.json` e coloque na raiz do projeto.

O arquivo deve ter esta estrutura:

```json
{
  "type": "service_account",
  "project_id": "seu-projeto-id",
  "private_key_id": "sua-private-key-id",
  "private_key": "-----BEGIN PRIVATE KEY-----\nSUA_PRIVATE_KEY_AQUI\n-----END PRIVATE KEY-----\n",
  "client_email": "catalogo-drive-service@seu-projeto-id.iam.gserviceaccount.com",
  "client_id": "seu-client-id",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/catalogo-drive-service%40seu-projeto-id.iam.gserviceaccount.com"
}
```

## Importante

- **NUNCA** compartilhe este arquivo
- **NUNCA** faça commit deste arquivo no Git
- O arquivo já está no `.gitignore` para evitar commits acidentais
- Mantenha uma cópia segura das credenciais

## Teste das Credenciais

Para testar se as credenciais estão funcionando:

1. Coloque o arquivo `credentials.json` na raiz do projeto
2. Inicie o servidor: `npm start`
3. Tente cadastrar um item com imagem
4. Verifique se a imagem é salva no Google Drive e aparece corretamente 