const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const xlsx = require('xlsx');

// Conexão com PostgreSQL (Railway)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

// Setores válidos disponíveis no sistema
const SETORES_VALIDOS = [
  'CLIENTE',
  'ENGENHARIA',
  'FIBRA',
  'FROTA',
  'IT',
  'LOGISTICA',
  'MARKETING',
  'MOVEL',
  'NOWO',
  'FERRAMENTA',
  'EPI',
  'EPC'
];

async function importarSetores(arquivoPath) {
  try {
    console.log('📁 Iniciando importação de setores...');
    console.log(`📂 Arquivo: ${arquivoPath}`);

    // Verificar se o arquivo existe
    if (!fs.existsSync(arquivoPath)) {
      throw new Error(`Arquivo não encontrado: ${arquivoPath}`);
    }

    const extensao = path.extname(arquivoPath).toLowerCase();
    let dados = [];

    // Ler arquivo baseado na extensão
    if (extensao === '.csv') {
      dados = await lerCSV(arquivoPath);
    } else if (extensao === '.xlsx' || extensao === '.xls') {
      dados = await lerExcel(arquivoPath);
    } else {
      throw new Error('Formato de arquivo não suportado. Use .csv, .xlsx ou .xls');
    }

    console.log(`📊 Total de linhas lidas: ${dados.length}`);

    // Processar e validar dados
    const resultados = await processarDados(dados);
    
    // Exibir estatísticas
    exibirEstatisticas(resultados);

  } catch (error) {
    console.error('❌ Erro durante a importação:', error.message);
  } finally {
    await pool.end();
  }
}

async function lerCSV(arquivoPath) {
  return new Promise((resolve, reject) => {
    const resultados = [];
    fs.createReadStream(arquivoPath)
      .pipe(csv())
      .on('data', (data) => resultados.push(data))
      .on('end', () => resolve(resultados))
      .on('error', reject);
  });
}

async function lerExcel(arquivoPath) {
  const workbook = xlsx.readFile(arquivoPath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(worksheet);
}

async function processarDados(dados) {
  const resultados = {
    total: dados.length,
    processados: 0,
    sucesso: 0,
    erros: 0,
    setoresInvalidos: 0,
    itensNaoEncontrados: 0,
    detalhes: []
  };

  console.log('\n🔄 Processando dados...');

  for (let i = 0; i < dados.length; i++) {
    const linha = dados[i];
    const codigo = linha.Artigo || linha.codigo || linha.CODIGO || linha.artigo;
    const setoresString = linha.SETOR || linha.setor || linha.Setor || '';

    if (!codigo) {
      resultados.erros++;
      resultados.detalhes.push({
        linha: i + 1,
        codigo: 'N/A',
        setores: setoresString,
        erro: 'Código do item não encontrado'
      });
      continue;
    }

    resultados.processados++;

    try {
      // Buscar o item pelo código
      const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
      
      if (itemResult.rows.length === 0) {
        resultados.itensNaoEncontrados++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          setores: setoresString,
          erro: 'Item não encontrado no banco de dados'
        });
        continue;
      }

      const itemId = itemResult.rows[0].id;

      // Processar setores (separados por vírgula)
      const setoresArray = setoresString
        .split(',')
        .map(setor => setor.trim().toUpperCase())
        .filter(setor => setor.length > 0 && setor !== '')
        .filter((setor, index, array) => array.indexOf(setor) === index); // Remover duplicatas

      // Validar setores
      const setoresValidos = [];
      const setoresInvalidos = [];

      for (const setor of setoresArray) {
        if (SETORES_VALIDOS.includes(setor)) {
          setoresValidos.push(setor);
        } else {
          setoresInvalidos.push(setor);
        }
      }

      if (setoresInvalidos.length > 0) {
        resultados.setoresInvalidos++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          setores: setoresString,
          setoresValidos: setoresValidos,
          setoresInvalidos: setoresInvalidos,
          erro: 'Alguns setores são inválidos'
        });
      }

      if (setoresValidos.length > 0) {
        // Remover setores existentes do item
        await pool.query('DELETE FROM itens_setores WHERE item_id = $1', [itemId]);

        // Inserir novos setores válidos
        for (const setor of setoresValidos) {
          await pool.query(
            'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
            [itemId, setor]
          );
        }

        resultados.sucesso++;
        console.log(`✅ ${codigo}: ${setoresValidos.join(', ')}`);
      }

    } catch (error) {
      resultados.erros++;
      resultados.detalhes.push({
        linha: i + 1,
        codigo: codigo,
        setores: setoresString,
        erro: error.message
      });
    }

    // Mostrar progresso a cada 100 itens
    if ((i + 1) % 100 === 0) {
      console.log(`📈 Processados: ${i + 1}/${dados.length}`);
    }
  }

  return resultados;
}

function exibirEstatisticas(resultados) {
  console.log('\n📊 ESTATÍSTICAS DA IMPORTAÇÃO:');
  console.log('=' .repeat(50));
  console.log(`📋 Total de linhas: ${resultados.total}`);
  console.log(`✅ Processados com sucesso: ${resultados.sucesso}`);
  console.log(`❌ Erros: ${resultados.erros}`);
  console.log(`⚠️ Itens não encontrados: ${resultados.itensNaoEncontrados}`);
  console.log(`🚫 Setores inválidos: ${resultados.setoresInvalidos}`);

  if (resultados.detalhes.length > 0) {
    console.log('\n📝 DETALHES DOS ERROS:');
    console.log('=' .repeat(50));
    resultados.detalhes.slice(0, 10).forEach(detalhe => {
      console.log(`Linha ${detalhe.linha}: ${detalhe.codigo} - ${detalhe.erro}`);
      if (detalhe.setoresInvalidos) {
        console.log(`  Setores inválidos: ${detalhe.setoresInvalidos.join(', ')}`);
      }
    });

    if (resultados.detalhes.length > 10) {
      console.log(`... e mais ${resultados.detalhes.length - 10} erros`);
    }
  }

  console.log('\n🎯 IMPORTAÇÃO CONCLUÍDA!');
}

// Verificar se foi passado um arquivo como argumento
const arquivoPath = process.argv[2];

if (!arquivoPath) {
  console.log('❌ Uso: node importar_setores.js <caminho_do_arquivo>');
  console.log('📁 Exemplo: node importar_setores.js ./uploads/setores.csv');
  console.log('📋 O arquivo deve ter colunas: Artigo (código) e SETOR (setores separados por vírgula)');
  process.exit(1);
}

importarSetores(arquivoPath);
