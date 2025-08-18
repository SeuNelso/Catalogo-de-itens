# 📋 Instruções para Importação de Setores

## 🎯 Objetivo
Importar setores para os itens do catálogo a partir de um arquivo Excel (.xlsx).

## 📁 Estrutura do Arquivo Excel

### Colunas Obrigatórias:
- **Artigo**: Código do item (ex: 3000003, 3000004, etc.)
- **SETOR**: Setores associados ao item

### Formato dos Setores:
- **Setor único**: `MOVEL`
- **Múltiplos setores**: `MOVEL, FIBRA, CLIENTE`

## ✅ Setores Válidos Disponíveis

| Setor | Descrição |
|-------|-----------|
| CLIENTE | Setor Cliente |
| ENGENHARIA | Setor Engenharia |
| FIBRA | Setor Fibra |
| FROTA | Setor Frota |
| IT | Setor IT |
| LOGISTICA | Setor Logística |
| MARKETING | Setor Marketing |
| MOVEL | Setor Móvel |
| NOWO | Setor NOWO |
| FERRAMENTA | Setor Ferramenta |
| EPI | Equipamento de Proteção Individual |
| EPC | Equipamento de Proteção Coletiva |

## 📝 Exemplos de Uso

### Exemplo 1: Item com um setor
```
Artigo: 3000003
SETOR: MOVEL
```

### Exemplo 2: Item com múltiplos setores
```
Artigo: 3000020
SETOR: MOVEL, FIBRA
```

### Exemplo 3: Item com três setores
```
Artigo: 3000022
SETOR: FIBRA, CLIENTE, ENGENHARIA
```

## 🚀 Como Importar

### 1. Preparar o Arquivo Excel
- Criar um arquivo .xlsx com as colunas "Artigo" e "SETOR"
- Preencher com os códigos dos itens e seus respectivos setores
- Salvar o arquivo

### 2. Executar a Importação
```bash
node importar_setores.js caminho/para/seu/arquivo.xlsx
```

### 3. Verificar o Resultado
```bash
node verificar_setores.js
```

## 📊 Exemplo de Arquivo Excel

| Artigo | SETOR |
|--------|-------|
| 3000003 | MOVEL |
| 3000004 | MOVEL |
| 3000020 | MOVEL, FIBRA |
| 3000022 | FIBRA, CLIENTE, ENGENHARIA |
| 3000023 | IT, LOGISTICA |

## ⚠️ Regras Importantes

1. **Códigos válidos**: Apenas códigos que existem na tabela `itens` serão processados
2. **Setores válidos**: Apenas setores da lista acima serão aceitos
3. **Múltiplos setores**: Separe por vírgula na mesma célula
4. **Case insensitive**: Os setores são convertidos para maiúsculas automaticamente
5. **Duplicatas**: Setores duplicados são removidos automaticamente

## 🔍 Verificação

Após a importação, você pode:

1. **Ver estatísticas**: O script mostra quantos itens foram processados
2. **Verificar erros**: Itens não encontrados ou setores inválidos são reportados
3. **Consultar no sistema**: Os setores aparecem na lista do catálogo

## 🛠️ Scripts Disponíveis

- `importar_setores.js`: Importa setores do arquivo Excel
- `verificar_setores.js`: Verifica setores importados
- `limpar_setores.js`: Remove todos os setores (cuidado!)
- `criar_excel_setores.js`: Cria arquivo Excel de exemplo

## 📞 Suporte

Se encontrar problemas:
1. Verifique se os códigos dos itens existem no sistema
2. Confirme se os setores estão na lista de setores válidos
3. Verifique o formato do arquivo Excel
4. Execute `node verificar_setores.js` para diagnosticar
