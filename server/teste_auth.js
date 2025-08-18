const fetch = require('node-fetch');

async function testarAuth() {
  try {
    console.log('🧪 Testando autenticação...');
    
    // Teste 1: Tentar acessar rota protegida sem token
    console.log('\n1️⃣ Testando acesso sem token:');
    const response1 = await fetch('http://localhost:3001/api/importar-setores', {
      method: 'POST',
      body: 'test'
    });
    
    const result1 = await response1.json();
    console.log('Status:', response1.status);
    console.log('Resposta:', result1);
    
    // Teste 2: Tentar acessar com token inválido
    console.log('\n2️⃣ Testando acesso com token inválido:');
    const response2 = await fetch('http://localhost:3001/api/importar-setores', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token_invalido'
      },
      body: 'test'
    });
    
    const result2 = await response2.json();
    console.log('Status:', response2.status);
    console.log('Resposta:', result2);
    
    console.log('\n✅ Testes concluídos!');
    
  } catch (error) {
    console.error('❌ Erro nos testes:', error.message);
  }
}

testarAuth();
