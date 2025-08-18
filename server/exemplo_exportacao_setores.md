# Exportação de Itens com Setores Múltiplos

## 📊 **Nova Funcionalidade**

A exportação de itens agora inclui **todos os setores** que cada item pertence, não apenas um setor único.

## 🔄 **Mudanças Implementadas**

### **Antes:**
- ❌ Coluna "Setor" com apenas um setor por item
- ❌ Dados da coluna `setor` da tabela `itens`
- ❌ Largura da coluna: 18 caracteres

### **Agora:**
- ✅ Coluna "Setores" com múltiplos setores por item
- ✅ Dados da tabela `itens_setores` usando `STRING_AGG`
- ✅ Largura da coluna: 25 caracteres (maior para acomodar múltiplos setores)

## 📋 **Estrutura do Excel Exportado**

| Código | Descrição | Unidade base | Família | Subfamília | **Setores** | Ativo | Quantidade |
|--------|-----------|--------------|---------|------------|-------------|-------|------------|
| 3000003 | ABIA AIRSCALE... | UN | Família A | Sub A | **MOVEL** | true | 28 |
| 3000020 | ABRAÇADEIRA... | UN | Família B | Sub B | **MOVEL, FIBRA** | true | 150 |
| 3000022 | DISJUNTOR... | UN | Família C | Sub C | **FIBRA, CLIENTE, ENGENHARIA** | true | 75 |

## 🔧 **Implementação Técnica**

### **Query SQL Atualizada:**
```sql
SELECT 
  i.codigo, 
  i.descricao, 
  i.unidadearmazenamento, 
  i.familia, 
  i.subfamilia, 
  i.ativo, 
  i.quantidade,
  STRING_AGG(DISTINCT is2.setor, ', ') as setores
FROM itens i
LEFT JOIN itens_setores is2 ON i.id = is2.item_id
WHERE i.ativo = true
GROUP BY i.id, i.codigo, i.descricao, i.unidadearmazenamento, i.familia, i.subfamilia, i.ativo, i.quantidade
ORDER BY i.codigo
```

### **Benefícios:**
- ✅ **Dados Completos**: Todos os setores de cada item são incluídos
- ✅ **Formato Legível**: Setores separados por vírgula e espaço
- ✅ **Compatibilidade**: Funciona com itens que têm um ou múltiplos setores
- ✅ **Performance**: Query otimizada com GROUP BY

## 🎯 **Exemplos de Saída**

### **Item com 1 Setor:**
```
Setores: MOVEL
```

### **Item com 2 Setores:**
```
Setores: MOVEL, FIBRA
```

### **Item com 3 Setores:**
```
Setores: FIBRA, CLIENTE, ENGENHARIA
```

### **Item sem Setores:**
```
Setores: (vazio)
```

## 🚀 **Como Usar**

1. Acesse a página "Exportar Catálogo"
2. Clique em "Exportar Catálogo"
3. O arquivo `catalogo_itens.xlsx` será baixado
4. Abra o Excel e veja a coluna "Setores" com todos os setores de cada item

A exportação agora fornece uma visão completa de todos os setores associados a cada item do catálogo! 🎉
