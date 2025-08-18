const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Conexão com PostgreSQL (Railway)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function executarMigracao() {
  try {
    console.log('🔄 Iniciando migração dos setores...');
    
    // 1. Criar tabela itens_setores
    console.log('📋 Criando tabela itens_setores...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS itens_setores (
        id SERIAL PRIMARY KEY,
        item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
        setor TEXT NOT NULL,
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 2. Verificar se já existem dados na tabela itens_setores
    const checkResult = await pool.query('SELECT COUNT(*) as total FROM itens_setores');
    const totalSetores = parseInt(checkResult.rows[0].total);
    
    if (totalSetores === 0) {
      console.log('📊 Migrando dados existentes da coluna setor...');
      
      // Migrar dados existentes
      await pool.query(`
        INSERT INTO itens_setores (item_id, setor)
        SELECT id, setor 
        FROM itens 
        WHERE setor IS NOT NULL AND setor != '';
      `);
      
      console.log('✅ Dados migrados com sucesso!');
    } else {
      console.log('ℹ️  Tabela itens_setores já possui dados, pulando migração.');
    }
    
    // 3. Criar índices
    console.log('🔍 Criando índices...');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_itens_setores_item_id ON itens_setores(item_id);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_itens_setores_setor ON itens_setores(setor);');
    
    // 4. Verificar a migração
    console.log('🔍 Verificando migração...');
    const result = await pool.query(`
      SELECT 
        i.id,
        i.codigo,
        i.nome,
        STRING_AGG(is2.setor, ', ') as setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      GROUP BY i.id, i.codigo, i.nome
      LIMIT 5;
    `);
    
    console.log('📊 Exemplo de itens com setores:');
    result.rows.forEach(row => {
      console.log(`  - ${row.codigo}: ${row.setores || 'Sem setores'}`);
    });
    
    console.log('✅ Migração concluída com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro durante a migração:', error);
  } finally {
    await pool.end();
  }
}

executarMigracao();
