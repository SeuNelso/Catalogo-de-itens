# Catálogo de Itens com Reconhecimento por Imagem

Um sistema completo de catálogo de itens com funcionalidade de reconhecimento por imagem, desenvolvido com React, Node.js e PostgreSQL. Sistema robusto para gerenciamento de inventários com controle de acesso por usuários.

## 🚀 Funcionalidades

### ✅ Sistema de Usuários e Autenticação
- **Controle de acesso**: Administradores, Controllers e Usuários
- **Autenticação segura**: JWT tokens para sessões
- **Proteção de rotas**: Acesso baseado em roles
- **Gestão de usuários**: Apenas administradores podem criar usuários

### ✅ Cadastro e Gerenciamento de Itens
- **Informações completas**: Código, descrição, família, subfamília, setor
- **Especificações detalhadas**: Dimensões, peso, tipo de controle, unidade de armazenamento
- **Upload de múltiplas imagens**: Até 5 fotos por item
- **Itens compostos**: Sistema para itens formados por outros itens
- **Imagem do item completo**: Foto do item montado para itens compostos
- **Validações robustas**: Códigos únicos, campos obrigatórios

### 🔍 Busca e Filtros Avançados
- **Busca inteligente**: Por código ou descrição (case-insensitive)
- **Filtros múltiplos**: Família, subfamília, setor, quantidade, categoria
- **Ordenação por colunas**: Clique no cabeçalho para ordenar
- **Filtros responsivos**: Interface adaptada para mobile
- **Sistema de paginação**: Navegação eficiente em grandes listas

### 📊 Importação e Exportação de Dados
- **Importação em massa**: Excel com todas as características dos itens
- **Template personalizado**: Download do template com campos corretos
- **Barra de progresso**: Acompanhamento em tempo real
- **Importação de stock nacional**: Sistema específico para estoques
- **Exportação de dados**: Backup completo do catálogo
- **Detecção automática de imagens**: Importação automática de fotos

### 🖼️ Sistema de Imagens Avançado
- **Cloudflare R2**: Armazenamento em nuvem
- **Fallback local**: Sistema robusto com backup
- **Proxy de imagens**: Servir imagens via API
- **Upload múltiplo**: Até 5 imagens por item
- **Preview em tempo real**: Visualização antes do upload
- **Exclusão individual**: Remover imagens específicas

### 📱 Interface Responsiva e Moderna
- **Design mobile-first**: Otimizado para todos os dispositivos
- **Menu hambúrguer**: Navegação mobile intuitiva
- **Cards responsivos**: Visualização adaptativa
- **Autocomplete**: Busca inteligente de itens
- **Animações suaves**: Transições e efeitos visuais
- **Feedback visual**: Toasts e alertas informativos

### 🔧 Funcionalidades Avançadas
- **Itens não cadastrados**: Sincronização entre dispositivos
- **Progress bars**: Acompanhamento de operações longas
- **Sistema de filtros**: Interface intuitiva para busca
- **Ordenação dinâmica**: Por qualquer coluna da tabela
- **Responsividade completa**: Funciona perfeitamente em mobile

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** com Express
- **PostgreSQL** para banco de dados
- **AWS SDK** para Cloudflare R2
- **Multer** para upload de arquivos
- **JWT** para autenticação
- **XLSX** para importação de Excel
- **CORS** para comunicação com frontend

### Frontend
- **React** com React Router
- **Tailwind CSS** para estilização
- **React Icons** e **Feather Icons** para ícones
- **Context API** para gerenciamento de estado
- **Axios** para requisições HTTP
- **React Webcam** para captura de imagens

## 📦 Instalação

### Pré-requisitos
- Node.js (versão 16 ou superior)
- PostgreSQL
- npm ou yarn

## ⚖️ Copyright e Compliance

- Copyright do sistema: `COPYRIGHT.txt`
- Avisos de terceiros (dependências): `THIRD_PARTY_NOTICES.txt`
- Fontes de licenças de dependências: `package-lock.json` e `client/package-lock.json`
- Inventário de licenças (gerado): `THIRD_PARTY_LICENSE_INVENTORY.csv`
- Planilha de licenças com coluna de cor: `THIRD_PARTY_LICENSE_INVENTORY.xlsx`
- Checklist operacional de compliance: `COMPLIANCE_CHECKLIST.txt`
- Kit de auditoria: `COMPLIANCE_EVIDENCE_PACK_TEMPLATE.txt`, `COMPLIANCE_RACI_TEMPLATE.csv`, `GO_LIVE_APPROVAL_TEMPLATE.txt`

Comandos úteis:
```bash
npm run compliance:licenses
npm run compliance:secrets
```

### Passos para instalação

1. **Clone o repositório**
```bash
git clone <url-do-repositorio>
cd CATALOGO
```

2. **Configure o banco de dados PostgreSQL**
```sql
CREATE DATABASE catalogo;
```

3. **Configure as variáveis de ambiente**
```bash
cp server/env.example server/.env
# Edite o arquivo .env com suas configurações
```

4. **Instale as dependências do backend**
```bash
npm install
```

5. **Instale as dependências do frontend**
```bash
cd client
npm install
cd ..
```

6. **Inicie o desenvolvimento**
```bash
npm run dev
```

Isso irá iniciar:
- Backend na porta 5000
- Frontend na porta 3000
- Banco de dados PostgreSQL conectado

## 🚀 Como Usar

### 1. Sistema de Usuários
1. **Login**: Acesse com suas credenciais
2. **Roles**: Administradores têm acesso total
3. **Gestão**: Apenas admins podem criar usuários
4. **Proteção**: Rotas protegidas por role

### 2. Cadastrar Itens
1. Acesse "Cadastrar Item" (apenas admins)
2. Preencha código e descrição
3. Configure família, subfamília, setor
4. Adicione dimensões e especificações
5. Faça upload das imagens (máx. 5)
6. Configure itens compostos se necessário
7. Clique em "Cadastrar"

### 3. Visualizar e Filtrar Itens
1. Acesse "Catálogo"
2. Use a busca por código/descrição
3. Aplique filtros avançados
4. Ordene clicando nos cabeçalhos
5. Visualize em cards (mobile) ou tabela (desktop)

### 4. Importação de Dados
1. **Download do template**: Baixe o Excel com campos corretos
2. **Preencha os dados**: Use o template como guia
3. **Upload**: Faça upload do arquivo preenchido
4. **Acompanhe**: Barra de progresso em tempo real
5. **Verifique**: Confirme os dados importados

### 5. Gerenciar Itens Compostos
1. **Marque como composto**: Checkbox no cadastro
2. **Adicione componentes**: Selecione itens da lista
3. **Configure quantidades**: Especifique quantidades necessárias
4. **Upload imagem completa**: Foto do item montado
5. **Gerencie**: Adicione/remova componentes conforme necessário

## 📁 Estrutura do Projeto

```
CATALOGO/
├── server/
│   ├── index.js              # Servidor Express
│   ├── env.example           # Exemplo de variáveis
│   └── uploads/              # Pasta para uploads
├── client/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── components/
│   │   │   ├── Navbar.js
│   │   │   ├── Toast.js
│   │   │   ├── ProtectedRoute.js
│   │   │   └── ItensCompostos.js
│   │   ├── contexts/
│   │   │   ├── AuthContext.js
│   │   │   └── ImportProgressContext.js
│   │   ├── pages/
│   │   │   ├── Home.js
│   │   │   ├── Login.js
│   │   │   ├── CadastrarItem.js
│   │   │   ├── ListarItens.js
│   │   │   ├── DetalhesItem.js
│   │   │   ├── EditarItem.js
│   │   │   ├── AdminUsuarios.js
│   │   │   ├── ImportarItens.js
│   │   │   ├── ImportarDadosItens.js
│   │   │   └── ExportarDados.js
│   │   ├── App.js
│   │   ├── index.js
│   │   └── index.css
│   └── package.json
├── package.json
└── README.md
```

## 🔧 Configuração

### Variáveis de Ambiente
Configure o arquivo `server/.env`:

```env
# Banco de dados
DB_HOST=localhost
DB_PORT=5432
DB_NAME=catalogo
DB_USER=seu_usuario
DB_PASSWORD=sua_senha

# JWT
JWT_SECRET=sua_chave_secreta

# Cloudflare R2 (opcional)
R2_ACCOUNT_ID=seu_account_id
R2_ACCESS_KEY_ID=sua_access_key
R2_SECRET_ACCESS_KEY=sua_secret_key
R2_BUCKET_NAME=seu_bucket

# Servidor
PORT=5000
NODE_ENV=development
```

### Banco de Dados
O PostgreSQL deve ser configurado com as seguintes tabelas:
- `usuarios`: Sistema de usuários e autenticação
- `itens`: Informações principais dos itens
- `imagens_itens`: Relacionamento com imagens
- `itens_compostos`: Itens formados por outros itens
- `itens_nao_cadastrados`: Sincronização entre dispositivos

## 📱 Funcionalidades Avançadas

### Sistema de Autocomplete
- **Busca inteligente**: Por código ou descrição
- **Navegação por teclado**: Setas, Enter, Escape
- **Resultados limitados**: Máximo 10 itens
- **Case-insensitive**: Não diferencia maiúsculas/minúsculas

### Filtros Avançados
- **Múltiplos critérios**: Família, subfamília, setor, quantidade
- **Interface responsiva**: Adaptada para mobile
- **Layout em lista**: Visual organizado
- **Scroll vertical**: Para muitos filtros
- **Busca case-insensitive**: Em todos os campos

### Sistema de Progress
- **Barras de progresso**: Para operações longas
- **Context global**: Compartilhamento de estado
- **Polling automático**: Atualização em tempo real
- **Feedback visual**: Status e porcentagem

### Responsividade Mobile
- **Menu hambúrguer**: Navegação intuitiva
- **Cards adaptativos**: Visualização otimizada
- **Touch targets**: Áreas de toque adequadas
- **Scroll suave**: Navegação fluida

## 🎨 Design System

### Cores
- **Primária**: #0915FF (Azul)
- **Secundária**: #64748b (Cinza)
- **Sucesso**: #10b981 (Verde)
- **Aviso**: #f59e0b (Amarelo)
- **Erro**: #ef4444 (Vermelho)

### Componentes
- **Botões**: Estados hover, loading, disabled
- **Cards**: Sombras, bordas, hover effects
- **Formulários**: Validação visual, autocomplete
- **Toasts**: Feedback de ações
- **Modais**: Confirmações importantes

## 🔒 Segurança

- **Autenticação JWT**: Tokens seguros
- **Controle de acesso**: Baseado em roles
- **Validação de dados**: Sanitização de entrada
- **Upload seguro**: Validação de tipos de arquivo
- **Proteção de rotas**: Middleware de autenticação

## 🚀 Deploy

### Produção
1. **Build do frontend**:
```bash
cd client
npm run build
```

2. **Configure as variáveis de ambiente para produção**
3. **Use PM2 para o Node.js**:
```bash
npm install -g pm2
pm2 start server/index.js
```

4. **Configure nginx como proxy reverso**

### Docker (Opcional)
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD ["npm", "start"]
```

## 🤝 Contribuição

1. Faça um fork do projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo LICENSE para mais detalhes.

## 🆘 Suporte

Para dúvidas ou problemas:
1. Verifique a documentação
2. Abra uma issue no GitHub
3. Entre em contato com a equipe de desenvolvimento

---

**Desenvolvido com ❤️ para facilitar o gerenciamento de inventários com sistema completo de usuários, autenticação e funcionalidades avançadas.** 