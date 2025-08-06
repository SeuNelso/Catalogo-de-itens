const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testarCadastroItem() {
  try {
    console.log('🧪 Testando cadastro de item e remoção da tabela de não cadastrados...');
    
    // Verificar itens não cadastrados antes
    const antes = await pool.query('SELECT COUNT(*) as total FROM itens_nao_cadastrados');
    console.log(`📊 Total de itens não cadastrados ANTES: ${antes.rows[0].total}`);
    
    // Pegar um item da tabela de não cadastrados
    const itemNaoCadastrado = await pool.query('SELECT * FROM itens_nao_cadastrados LIMIT 1');
    
    if (itemNaoCadastrado.rows.length === 0) {
      console.log('❌ Nenhum item não cadastrado encontrado para teste');
      return;
    }
    
    const item = itemNaoCadastrado.rows[0];
    console.log(`🔍 Testando cadastro do item: ${item.codigo} - ${item.descricao}`);
    
    // Simular dados de cadastro
    const dadosCadastro = {
      codigo: item.codigo,
      descricao: item.descricao,
      categoria: 'Teste',
      nome: item.descricao,
      preco: 0,
      quantidade: 0,
      localizacao: '',
      observacoes: '',
      familia: '',
      subfamilia: '',
      setor: '',
      comprimento: null,
      largura: null,
      altura: null,
      unidade: '',
      peso: '',
      unidadepeso: '',
      unidadearmazenamento: '',
      tipocontrolo: '',
      ativo: true
    };
    
    // Verificar se o item já existe na tabela de itens
    const existe = await pool.query('SELECT id FROM itens WHERE codigo = $1', [item.codigo]);
    
    if (existe.rows.length > 0) {
      console.log(`⚠️  Item ${item.codigo} já existe na tabela de itens, removendo...`);
      await pool.query('DELETE FROM itens WHERE codigo = $1', [item.codigo]);
    }
    
    // Inserir o item na tabela de itens (simulando cadastro)
    const result = await pool.query(`
      INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, ativo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING id
    `, [
      dadosCadastro.nome, dadosCadastro.descricao, dadosCadastro.categoria, dadosCadastro.codigo,
      dadosCadastro.preco, dadosCadastro.quantidade, dadosCadastro.localizacao, dadosCadastro.observacoes,
      dadosCadastro.familia, dadosCadastro.subfamilia, dadosCadastro.setor, dadosCadastro.comprimento,
      dadosCadastro.largura, dadosCadastro.altura, dadosCadastro.unidade, dadosCadastro.peso,
      dadosCadastro.unidadepeso, dadosCadastro.unidadearmazenamento, dadosCadastro.tipocontrolo, dadosCadastro.ativo
    ]);
    
    const itemId = result.rows[0].id;
    console.log(`✅ Item cadastrado com ID: ${itemId}`);
    
    // Remover item da tabela de itens não cadastrados
    const deleteResult = await pool.query('DELETE FROM itens_nao_cadastrados WHERE codigo = $1', [item.codigo]);
    console.log(`🗑️  Item removido da tabela de não cadastrados: ${deleteResult.rowCount} registros removidos`);
    
    // Verificar itens não cadastrados depois
    const depois = await pool.query('SELECT COUNT(*) as total FROM itens_nao_cadastrados');
    console.log(`📊 Total de itens não cadastrados DEPOIS: ${depois.rows[0].total}`);
    
    // Verificar se o item foi removido
    const itemAindaExiste = await pool.query('SELECT id FROM itens_nao_cadastrados WHERE codigo = $1', [item.codigo]);
    console.log(`🔍 Item ainda existe na tabela de não cadastrados: ${itemAindaExiste.rows.length > 0 ? 'SIM' : 'NÃO'}`);
    
    // Verificar se o item foi cadastrado corretamente
    const itemCadastrado = await pool.query('SELECT id, codigo, descricao FROM itens WHERE codigo = $1', [item.codigo]);
    console.log(`✅ Item cadastrado na tabela de itens: ${itemCadastrado.rows.length > 0 ? 'SIM' : 'NÃO'}`);
    
    if (itemCadastrado.rows.length > 0) {
      console.log(`📝 Detalhes do item cadastrado: ${itemCadastrado.rows[0].codigo} - ${itemCadastrado.rows[0].descricao}`);
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  } finally {
    await pool.end();
  }
}

testarCadastroItem(); 