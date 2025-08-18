const xlsx = require('xlsx');

// Dados de exemplo para o arquivo Excel
const dados = [
  { Artigo: '3000003', SETOR: 'MOVEL' },
  { Artigo: '3000004', SETOR: 'MOVEL' },
  { Artigo: '3000006', SETOR: 'MOVEL' },
  { Artigo: '3000007', SETOR: 'MOVEL' },
  { Artigo: '3000008', SETOR: 'MOVEL' },
  { Artigo: '3000009', SETOR: 'MOVEL' },
  { Artigo: '3000010', SETOR: 'MOVEL' },
  { Artigo: '3000011', SETOR: 'MOVEL' },
  { Artigo: '3000012', SETOR: 'MOVEL' },
  { Artigo: '3000013', SETOR: 'MOVEL' },
  { Artigo: '3000014', SETOR: 'MOVEL' },
  { Artigo: '3000015', SETOR: 'MOVEL' },
  { Artigo: '3000016', SETOR: 'MOVEL' },
  { Artigo: '3000017', SETOR: 'MOVEL' },
  { Artigo: '3000018', SETOR: 'MOVEL' },
  { Artigo: '3000019', SETOR: 'MOVEL' },
  { Artigo: '3000020', SETOR: 'MOVEL, FIBRA' },
  { Artigo: '3000021', SETOR: 'MOVEL, FIBRA' },
  { Artigo: '3000022', SETOR: 'FIBRA, CLIENTE, ENGENHARIA' },
  { Artigo: '3000023', SETOR: 'IT, LOGISTICA' },
  { Artigo: '3000024', SETOR: 'FROTA, EPI' },
  { Artigo: '3000025', SETOR: 'MARKETING, NOWO' },
  { Artigo: '3000026', SETOR: 'FERRAMENTA, EPI, EPC' },
  { Artigo: '3000027', SETOR: 'IT' },
  { Artigo: '3000028', SETOR: 'LOGISTICA, FROTA' },
  { Artigo: '3000029', SETOR: 'CLIENTE' },
  { Artigo: '3000030', SETOR: 'ENGENHARIA, FIBRA, IT' }
];

// Criar workbook
const workbook = xlsx.utils.book_new();

// Criar worksheet
const worksheet = xlsx.utils.json_to_sheet(dados);

// Definir largura das colunas
worksheet['!cols'] = [
  { width: 15 }, // Artigo
  { width: 40 }  // SETOR
];

// Adicionar worksheet ao workbook
xlsx.utils.book_append_sheet(workbook, worksheet, 'Setores');

// Salvar arquivo
const nomeArquivo = 'exemplo_setores.xlsx';
xlsx.writeFile(workbook, nomeArquivo);

console.log(`✅ Arquivo Excel criado: ${nomeArquivo}`);
console.log('📋 Estrutura do arquivo:');
console.log('  - Coluna A: Artigo (código do item)');
console.log('  - Coluna B: SETOR (setores separados por vírgula)');
console.log('\n📝 Exemplos de setores válidos:');
console.log('  - CLIENTE, ENGENHARIA, FIBRA, FROTA, IT, LOGISTICA');
console.log('  - MARKETING, MOVEL, NOWO, FERRAMENTA, EPI, EPC');
console.log('\n💡 Dica: Para múltiplos setores, separe-os por vírgula na mesma célula');
