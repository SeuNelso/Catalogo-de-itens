const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testarImportacaoStock() {
  try {
    console.log('🧪 Testando simulação de importação do stock nacional...');
    
    // Simular dados que viriam do Excel
    const dadosSimulados = [
      {
        'Artigo': 'STOCK001',
        'Descrição': 'Item do Stock Nacional 1',
        'TOTAL': 50,
        'WH1': 30,
        'WH2': 20
      },
      {
        'Artigo': 'STOCK002', 
        'Descrição': 'Item do Stock Nacional 2',
        'TOTAL': 25,
        'WH1': 15,
        'WH2': 10
      },
      {
        'Artigo': 'TEST001', // Este já existe
        'Descrição': 'Item de teste 1 (já existe)',
        'TOTAL': 100,
        'WH1': 50,
        'WH2': 50
      }
    ];
    
    console.log(`📊 Processando ${dadosSimulados.length} itens simulados...`);
    
    for (const row of dadosSimulados) {
      const codigo = row['Artigo']?.toString().trim();
      const descricao = row['Descrição']?.toString().trim();
      const nome = descricao;
      
      console.log(`\n🔍 Processando: ${codigo} - ${nome}`);
      
      // Verificar se o artigo já existe
      const existe = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
      console.log(`   Existe no banco: ${existe.rows.length > 0 ? 'SIM' : 'NÃO'}`);
      
      // Coletar armazéns do row
      const armazens = {};
      Object.keys(row).forEach(col => {
        if (col.startsWith('WH')) {
          armazens[col] = Number(row[col]) || 0;
        }
      });
      console.log(`   Armazéns:`, armazens);
      
      if (!existe.rows.length) {
        // Inserir na tabela de itens não cadastrados
        try {
          // Primeiro verificar se já existe na tabela de não cadastrados
          const existeNaoCadastrado = await pool.query('SELECT id FROM itens_nao_cadastrados WHERE codigo = $1', [codigo]);
          
          if (existeNaoCadastrado.rows.length === 0) {
            // Inserir novo item
            await pool.query(
              'INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens) VALUES ($1, $2, $3)',
              [codigo, nome, JSON.stringify(armazens)]
            );
            console.log(`   ✅ Item não cadastrado inserido: ${codigo} - ${nome}`);
          } else {
            // Atualizar item existente
            await pool.query(
              'UPDATE itens_nao_cadastrados SET descricao = $1, armazens = $2, data_importacao = CURRENT_TIMESTAMP WHERE codigo = $3',
              [nome, JSON.stringify(armazens), codigo]
            );
            console.log(`   ✅ Item não cadastrado atualizado: ${codigo} - ${nome}`);
          }
        } catch (insertError) {
          console.error(`   ❌ Erro ao inserir item não cadastrado ${codigo}:`, insertError);
        }
      } else {
        console.log(`   ⏭️  Item já existe, pulando inserção na tabela de não cadastrados`);
      }
    }
    
    // Verificar resultado final
    const resultado = await pool.query('SELECT * FROM itens_nao_cadastrados ORDER BY data_importacao DESC');
    console.log(`\n📋 Resultado final - Total de itens não cadastrados: ${resultado.rows.length}`);
    resultado.rows.forEach((item, index) => {
      console.log(`   ${index + 1}. ${item.codigo} - ${item.descricao}`);
    });
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  } finally {
    await pool.end();
  }
}

testarImportacaoStock(); 