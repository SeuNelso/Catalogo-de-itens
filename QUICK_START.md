# 🚀 Início Rápido

Guia rápido para começar a trabalhar no projeto.

## ⚡ Setup Rápido (5 minutos)

### 1. Instalar Dependências
```bash
npm run install-all
```

### 2. Configurar Ambiente
O arquivo `.env` já foi criado em `server/.env` com as configurações atuais.

**⚠️ IMPORTANTE:** Revise e ajuste as credenciais conforme necessário.

### 3. Iniciar Desenvolvimento

**Opção A: Usando npm (recomendado)**
```bash
npm run dev
```

**Opção B: Usando script .bat (Windows)**
```bash
.\start-dev.bat
```

**Opção C: Separadamente (se npm run dev não funcionar)**
```bash
# Terminal 1 - Backend
npm run server
# ou
.\start-server-only.bat

# Terminal 2 - Frontend  
cd client
npm start
```

Isso iniciará:
- ✅ Backend na porta 3001
- ✅ Frontend na porta 3000

### 4. Acessar o Sistema
Abra seu navegador em: `http://localhost:3000`

## 📝 Próximos Passos

1. **Criar primeiro usuário administrador** (se ainda não existir)
2. **Fazer login** no sistema
3. **Começar a cadastrar itens**

## 🔧 Comandos Úteis

```bash
# Desenvolvimento completo (backend + frontend)
npm run dev

# Apenas backend
npm run server

# Apenas frontend
cd client && npm start

# Build para produção
npm run build
```

## 📚 Documentação Completa

- **SETUP.md** - Guia completo de configuração
- **README.md** - Documentação geral do projeto
- **DEPLOYMENT_ENV_SETUP.md** - Configuração para deploy

## ✅ Checklist de Ambiente

- [x] Dependências instaladas
- [x] Arquivo `.env` configurado
- [x] Credenciais movidas para variáveis de ambiente
- [x] Código sem credenciais hardcoded
- [x] Estrutura de diretórios criada
- [x] Scripts de inicialização criados

## 🆘 Problemas?

### npm run dev não funciona?
- Execute: `.\start-dev.bat` (script Windows que verifica tudo automaticamente)
- Ou execute separadamente: `.\start-server-only.bat` e depois `cd client && npm start`
- Consulte: **DEBUG_SERVER.md** para diagnóstico detalhado
- Execute diagnóstico: `node test-server.js`

### npm não funciona?
- Execute: `.\check-npm.bat` (arquivo .bat, funciona sem problemas de política)
- Ou consulte: **FIX_NPM.md** para solução rápida
- Guia completo: **TROUBLESHOOTING_NPM.md**

### Outros problemas?
Consulte o arquivo **SETUP.md** para solução de problemas comuns.

---

**Ambiente pronto para desenvolvimento! 🎉**
