# Importação de Unidades de Armazenamento

## 📊 **Funcionalidade**

Importe unidades de armazenamento para os itens do catálogo a partir de um arquivo Excel.

## 📋 **Estrutura do Arquivo Excel**

O arquivo deve ter as seguintes colunas:

| Coluna | Nome | Descrição | Exemplo |
|--------|------|-----------|---------|
| A | `Artigo` | Código do item | `3000003` |
| B | `UNIDADE_ARMAZENAMENTO` | Unidade de armazenamento | `UN` |

### **Exemplo de Dados:**

| Artigo | UNIDADE_ARMAZENAMENTO |
|--------|----------------------|
| 3000003| UN                   |
| 3000004| KG                   |
| 3000020| M                    |
| 3000022| L                    |
| 3000023| PÇ                   |

## ✅ **Unidades Válidas**

As seguintes unidades são aceitas pelo sistema:

### **Unidades Básicas:**
- `UN` - Unidade
- `KG` - Quilograma
- `M` - Metro
- `L` - Litro
- `PÇ` - Peça

### **Unidades Específicas:**
- `ROL` - Rolo
- `CAIXA` - Caixa
- `PACOTE` - Pacote
- `METRO` - Metro
- `LITRO` - Litro
- `QUILO` - Quilo
- `PECA` - Peça
- `UNIDADE` - Unidade

### **Unidades de Medida:**
- `CM` - Centímetro
- `MM` - Milímetro
- `TON` - Tonelada
- `G` - Grama
- `ML` - Mililitro
- `M2` - Metro quadrado
- `M3` - Metro cúbico

### **Variações:**
- `PCS` - Peças
- `UNID` - Unidade
- `LITROS` - Litros
- `QUILOS` - Quilos
- `METROS` - Metros
- `PECAS` - Peças
- `UNIDADES` - Unidades

## 🔧 **Como Usar**

### **1. Acessar a Funcionalidade:**
- Faça login no sistema
- Vá para o menu "Dados" → "Importar Unidades"
- Ou acesse diretamente: `/importar-unidades`

### **2. Preparar o Arquivo:**
- Crie um arquivo Excel (.xlsx ou .xls)
- Use a estrutura mostrada acima
- Certifique-se de que os códigos dos artigos existem no sistema
- Use apenas unidades válidas

### **3. Fazer Upload:**
- Clique em "Baixar Template" para obter um exemplo
- Preencha o arquivo com seus dados
- Clique em "Clique para selecionar" e escolha o arquivo
- Clique em "Importar Unidades"

### **4. Acompanhar o Progresso:**
- A barra de progresso mostra o status da importação
- Aguarde a conclusão do processamento
- Verifique os resultados na tela

## 📊 **Resultados da Importação**

Após a importação, você verá:

### **Estatísticas:**
- **Itens Processados**: Número de itens atualizados com sucesso
- **Total de Linhas**: Número total de linhas no arquivo
- **Erros**: Número de erros encontrados
- **Itens Não Encontrados**: Códigos que não existem no sistema
- **Unidades Inválidas**: Unidades não reconhecidas

### **Detalhes dos Erros:**
- Lista detalhada de todos os erros encontrados
- Linha do arquivo onde ocorreu o erro
- Código do item e descrição do erro
- Unidade inválida (se aplicável)

## ⚠️ **Regras Importantes**

### **Validações:**
1. **Códigos Válidos**: Apenas códigos que existem no sistema serão processados
2. **Unidades Válidas**: Apenas unidades da lista acima são aceitas
3. **Formato**: O arquivo deve ser Excel (.xlsx ou .xls)
4. **Estrutura**: As colunas devem ter os nomes exatos: `Artigo` e `UNIDADE_ARMAZENAMENTO`

### **Comportamento:**
- **Unidades Vazias**: Não alteram o valor existente no sistema
- **Conversão**: Todas as unidades são convertidas para maiúsculas
- **Duplicatas**: Se o mesmo código aparecer múltiplas vezes, a última linha será usada
- **Case Insensitive**: As unidades não são sensíveis a maiúsculas/minúsculas

### **Limitações:**
- Uma unidade por item (não aceita múltiplas unidades)
- Não é possível importar unidades para itens inativos
- O arquivo deve ter no máximo 10MB

## 🔍 **Exemplos de Uso**

### **Exemplo 1: Atualizar Unidades Básicas**
```
Artigo,UNIDADE_ARMAZENAMENTO
3000003,UN
3000004,KG
3000020,M
```

### **Exemplo 2: Usar Unidades Específicas**
```
Artigo,UNIDADE_ARMAZENAMENTO
3000003,CAIXA
3000004,PACOTE
3000020,ROL
```

### **Exemplo 3: Unidades de Medida**
```
Artigo,UNIDADE_ARMAZENAMENTO
3000003,CM
3000004,MM
3000020,M2
```

## 🚨 **Tratamento de Erros**

### **Erros Comuns:**

1. **"Código do artigo não encontrado"**
   - Verifique se o código existe no sistema
   - Certifique-se de que não há espaços extras

2. **"Unidade de armazenamento inválida"**
   - Use apenas unidades da lista de unidades válidas
   - Verifique se não há erros de digitação

3. **"Item não encontrado no sistema"**
   - O código do artigo não existe no banco de dados
   - Verifique se o item foi cadastrado corretamente

4. **"Erro durante a importação"**
   - Problema técnico no servidor
   - Tente novamente ou contate o administrador

## 📞 **Suporte**

Se encontrar problemas:

1. Verifique se o arquivo está no formato correto
2. Confirme se os códigos dos artigos existem no sistema
3. Use apenas unidades válidas da lista
4. Se o problema persistir, contate o administrador do sistema

## 🎯 **Dicas**

- **Teste com poucos itens primeiro** para verificar se tudo está funcionando
- **Use o template** fornecido pelo sistema como base
- **Verifique os resultados** após cada importação
- **Mantenha backup** dos dados antes de fazer importações em massa
- **Use unidades consistentes** em todo o catálogo

A importação de unidades de armazenamento facilita a padronização e organização do catálogo! 🎉
