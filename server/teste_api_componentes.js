const fetch = require('node-fetch');

async function testarAPIComponentes() {
  try {
    console.log('🧪 Testando API de componentes...');
    
    // Simular login para obter token
    console.log('1️⃣ Fazendo login...');
    const loginResponse = await fetch('http://localhost:3001/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'admin',
        password: 'admin123'
      })
    });
    
    if (!loginResponse.ok) {
      console.log('❌ Erro no login');
      const error = await loginResponse.text();
      console.log('Erro:', error);
      return;
    }
    
    const loginData = await loginResponse.json();
    const token = loginData.token;
    console.log('✅ Login realizado com sucesso');
    
    // Testar adição de componente
    console.log('2️⃣ Testando adição de componente...');
    
    // Usar o item 3000003 como componente do item 89674
    const addComponentResponse = await fetch('http://localhost:3001/api/itens/89674/componentes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        item_componente_id: 87943, // ID do item 3000003
        quantidade_componente: 2
      })
    });
    
    console.log('Status da resposta:', addComponentResponse.status);
    
    if (addComponentResponse.ok) {
      const result = await addComponentResponse.json();
      console.log('✅ Componente adicionado com sucesso:', result);
    } else {
      const error = await addComponentResponse.json();
      console.log('❌ Erro ao adicionar componente:', error);
    }
    
    // Testar listagem de componentes
    console.log('3️⃣ Testando listagem de componentes...');
    const listResponse = await fetch('http://localhost:3001/api/itens/89674/componentes', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (listResponse.ok) {
      const componentes = await listResponse.json();
      console.log('✅ Componentes listados:', componentes);
    } else {
      const error = await listResponse.json();
      console.log('❌ Erro ao listar componentes:', error);
    }
    
  } catch (error) {
    console.error('❌ Erro durante o teste:', error);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  testarAPIComponentes();
}

module.exports = { testarAPIComponentes };

