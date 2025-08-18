# Troubleshooting - Importação de Unidades

## 🔍 **Diagnóstico de Problemas**

Se a importação de unidades não está funcionando corretamente, siga este guia para identificar e resolver o problema.

## 📋 **Checklist de Verificação**

### **1. Verificar o Arquivo Excel**

#### **Estrutura Correta:**
```
| Artigo | UNIDADE_ARMAZENAMENTO |
|--------|----------------------|
| 3000003| UN                   |
| 3000004| KG                   |
| 3000020| M                    |
```

#### **Problemas Comuns:**
- ❌ **Colunas com nomes errados**: `artigo` em vez de `Artigo`
- ❌ **Espaços extras**: `Artigo ` em vez de `Artigo`
- ❌ **Formato incorreto**: Arquivo CSV em vez de Excel
- ❌ **Encoding incorreto**: Caracteres especiais corrompidos

#### **Como Verificar:**
1. Abra o arquivo no Excel
2. Verifique se as colunas têm exatamente os nomes: `Artigo` e `UNIDADE_ARMAZENAMENTO`
3. Verifique se não há espaços extras nos nomes das colunas
4. Salve como `.xlsx` (não `.csv`)

### **2. Verificar Códigos dos Itens**

#### **Problemas Comuns:**
- ❌ **Códigos inexistentes**: Códigos que não estão no sistema
- ❌ **Espaços extras**: ` 3000003` em vez de `3000003`
- ❌ **Formato incorreto**: `300003` em vez de `3000003`

#### **Como Verificar:**
1. Acesse o catálogo e procure pelos códigos
2. Verifique se os códigos existem no sistema
3. Certifique-se de que não há espaços extras

### **3. Verificar Unidades**

#### **Unidades Válidas:**
```
UN, KG, M, L, PÇ, ROL, CAIXA, PACOTE, METRO, LITRO, QUILO, PECA, UNIDADE, 
CM, MM, TON, G, ML, PCS, UNID, M2, M3, LITROS, QUILOS, METROS, PECAS, UNIDADES
```

#### **Problemas Comuns:**
- ❌ **Unidades inválidas**: `UNIDADE` em vez de `UN`
- ❌ **Case sensitive**: `kg` em vez de `KG`
- ❌ **Espaços extras**: ` KG ` em vez de `KG`

### **4. Verificar Permissões**

#### **Requisitos:**
- ✅ Usuário logado
- ✅ Role: `admin` ou `controller`
- ✅ Token válido

#### **Como Verificar:**
1. Verifique se está logado
2. Verifique se tem permissões adequadas
3. Tente fazer logout e login novamente

## 🚨 **Problemas Específicos e Soluções**

### **Problema 1: "Nenhum arquivo enviado"**
**Causa:** Arquivo não foi selecionado ou erro no upload
**Solução:**
1. Verifique se selecionou um arquivo
2. Verifique se o arquivo é Excel (.xlsx ou .xls)
3. Verifique se o arquivo não está corrompido

### **Problema 2: "Formato de arquivo não suportado"**
**Causa:** Arquivo não é Excel
**Solução:**
1. Salve o arquivo como `.xlsx`
2. Não use arquivos CSV
3. Verifique a extensão do arquivo

### **Problema 3: "Código do artigo não encontrado"**
**Causa:** Coluna `Artigo` vazia ou com dados inválidos
**Solução:**
1. Verifique se a coluna `Artigo` tem dados
2. Verifique se não há linhas vazias
3. Verifique se os códigos estão corretos

### **Problema 4: "Item não encontrado no sistema"**
**Causa:** Códigos que não existem no catálogo
**Solução:**
1. Verifique se os códigos existem no sistema
2. Verifique se não há erros de digitação
3. Use apenas códigos válidos

### **Problema 5: "Unidade de armazenamento inválida"**
**Causa:** Unidade não está na lista de unidades válidas
**Solução:**
1. Use apenas unidades da lista de unidades válidas
2. Verifique se não há espaços extras
3. Use maiúsculas (ex: `KG` em vez de `kg`)

### **Problema 6: "Erro durante a importação"**
**Causa:** Erro técnico no servidor
**Solução:**
1. Verifique os logs do servidor
2. Tente novamente
3. Se persistir, contate o administrador

## 🔧 **Logs de Debug**

### **Verificar Logs do Servidor:**
```bash
# No terminal do servidor, procure por:
📁 Arquivo recebido: [nome_do_arquivo]
📊 Processando [X] linhas do arquivo
🔍 Processando linha [X]: [código] -> [unidade]
✅ Item [código] atualizado com unidade: [unidade]
❌ [erro específico]
```

### **Verificar Logs do Frontend:**
1. Abra o DevTools (F12)
2. Vá para a aba "Console"
3. Procure por erros durante o upload

## 📊 **Teste Manual**

### **Passo a Passo:**
1. **Criar arquivo de teste simples:**
   ```
   Artigo,UNIDADE_ARMAZENAMENTO
   3000003,UN
   3000004,KG
   ```

2. **Salvar como Excel (.xlsx)**

3. **Fazer upload e verificar:**
   - Se o arquivo é aceito
   - Se os dados são processados
   - Se as unidades são atualizadas

4. **Verificar no catálogo:**
   - Se as unidades foram atualizadas
   - Se os itens mostram as novas unidades

## 🆘 **Contato para Suporte**

Se o problema persistir:

1. **Coletar informações:**
   - Screenshot do erro
   - Arquivo Excel usado
   - Logs do servidor
   - Logs do navegador

2. **Enviar para o administrador:**
   - Descrição detalhada do problema
   - Passos para reproduzir
   - Informações coletadas

## ✅ **Verificação Final**

Após resolver o problema, verifique:

1. ✅ Arquivo Excel com estrutura correta
2. ✅ Códigos dos itens existem no sistema
3. ✅ Unidades são válidas
4. ✅ Usuário tem permissões adequadas
5. ✅ Upload é bem-sucedido
6. ✅ Unidades são atualizadas no catálogo

A importação de unidades deve funcionar corretamente seguindo estas verificações! 🎉
