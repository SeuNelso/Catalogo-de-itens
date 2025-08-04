const XLSX = require('xlsx');

// Simular dados do Excel
const dadosTeste = [
  {
    'Artigo': 'TEST001',
    'Descrição': 'Produto de teste',
    'Categoria': 'Categoria teste',
    'Marca': 'Marca teste',
    'Modelo': 'Modelo teste',
    'Preço': 150.75,
    'TOTAL': 25,
    'Localização': 'Prateleira B2',
    'Observações': 'Observações de teste para verificar se está funcionando',
    'Família': 'Família teste',
    'Subfamília': 'Subfamília teste',
    'Setor': 'TI',
    'Comprimento': 25.5,
    'Largura': 14.2,
    'Altura': 5.1,
    'Unidade': 'cm',
    'Peso': '250',
    'Unidade Peso': 'g',
    'Unidade Armazenamento': 'un',
    'Tipo Controle': 'Automático',
    'WH1': 10,
    'WH2': 8,
    'WH3': 7
  }
];

// Simular o processamento
function processarLinha(row, idx) {
  const codigo = row['Artigo']?.toString().trim();
  const descricao = row['Descrição']?.toString().trim();
  const nome = descricao;
  const categoria = row['Categoria']?.toString().trim() || 'Sem categoria';
  const quantidade = Number(row['TOTAL']) || 0;
  
  // Novos campos do template atualizado
  const marca = row['Marca']?.toString().trim() || null;
  const modelo = row['Modelo']?.toString().trim() || null;
  const preco = row['Preço'] ? Number(row['Preço']) : null;
  const localizacao = row['Localização']?.toString().trim() || null;
  const observacoes = row['Observações']?.toString().trim() || null;
  const familia = row['Família']?.toString().trim() || null;
  const subfamilia = row['Subfamília']?.toString().trim() || null;
  const setor = row['Setor']?.toString().trim() || null;
  const comprimento = row['Comprimento'] ? Number(row['Comprimento']) : null;
  const largura = row['Largura'] ? Number(row['Largura']) : null;
  const altura = row['Altura'] ? Number(row['Altura']) : null;
  const unidade = row['Unidade']?.toString().trim() || null;
  const peso = row['Peso']?.toString().trim() || null;
  const unidadePeso = row['Unidade Peso']?.toString().trim() || null;
  const unidadeArmazenamento = row['Unidade Armazenamento']?.toString().trim() || null;
  const tipocontrolo = row['Tipo Controle']?.toString().trim() || null;
  
  console.log('=== TESTE DE PROCESSAMENTO ===');
  console.log('Código:', codigo);
  console.log('Nome:', nome);
  console.log('Categoria:', categoria);
  console.log('Quantidade:', quantidade);
  console.log('--- CAMPOS PROBLEMÁTICOS ---');
  console.log('Família:', familia, '| Raw:', row['Família']);
  console.log('Subfamília:', subfamilia, '| Raw:', row['Subfamília']);
  console.log('Unidade Armazenamento:', unidadeArmazenamento, '| Raw:', row['Unidade Armazenamento']);
  console.log('Tipo Controle:', tipocontrolo, '| Raw:', row['Tipo Controle']);
  console.log('Observações:', observacoes, '| Raw:', row['Observações']);
  console.log('--- OUTROS CAMPOS ---');
  console.log('Marca:', marca);
  console.log('Modelo:', modelo);
  console.log('Preço:', preco);
  console.log('Localização:', localizacao);
  console.log('Setor:', setor);
  console.log('Dimensões:', comprimento, 'x', largura, 'x', altura);
  console.log('Peso:', peso, unidadePeso);
  console.log('=============================');
  
  return {
    codigo, nome, categoria, quantidade, marca, modelo, preco,
    localizacao, observacoes, familia, subfamilia, setor,
    comprimento, largura, altura, unidade, peso, unidadePeso,
    unidadeArmazenamento, tipocontrolo
  };
}

// Executar teste
dadosTeste.forEach((row, idx) => {
  processarLinha(row, idx);
}); 