# 📋 Sistema de Requisições V2 - Múltiplos Itens e Armazéns

## 🎯 Mudanças Implementadas

### 1. **Múltiplos Itens por Requisição**
- ✅ Cada requisição pode conter vários itens
- ✅ Cada item tem sua própria quantidade
- ✅ Interface permite adicionar/remover itens dinamicamente

### 2. **Armazéns Cadastrados no Banco**
- ✅ Tabela `armazens` criada com ID, descrição e localização
- ✅ Armazém selecionado via dropdown (não mais texto livre)
- ✅ Descrição vinculada automaticamente ao ID selecionado

### 3. **Localização Preenchida ao Atender**
- ✅ Campo `localizacao` na tabela `requisicoes`
- ✅ Aparece apenas quando status = "atendida"
- ✅ Preenchido pela pessoa que atende a requisição

## 🗄️ Estrutura do Banco de Dados

### Tabela: `armazens`
```sql
- id (SERIAL PRIMARY KEY)
- descricao (VARCHAR(255) UNIQUE NOT NULL)
- localizacao (TEXT)
- ativo (BOOLEAN DEFAULT true)
- created_at, updated_at
```

### Tabela: `requisicoes` (atualizada)
```sql
- id (SERIAL PRIMARY KEY)
- armazem_id (INTEGER REFERENCES armazens(id))
- localizacao (TEXT) -- Preenchido ao atender
- status (VARCHAR(50))
- observacoes (TEXT)
- usuario_id (INTEGER REFERENCES usuarios(id))
- created_at, updated_at
```

### Tabela: `requisicoes_itens` (nova)
```sql
- id (SERIAL PRIMARY KEY)
- requisicao_id (INTEGER REFERENCES requisicoes(id))
- item_id (INTEGER REFERENCES itens(id))
- quantidade (INTEGER)
- created_at
```

## 🚀 Como Implementar

### Passo 1: Executar Script SQL

Execute o script `server/create-armazens-requisicoes-v2.sql` no banco de dados:

```bash
psql -h seu_host -U seu_usuario -d seu_database -f server/create-armazens-requisicoes-v2.sql
```

**⚠️ ATENÇÃO:** Este script irá:
- Criar a tabela `armazens`
- Criar a tabela `requisicoes_itens`
- Recriar a tabela `requisicoes` (dados antigos serão perdidos!)

### Passo 2: Migrar Dados Existentes (se houver)

Se você já tinha requisições no sistema antigo, execute este script de migração:

```sql
-- 1. Criar armazéns a partir das requisições antigas (se necessário)
INSERT INTO armazens (descricao)
SELECT DISTINCT armazem_destino 
FROM requisicoes_old 
WHERE armazem_destino IS NOT NULL
ON CONFLICT (descricao) DO NOTHING;

-- 2. Migrar requisições (ajustar conforme sua estrutura antiga)
-- Este é apenas um exemplo - ajuste conforme necessário
```

### Passo 3: Cadastrar Armazéns

Após executar o script, cadastre os armazéns:

1. Via API (como admin):
```bash
POST /api/armazens
{
  "descricao": "Armazém Central",
  "localizacao": "Endereço do armazém"
}
```

2. Ou diretamente no banco:
```sql
INSERT INTO armazens (descricao) VALUES
  ('Armazém Central'),
  ('Armazém Norte'),
  ('Armazém Sul');
```

### Passo 4: Reiniciar o Servidor

```bash
npm run dev
```

## 📝 Como Usar

### Criar Requisição

1. Acesse "Requisições" > "Nova Requisição"
2. Selecione o **Armazém Destino** (dropdown)
3. **Adicione itens:**
   - Busque o item por código ou descrição
   - Informe a quantidade
   - Clique em "Adicionar Item"
   - Repita para cada item
4. Adicione observações (opcional)
5. Clique em "Criar Requisição"

### Editar Requisição

1. Clique em "Editar" na requisição desejada
2. Altere o armazém, status ou itens conforme necessário
3. **Se status = "Atendida":**
   - Campo "Localização no Armazém" aparecerá
   - Preencha a localização específica (ex: "Prateleira A3")
4. Salve as alterações

### Listar Requisições

- Visualização em cards mostrando todos os itens
- Filtros por status e armazém
- Busca por item, armazém ou usuário
- Mostra localização quando preenchida

## 🔧 API Endpoints

### Armazéns
- `GET /api/armazens` - Listar armazéns
- `GET /api/armazens/:id` - Buscar armazém
- `POST /api/armazens` - Criar armazém (apenas admin)
- `PUT /api/armazens/:id` - Atualizar armazém (apenas admin)
- `DELETE /api/armazens/:id` - Deletar armazém (apenas admin)

### Requisições
- `GET /api/requisicoes` - Listar requisições (com itens)
- `GET /api/requisicoes/:id` - Buscar requisição (com itens)
- `POST /api/requisicoes` - Criar requisição
  ```json
  {
    "armazem_id": 1,
    "itens": [
      {"item_id": 10, "quantidade": 5},
      {"item_id": 20, "quantidade": 3}
    ],
    "observacoes": "Observações opcionais"
  }
  ```
- `PUT /api/requisicoes/:id` - Atualizar requisição
  ```json
  {
    "armazem_id": 1,
    "status": "atendida",
    "localizacao": "Prateleira A3",
    "itens": [...],
    "observacoes": "..."
  }
  ```
- `DELETE /api/requisicoes/:id` - Deletar requisição

## 🎨 Interface

### Criar Requisição
- Seleção de armazém via dropdown
- Busca de itens com autocomplete
- Lista dinâmica de itens adicionados
- Botão para remover itens individualmente

### Editar Requisição
- Mesma interface de criação
- Campo de localização aparece quando status = "atendida"
- Permite adicionar/remover/editar itens

### Listar Requisições
- Cards mostrando todos os itens da requisição
- Badges coloridos para status
- Filtros por status e armazém
- Busca integrada

## ⚠️ Importante

1. **Backup:** Faça backup do banco antes de executar o script SQL
2. **Dados Antigos:** Requisições antigas serão perdidas ao recriar a tabela
3. **Armazéns:** Cadastre os armazéns antes de criar requisições
4. **Permissões:** Apenas admins podem criar/editar/deletar armazéns

## 🐛 Troubleshooting

### Erro: "armazem_id não encontrado"
- Verifique se o armazém existe e está ativo
- Cadastre armazéns antes de criar requisições

### Erro: "itens array vazio"
- Adicione pelo menos um item à requisição
- Verifique se os itens existem no banco

### Localização não aparece
- O campo só aparece quando status = "atendida"
- Altere o status para "atendida" primeiro

---

**Sistema atualizado com sucesso! 🎉**
