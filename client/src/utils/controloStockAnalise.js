const normalizarCabecalho = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const indiceColuna = (headers, aliases) => {
  const normalizados = headers.map(normalizarCabecalho);
  return normalizados.findIndex((header) => aliases.includes(header));
};

const lerQuantidade = (value, label) => {
  if (value === '' || value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const texto = String(value).trim().replace(/\s/g, '');
  if (!texto) return 0;
  const normalizado = texto.includes(',')
    ? texto.replace(/\./g, '').replace(',', '.')
    : texto;
  const quantidade = Number(normalizado);
  if (!Number.isFinite(quantidade)) {
    throw new Error(`Quantidade inválida em ${label}: "${value}".`);
  }
  return quantidade;
};

const adicionarStock = (rows, label, stockMap) => {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`O ficheiro "${label}" não contém linhas de stock.`);
  }

  const headers = rows[0] || [];
  const artigoIndex = indiceColuna(headers, ['artigo', 'codigo', 'referencia', 'ref']);
  const descricaoIndex = indiceColuna(headers, ['descricao', 'designacao', 'nome']);
  const stockIndex = indiceColuna(headers, ['stock', 'quantidade', 'existencias']);
  if (artigoIndex < 0 || stockIndex < 0) {
    throw new Error(`O ficheiro "${label}" deve conter as colunas Artigo e Stock.`);
  }

  let linhasValidas = 0;
  rows.slice(1).forEach((row, rowIndex) => {
    const artigo = String(row?.[artigoIndex] ?? '').trim();
    if (!artigo) return;
    const quantidade = lerQuantidade(row?.[stockIndex], `${label}, linha ${rowIndex + 2}`);
    const current = stockMap.get(artigo) || { quantidade: 0, descricao: '' };
    current.quantidade += quantidade;
    if (!current.descricao && descricaoIndex >= 0) {
      current.descricao = String(row?.[descricaoIndex] || '').trim();
    }
    stockMap.set(artigo, current);
    linhasValidas += 1;
  });
  if (!linhasValidas) {
    throw new Error(`O ficheiro "${label}" não contém artigos válidos.`);
  }
}

const lerMovimentos = (rows) => {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('O ficheiro de movimentos não contém linhas.');
  }

  const headers = rows[0] || [];
  const artigoIndex = indiceColuna(headers, ['artigo', 'codigo', 'referencia', 'ref']);
  const tipoIndex = indiceColuna(headers, ['tipomovimento', 'tipo']);
  const quantidadeIndex = indiceColuna(headers, ['qtdmov', 'quantidademovimento', 'quantidade']);
  if (artigoIndex < 0 || tipoIndex < 0 || quantidadeIndex < 0) {
    throw new Error('O ficheiro de movimentos deve conter Artigo, Tipo Movimento e Qtd. Mov..');
  }

  const indices = {
    data: indiceColuna(headers, ['data']),
    hora: indiceColuna(headers, ['hora']),
    documento: indiceColuna(headers, ['documento', 'doc']),
    unidade: indiceColuna(headers, ['unidade']),
    stockAtual: indiceColuna(headers, ['stockatual']),
    localizacao: indiceColuna(headers, ['localizacao']),
  };
  const armazemIndices = headers
    .map((header, index) => ({ header: normalizarCabecalho(header), index }))
    .filter((entry) => entry.header === 'armazem')
    .map((entry) => entry.index);
  const movimentosPorArtigo = new Map();
  let linhasValidas = 0;

  rows.slice(1).forEach((row, rowIndex) => {
    const artigo = String(row?.[artigoIndex] ?? '').trim();
    if (!artigo || /^artigo\s*:/i.test(artigo)) return;

    const tipoOriginal = String(row?.[tipoIndex] ?? '').trim();
    if (!tipoOriginal) {
      throw new Error(`Tipo de movimento em falta na linha ${rowIndex + 2}.`);
    }
    const tipo = normalizarCabecalho(tipoOriginal);
    const quantidade = lerQuantidade(row?.[quantidadeIndex], `movimentos, linha ${rowIndex + 2}`);
    let variacao = 0;
    if (tipo === 'entrada') {
      variacao = quantidade;
    } else if (tipo === 'saida') {
      variacao = -quantidade;
    } else if (tipo !== 'saldoinicial') {
      throw new Error(`Tipo de movimento não suportado na linha ${rowIndex + 2}: "${tipoOriginal}".`);
    }
    if (quantidade < 0) {
      throw new Error(`Quantidade negativa na linha ${rowIndex + 2}.`);
    }

    const getValue = (index) => (index < 0 ? '' : row?.[index] ?? '');
    const movement = {
      artigo,
      tipo: tipoOriginal,
      quantidade,
      data: getValue(indices.data),
      hora: getValue(indices.hora),
      documento: getValue(indices.documento),
      unidade: getValue(indices.unidade),
      stockAtual: getValue(indices.stockAtual),
      armazem: armazemIndices.length > 1
        ? getValue(armazemIndices[1]) || getValue(armazemIndices[0])
        : getValue(armazemIndices[0]),
      localizacao: getValue(indices.localizacao),
    };
    const current = movimentosPorArtigo.get(artigo) || { variacao: 0, movimentos: [] };
    current.variacao += variacao;
    current.movimentos.push(movement);
    movimentosPorArtigo.set(artigo, current);
    linhasValidas += 1;
  });

  if (!linhasValidas) {
    throw new Error('O ficheiro de movimentos não contém movimentos válidos.');
  }
  return movimentosPorArtigo;
};

export function analisarControloStock({ stockAnteriorRows, movimentosRows, stockAtualRows }) {
  const stockAnterior = new Map();
  const stockAtual = new Map();
  adicionarStock(stockAnteriorRows, 'stock do dia anterior', stockAnterior);
  adicionarStock(stockAtualRows, 'stock do dia atual', stockAtual);
  const movimentos = lerMovimentos(movimentosRows);
  const artigos = new Set([
    ...stockAnterior.keys(),
    ...stockAtual.keys(),
    ...movimentos.keys(),
  ]);

  return Array.from(artigos, (artigo) => {
    const anterior = stockAnterior.get(artigo);
    const atual = stockAtual.get(artigo);
    const movimento = movimentos.get(artigo);
    const stockAnteriorQuantidade = anterior?.quantidade || 0;
    const stockAtualQuantidade = atual?.quantidade || 0;
    const quantidadeMovimentada = movimento?.variacao || 0;
    const stockEsperado = stockAnteriorQuantidade + quantidadeMovimentada;
    const diferenca = stockAtualQuantidade - stockEsperado;

    return {
      artigo,
      descricao: atual?.descricao || anterior?.descricao || '',
      stockAnterior: stockAnteriorQuantidade,
      quantidadeMovimentada,
      stockEsperado,
      stockAtual: stockAtualQuantidade,
      diferenca,
      movimentos: movimento?.movimentos || [],
    };
  }).sort((a, b) => a.artigo.localeCompare(b.artigo, 'pt', { numeric: true }));
}

export function stockEstaConciliado(item) {
  return Math.abs(item.diferenca) < 0.0001;
}
