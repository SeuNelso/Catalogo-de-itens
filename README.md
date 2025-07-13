# Catálogo de Itens com Reconhecimento por Imagem

Um sistema completo de catálogo de itens com funcionalidade de reconhecimento por imagem, desenvolvido com React, Node.js e SQLite.

## 🚀 Funcionalidades

### ✅ Cadastro de Itens
- **Informações obrigatórias**: Nome e categoria
- **Campos opcionais**: Marca, modelo, código, preço, quantidade, localização
- **Especificações customizáveis**: Adicione especificações únicas para cada item
- **Upload de múltiplas imagens**: Até 10 fotos por item
- **Validações**: Códigos únicos, campos obrigatórios

### 📸 Reconhecimento por Imagem
- **Webcam**: Tire fotos diretamente pela câmera
- **Upload de arquivos**: Faça upload de imagens existentes
- **Busca inteligente**: Encontre itens similares no catálogo
- **Resultados em tempo real**: Visualize itens encontrados

### 📋 Gerenciamento de Itens
- **Visualização em cards e tabela**: Duas formas de visualizar os itens
- **Busca e filtros**: Encontre itens por nome, categoria, marca, etc.
- **Detalhes completos**: Visualize todas as informações e imagens
- **Edição e exclusão**: Gerencie seus itens facilmente

### 🎨 Interface Moderna
- **Design responsivo**: Funciona em desktop e mobile
- **Cor primária #0915FF**: Mantém a identidade visual
- **Animações suaves**: Transições e efeitos visuais
- **Tooltips informativos**: Descrições completas em hover

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** com Express
- **SQLite** para banco de dados
- **Multer** para upload de arquivos
- **CORS** para comunicação com frontend

### Frontend
- **React** com React Router
- **Axios** para requisições HTTP
- **React Webcam** para captura de imagens
- **Lucide React** para ícones
- **CSS customizado** com variáveis CSS

## 📦 Instalação

### Pré-requisitos
- Node.js (versão 14 ou superior)
- npm ou yarn

### Passos para instalação

1. **Clone o repositório**
```bash
git clone <url-do-repositorio>
cd catalogo-itens
```

2. **Instale as dependências do backend**
```bash
npm install
```

3. **Instale as dependências do frontend**
```bash
cd client
npm install
cd ..
```

4. **Inicie o desenvolvimento**
```bash
npm run dev
```

Isso irá iniciar:
- Backend na porta 5000
- Frontend na porta 3000
- Banco de dados SQLite será criado automaticamente

## 🚀 Como Usar

### 1. Cadastrar Itens
1. Acesse a página "Cadastrar"
2. Preencha as informações obrigatórias (nome e categoria)
3. Adicione informações opcionais conforme necessário
4. Configure especificações customizadas
5. Faça upload das imagens do item
6. Clique em "Cadastrar Item"

### 2. Visualizar Itens
1. Acesse a página "Itens"
2. Use a busca para encontrar itens específicos
3. Filtre por categoria
4. Alterne entre visualização em cards ou tabela
5. Clique em "Ver" para ver detalhes completos

### 3. Reconhecimento por Imagem
1. Acesse a página "Reconhecimento"
2. Escolha entre usar webcam ou upload
3. Capture ou selecione uma imagem
4. Clique em "Reconhecer"
5. Visualize os resultados encontrados

## 📁 Estrutura do Projeto

```
catalogo-itens/
├── server/
│   └── index.js          # Servidor Express
├── client/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── components/
│   │   │   └── Navbar.js
│   │   ├── pages/
│   │   │   ├── Home.js
│   │   │   ├── CadastrarItem.js
│   │   │   ├── ListarItens.js
│   │   │   ├── Reconhecimento.js
│   │   │   └── DetalhesItem.js
│   │   ├── App.js
│   │   ├── index.js
│   │   ├── index.css
│   │   └── App.css
│   └── package.json
├── uploads/              # Pasta para imagens (criada automaticamente)
├── catalogo.db          # Banco SQLite (criado automaticamente)
├── package.json
└── README.md
```

## 🔧 Configuração

### Variáveis de Ambiente
Crie um arquivo `.env` na raiz do projeto:

```env
PORT=5000
NODE_ENV=development
```

### Banco de Dados
O SQLite será criado automaticamente na primeira execução. As tabelas incluem:
- `itens`: Informações principais dos itens
- `imagens_itens`: Relacionamento com imagens
- `especificacoes`: Especificações customizadas

## 📱 Funcionalidades Avançadas

### Especificações Customizáveis
- Adicione especificações únicas para cada item
- Marque especificações como obrigatórias
- Valores dinâmicos para cada especificação

### Sistema de Imagens
- Upload de múltiplas imagens
- Preview em tempo real
- Galeria de imagens nos detalhes
- Validação de tipos de arquivo

### Busca Inteligente
- Busca por texto em múltiplos campos
- Filtros por categoria
- Visualização em cards ou tabela
- Tooltips para informações completas

## 🎨 Design System

### Cores
- **Primária**: #0915FF
- **Secundária**: #64748b
- **Sucesso**: #10b981
- **Aviso**: #f59e0b
- **Erro**: #ef4444

### Componentes
- Botões com estados hover e loading
- Cards com sombras e bordas
- Formulários com validação visual
- Alertas para feedback do usuário
- Modais para ações importantes

## 🔒 Segurança

- Validação de tipos de arquivo (apenas imagens)
- Limite de tamanho de arquivo (5MB)
- Sanitização de dados de entrada
- Validação de campos obrigatórios
- Códigos únicos para evitar duplicatas

## 🚀 Deploy

### Produção
1. Build do frontend:
```bash
cd client
npm run build
```

2. Configure as variáveis de ambiente para produção
3. Use um servidor como PM2 para o Node.js
4. Configure um proxy reverso (nginx) se necessário

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

**Desenvolvido com ❤️ para facilitar o gerenciamento de inventários com reconhecimento por imagem.** 