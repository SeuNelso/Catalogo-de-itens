# 📋 Sistema de Requisições - Guia de Implementação

## ✅ O que foi implementado

### 1. Banco de Dados
- ✅ Script SQL criado: `server/create-requisicoes-table.sql`
- ✅ Tabela `requisicoes` com campos:
  - `id` (PK)
  - `item_id` (FK para itens)
  - `quantidade`
  - `armazem_destino`
  - `status` (pendente, atendida, cancelada)
  - `observacoes`
  - `usuario_id` (FK para usuarios)
  - `created_at`, `updated_at`

### 2. Backend (API)
- ✅ Rotas CRUD completas em `server/index.js`:
  - `GET /api/requisicoes` - Listar todas as requisições (com filtros)
  - `GET /api/requisicoes/:id` - Buscar requisição por ID
  - `POST /api/requisicoes` - Criar nova requisição
  - `PUT /api/requisicoes/:id` - Atualizar requisição
  - `DELETE /api/requisicoes/:id` - Deletar requisição

### 3. Frontend
- ✅ `ListarRequisicoes.js` - Lista todas as requisições com filtros e busca
- ✅ `CriarRequisicao.js` - Formulário para criar nova requisição
- ✅ `EditarRequisicao.js` - Formulário para editar requisição existente
- ✅ Rotas adicionadas no `App.js`
- ✅ Link "Requisições" adicionado no `Navbar`

## 🚀 Como Finalizar a Implementação

### Passo 1: Criar a Tabela no Banco de Dados

Execute o script SQL no seu banco PostgreSQL:

```sql
-- Opção 1: Via psql
psql -h seu_host -U seu_usuario -d seu_database -f server/create-requisicoes-table.sql

-- Opção 2: Via cliente PostgreSQL (pgAdmin, DBeaver, etc.)
-- Copie e cole o conteúdo de server/create-requisicoes-table.sql
```

Ou execute diretamente no banco:

```sql
CREATE TABLE IF NOT EXISTS requisicoes (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  armazem_destino VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'pendente' CHECK (status IN ('pendente', 'atendida', 'cancelada')),
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requisicoes_item_id ON requisicoes(item_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_status ON requisicoes(status);
CREATE INDEX IF NOT EXISTS idx_requisicoes_usuario_id ON requisicoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_destino ON requisicoes(armazem_destino);
CREATE INDEX IF NOT EXISTS idx_requisicoes_created_at ON requisicoes(created_at);

CREATE TRIGGER update_requisicoes_updated_at BEFORE UPDATE ON requisicoes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Passo 2: Reiniciar o Servidor

```bash
# Se o servidor estiver rodando, pare e reinicie
npm run dev
```

### Passo 3: Testar o Sistema

1. **Acesse o sistema:** `http://localhost:3000`
2. **Faça login** como admin ou controller
3. **Clique em "Requisições"** no menu
4. **Teste criar uma requisição:**
   - Clique em "Nova Requisição"
   - Selecione um item
   - Digite quantidade e armazém destino
   - Clique em "Criar Requisição"

## 📝 Funcionalidades

### Listar Requisições
- Visualização em tabela (desktop) ou cards (mobile)
- Filtros por status e armazém
- Busca por código, descrição, armazém ou usuário
- Badges coloridos para status:
  - 🟡 Pendente (amarelo)
  - 🟢 Atendida (verde)
  - 🔴 Cancelada (vermelho)

### Criar Requisição
- Busca inteligente de itens (autocomplete)
- Validação de campos obrigatórios
- Seleção de quantidade e armazém destino
- Campo de observações opcional

### Editar Requisição
- Editar todos os campos da requisição
- Alterar status (apenas admin/controller)
- Atualização automática de data

### Deletar Requisição
- Confirmação antes de deletar
- Apenas admin/controller podem deletar

## 🔒 Permissões

- **Todos os usuários autenticados:** Podem visualizar requisições
- **Admin e Controller:** Podem criar, editar e deletar requisições
- **Usuários comuns:** Apenas visualização

## 🎨 Interface

- Design responsivo (mobile-first)
- Cores consistentes com o sistema (#0915FF)
- Feedback visual com toasts
- Loading states durante operações

## 🐛 Troubleshooting

### Erro: "relation requisicoes does not exist"
- Execute o script SQL para criar a tabela

### Erro: "function update_updated_at_column() does not exist"
- Execute o script `server/init-db.sql` primeiro (cria a função)

### Requisições não aparecem
- Verifique se está logado
- Verifique se há requisições cadastradas
- Verifique os filtros aplicados

### Não consigo criar requisição
- Verifique se está logado como admin ou controller
- Verifique se há itens cadastrados no sistema
- Verifique o console do navegador para erros

## 📊 Estrutura da Requisição

```json
{
  "id": 1,
  "item_id": 123,
  "item_codigo": "ITEM001",
  "item_descricao": "Descrição do item",
  "quantidade": 10,
  "armazem_destino": "Armazém Central",
  "status": "pendente",
  "observacoes": "Observações opcionais",
  "usuario_id": 1,
  "usuario_nome": "João Silva",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

## 🎯 Próximos Passos (Opcional)

- [ ] Adicionar exportação de requisições para Excel
- [ ] Adicionar notificações quando requisição é criada/atualizada
- [ ] Adicionar histórico de alterações
- [ ] Adicionar relatórios de requisições
- [ ] Adicionar aprovação de requisições (workflow)

---

**Sistema de Requisições implementado com sucesso! 🎉**
