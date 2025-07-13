# Configuração do Google Drive

Para usar o Google Drive como armazenamento de imagens, siga estas instruções:

## 1. Criar Projeto no Google Cloud Console

1. Acesse [Google Cloud Console](https://console.cloud.google.com/)
2. Crie um novo projeto ou selecione um existente
3. Habilite a Google Drive API:
   - Vá para "APIs & Services" > "Library"
   - Procure por "Google Drive API"
   - Clique em "Enable"

## 2. Criar Credenciais

1. Vá para "APIs & Services" > "Credentials"
2. Clique em "Create Credentials" > "Service Account"
3. Preencha as informações:
   - Nome: "catalogo-drive-service"
   - Descrição: "Serviço para upload de imagens do catálogo"
4. Clique em "Create and Continue"
5. Pule as etapas de permissões (opcional)
6. Clique em "Done"

## 3. Baixar Credenciais

1. Na lista de contas de serviço, clique na que você criou
2. Vá para a aba "Keys"
3. Clique em "Add Key" > "Create new key"
4. Selecione "JSON"
5. Clique em "Create"
6. O arquivo será baixado automaticamente

## 4. Configurar o Projeto

1. Renomeie o arquivo baixado para `credentials.json`
2. Coloque o arquivo na raiz do projeto (mesmo nível do `package.json`)
3. Adicione `credentials.json` ao `.gitignore` para não compartilhar suas credenciais

## 5. Configurar Pasta do Google Drive (Opcional)

Para organizar as imagens em uma pasta específica:

1. Crie uma pasta no Google Drive
2. Clique com o botão direito na pasta > "Compartilhar"
3. Adicione o email da conta de serviço (encontrado no arquivo credentials.json)
4. Dê permissão de "Editor"
5. Copie o ID da pasta da URL (parte após /folders/)
6. Configure a variável de ambiente:
   ```bash
   export GOOGLE_DRIVE_FOLDER_ID="seu_id_da_pasta"
   ```

## 6. Testar a Configuração

1. Inicie o servidor: `npm start`
2. Tente cadastrar um item com imagem
3. Verifique se a imagem aparece corretamente

## Estrutura de Arquivos

```
CATALOGO/
├── credentials.json          # Credenciais do Google Drive
├── server/
│   ├── googleDriveConfig.js  # Configuração do Google Drive
│   └── index.js             # Servidor principal
└── ...
```

## Troubleshooting

### Erro: "Arquivo credentials.json não encontrado"
- Verifique se o arquivo está na raiz do projeto
- Verifique se o nome está correto (credentials.json)

### Erro: "Falha na autenticação com Google Drive"
- Verifique se a Google Drive API está habilitada
- Verifique se as credenciais estão corretas
- Verifique se a conta de serviço tem permissões adequadas

### Imagens não aparecem
- Verifique se as URLs do Google Drive estão sendo salvas corretamente no banco
- Verifique se os arquivos foram tornados públicos no Google Drive

## Segurança

- Nunca compartilhe o arquivo `credentials.json`
- Adicione `credentials.json` ao `.gitignore`
- Use variáveis de ambiente para configurações sensíveis
- Considere usar IAM para restringir permissões da conta de serviço 