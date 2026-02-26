# 🔧 Solução de Problemas - npm não funciona

Este guia ajudará você a resolver problemas com o npm no Windows.

## 🔍 Diagnóstico

### 1. Verificar se Node.js está instalado

Abra o PowerShell ou CMD e execute:

```powershell
node --version
npm --version
```

**Se aparecer erro "não reconhecido como comando":**
- Node.js não está instalado ou não está no PATH
- Continue para a seção "Instalar Node.js"

**Se aparecer versões (ex: v18.17.0 e 9.6.7):**
- Node.js está instalado ✅
- Continue para a seção "Problemas Comuns"

## 📥 Instalar Node.js

### Opção 1: Download Direto (Recomendado)

1. Acesse: https://nodejs.org/
2. Baixe a versão **LTS** (Long Term Support)
3. Execute o instalador `.msi`
4. **IMPORTANTE:** Durante a instalação, marque a opção:
   - ✅ "Add to PATH" (Adicionar ao PATH)
5. Reinicie o terminal após a instalação

### Opção 2: Via Chocolatey (se você tem Chocolatey)

```powershell
choco install nodejs-lts
```

### Opção 3: Via Winget (Windows 10/11)

```powershell
winget install OpenJS.NodeJS.LTS
```

### Verificar Instalação

Após instalar, feche e abra um NOVO terminal e execute:

```powershell
node --version
npm --version
```

## 🐛 Problemas Comuns

### Problema 1: "npm não é reconhecido como comando interno"

**Solução:**

1. **Verificar se Node.js está instalado:**
   ```powershell
   where.exe node
   ```

2. **Se não encontrar, adicionar ao PATH manualmente:**
   - Pressione `Win + R`
   - Digite: `sysdm.cpl` e pressione Enter
   - Vá em "Avançado" > "Variáveis de Ambiente"
   - Em "Variáveis do sistema", encontre "Path"
   - Clique em "Editar"
   - Adicione: `C:\Program Files\nodejs\`
   - Clique em "OK" em todas as janelas
   - **Reinicie o terminal**

3. **Verificar novamente:**
   ```powershell
   npm --version
   ```

### Problema 2: Permissões no Windows

**Solução:**

Execute o PowerShell como Administrador:

1. Clique com botão direito no PowerShell
2. Selecione "Executar como administrador"
3. Execute seus comandos npm

### Problema 3: Cache corrompido

**Solução:**

Limpar cache do npm:

```powershell
npm cache clean --force
```

### Problema 4: Versão antiga do npm

**Solução:**

Atualizar npm:

```powershell
npm install -g npm@latest
```

### Problema 5: Firewall/Antivírus bloqueando

**Solução:**

1. Adicione exceções no Windows Defender/Firewall para:
   - `node.exe`
   - `npm.cmd`
   - Pasta: `C:\Users\SeuUsuario\AppData\Roaming\npm`

2. Configure seu antivírus para não escanear:
   - `node_modules/`
   - Pasta do projeto

## 🔄 Alternativas ao npm

### Usar yarn (se npm não funcionar)

```powershell
# Instalar yarn globalmente
npm install -g yarn

# Usar yarn no lugar de npm
yarn install          # em vez de npm install
yarn add pacote       # em vez de npm install pacote
yarn start            # em vez de npm start
```

### Usar pnpm

```powershell
# Instalar pnpm
npm install -g pnpm

# Usar pnpm
pnpm install
pnpm start
```

## ✅ Teste Rápido

Após resolver, teste no diretório do projeto:

```powershell
cd C:\Users\felip\Documents\GitHub\Catalogo-de-itens
npm --version
npm install
```

## 📞 Ainda não funciona?

### Informações para diagnóstico:

Execute e compartilhe os resultados:

```powershell
# Versões
node --version
npm --version

# Localização
where.exe node
where.exe npm

# Variáveis de ambiente
echo $env:PATH

# Teste de instalação
npm install -g npm-check-updates
```

### Verificações adicionais:

1. **Reinicie o computador** (às vezes resolve problemas de PATH)
2. **Use um terminal diferente:**
   - PowerShell
   - CMD
   - Git Bash
   - Terminal do VS Code
3. **Verifique se há múltiplas instalações do Node.js**
4. **Desinstale e reinstale o Node.js** (último recurso)

## 🎯 Comandos Úteis

```powershell
# Verificar instalação global do npm
npm list -g --depth=0

# Atualizar npm
npm install -g npm@latest

# Verificar configuração do npm
npm config list

# Limpar cache
npm cache clean --force

# Verificar permissões
npm config get prefix
```

## 📚 Recursos

- Documentação oficial: https://docs.npmjs.com/
- Node.js Downloads: https://nodejs.org/
- Problemas conhecidos: https://github.com/npm/cli/issues

---

**Dica:** Se nada funcionar, considere usar o **Docker** ou **WSL2** (Windows Subsystem for Linux) para um ambiente mais estável.
