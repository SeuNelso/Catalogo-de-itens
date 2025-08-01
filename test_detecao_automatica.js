const fetch = require('node-fetch');

async function testarDetecaoAutomatica() {
  try {
    console.log('🧪 Testando detecção automática de imagens...');
    
    // Substitua pelo token real e itemId real
    const token = 'SEU_TOKEN_AQUI';
    const itemId = 1; // Substitua pelo ID do item que você quer testar
    
    console.log(`📋 Testando detecção para item ID: ${itemId}`);
    
    // Primeiro, vamos verificar se o item existe
    console.log('🔍 Verificando se o item existe...');
    const itemResponse = await fetch(`http://localhost:5000/api/itens/${itemId}`);
    const itemData = await itemResponse.json();
    
    if (itemResponse.ok) {
      console.log('✅ Item encontrado:', itemData.codigo, '-', itemData.descricao);
    } else {
      console.log('❌ Item não encontrado:', itemData.error);
      return;
    }
    
    // Agora vamos testar a detecção automática
    console.log('🔄 Executando detecção automática...');
    const response = await fetch(`http://localhost:5000/api/detectar-imagens/${itemId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    console.log('📊 Resultado da detecção:');
    console.log(JSON.stringify(data, null, 2));
    
    if (response.ok) {
      console.log('✅ Detecção automática executada com sucesso!');
      console.log(`📈 Resumo: ${data.importadas} importadas, ${data.jaExistentes} já existentes`);
    } else {
      console.log('❌ Erro na detecção automática:', data.error);
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
  }
}

// Executar o teste
testarDetecaoAutomatica(); 