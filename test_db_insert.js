const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testInsert() {
  try {
    const testData = {
      nome: 'Produto de teste',
      descricao: 'Descrição de teste',
      categoria: 'Categoria teste',
      codigo: 'TEST_DB_001',
      quantidade: 10,
      preco: 150.75,
      localizacao: 'Prateleira teste',
      observacoes: 'Observações de teste para verificar se está funcionando',
      familia: 'Família teste',
      subfamilia: 'Subfamília teste',
      setor: 'TI',
      comprimento: 25.5,
      largura: 14.2,
      altura: 5.1,
      unidade: 'cm',
      peso: '250',
      unidadePeso: 'g',
      unidadeArmazenamento: 'un',
      tipocontrolo: 'Automático'
    };

    console.log('=== TESTE DE INSERÇÃO NO BANCO ===');
    console.log('Dados a serem inseridos:', testData);

    const result = await pool.query(
      `INSERT INTO itens (
        nome, descricao, categoria, codigo, quantidade, preco, 
        localizacao, observacoes, familia, subfamilia, setor, comprimento, 
        largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [
        testData.nome, testData.descricao, testData.categoria, testData.codigo, testData.quantidade,
        testData.preco, testData.localizacao, testData.observacoes, testData.familia, testData.subfamilia,
        testData.setor, testData.comprimento, testData.largura, testData.altura, testData.unidade,
        testData.peso, testData.unidadePeso, testData.unidadeArmazenamento, testData.tipocontrolo
      ]
    );

    console.log('✅ Inserção bem-sucedida! ID:', result.rows[0].id);

    // Verificar se os dados foram inseridos corretamente
    const checkResult = await pool.query('SELECT * FROM itens WHERE codigo = $1', [testData.codigo]);
    const insertedItem = checkResult.rows[0];

    console.log('=== DADOS INSERIDOS ===');
    console.log('ID:', insertedItem.id);
    console.log('Nome:', insertedItem.nome);
    console.log('Código:', insertedItem.codigo);
    console.log('--- CAMPOS PROBLEMÁTICOS ---');
    console.log('Família:', insertedItem.familia);
    console.log('Subfamília:', insertedItem.subfamilia);
    console.log('Unidade Armazenamento:', insertedItem.unidadearmazenamento);
    console.log('Tipo Controle:', insertedItem.tipocontrolo);
    console.log('Observações:', insertedItem.observacoes);
    console.log('--- OUTROS CAMPOS ---');
    console.log('Marca:', insertedItem.marca);
    console.log('Modelo:', insertedItem.modelo);
    console.log('Preço:', insertedItem.preco);
    console.log('Localização:', insertedItem.localizacao);
    console.log('Setor:', insertedItem.setor);
    console.log('Dimensões:', insertedItem.comprimento, 'x', insertedItem.largura, 'x', insertedItem.altura);
    console.log('Peso:', insertedItem.peso, insertedItem.unidadepeso);
    console.log('=============================');

    // Limpar o teste
    await pool.query('DELETE FROM itens WHERE codigo = $1', [testData.codigo]);
    console.log('🧹 Dados de teste removidos.');

  } catch (error) {
    console.error('❌ Erro na inserção:', error);
  } finally {
    await pool.end();
  }
}

testInsert(); 