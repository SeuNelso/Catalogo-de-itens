const fetch = require('node-fetch');

async function testImportStatus() {
  try {
    console.log('=== TESTE DA ROTA DE STATUS ===');
    
    // Testar rota de status de importação de itens
    const response = await fetch('http://localhost:3001/api/importar-itens-status/test', {
      headers: {
        'Authorization': 'Bearer test'
      }
    });
    
    console.log('Status da resposta:', response.status);
    console.log('Headers:', response.headers.raw());
    
    if (response.ok) {
      const data = await response.json();
      console.log('Dados da resposta:', data);
    } else {
      console.log('Erro na resposta:', response.statusText);
    }
    
  } catch (error) {
    console.error('Erro ao testar rota:', error.message);
  }
}

testImportStatus(); 