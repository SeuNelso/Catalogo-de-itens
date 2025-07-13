const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Função para limpar o banco de dados
function limparBancoDados() {
  console.log('Iniciando limpeza do banco de dados...');
  
  const db = new sqlite3.Database('catalogo.db');
  
  db.serialize(() => {
    // Desabilitar foreign keys temporariamente
    db.run('PRAGMA foreign_keys = OFF');
    
    // Limpar todas as tabelas
    const tabelas = [
      'armazens_item',
      'imagens_itens', 
      'especificacoes',
      'itens'
    ];
    
    tabelas.forEach(tabela => {
      db.run(`DELETE FROM ${tabela}`, (err) => {
        if (err) {
          console.error(`Erro ao limpar tabela ${tabela}:`, err.message);
        } else {
          console.log(`✓ Tabela ${tabela} limpa com sucesso`);
        }
      });
    });
    
    // Resetar auto-increment
    db.run('DELETE FROM sqlite_sequence WHERE name IN (?, ?, ?, ?)', 
      ['itens', 'armazens_item', 'imagens_itens', 'especificacoes'], 
      (err) => {
        if (err) {
          console.error('Erro ao resetar sequências:', err.message);
        } else {
          console.log('✓ Sequências de auto-increment resetadas');
        }
      }
    );
    
    // Reabilitar foreign keys
    db.run('PRAGMA foreign_keys = ON');
    
    // Verificar se há dados restantes
    setTimeout(() => {
      db.get('SELECT COUNT(*) as total FROM itens', (err, row) => {
        if (err) {
          console.error('Erro ao verificar dados:', err.message);
        } else {
          console.log(`\nVerificação: ${row.total} itens restantes no banco`);
          if (row.total === 0) {
            console.log('✅ Banco de dados limpo com sucesso!');
          } else {
            console.log('⚠️  Ainda há dados no banco');
          }
        }
        
        db.close((err) => {
          if (err) {
            console.error('Erro ao fechar banco:', err.message);
          } else {
            console.log('Conexão com banco fechada');
          }
        });
      });
    }, 1000);
  });
}

// Função para fazer backup antes de limpar
function fazerBackup() {
  const dataAtual = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `backup_${dataAtual}.db`;
  
  if (fs.existsSync('catalogo.db')) {
    fs.copyFileSync('catalogo.db', backupPath);
    console.log(`✅ Backup criado: ${backupPath}`);
    return true;
  } else {
    console.log('❌ Arquivo catalogo.db não encontrado');
    return false;
  }
}

// Executar limpeza
console.log('=== LIMPEZA DO BANCO DE DADOS ===');
console.log('');

// Fazer backup primeiro
if (fazerBackup()) {
  console.log('');
  console.log('Iniciando limpeza...');
  limparBancoDados();
} else {
  console.log('Não foi possível fazer backup. Abortando limpeza.');
} 