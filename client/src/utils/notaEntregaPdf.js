/**
 * PDF «Nota de entrega» — layout alinhado ao template DIGI Logistic.
 */
import autoTable from 'jspdf-autotable';
import { formatSeparadorRequisicao } from './requisicaoCriador';

/** Azul institucional (próximo do #0915FF da app) */
export const NOTA_ENTREGA_BLUE = [9, 21, 255];

/** Mesmo layout da nota de entrega; títulos para devolução (viatura → central). */
export const NOTA_DEVOLUCAO_PDF_OPTS = Object.freeze({
  tituloDocumento: 'NOTA DE DEVOLUÇÃO',
  rotuloNumeroNota: 'Nº Nota de devolução:',
  rotuloDataNota: 'Data da nota de devolução:'
});

const MARGIN = 40;

function textoObservacaoItem(it) {
  const v = it.observacoes ?? it.observacao ?? it.obs ?? '';
  return String(v ?? '').trim();
}

export function buildLinhasProdutoTableBody(req) {
  const itens = Array.isArray(req?.itens) ? req.itens : [];
  const body = [];
  let linha = 1;
  for (const it of itens) {
    const codigo = String(it.item_codigo ?? it.codigo ?? '');
    const desc = String(it.item_descricao ?? it.descricao ?? '');
    const obs = textoObservacaoItem(it);
    const bobinas = Array.isArray(it.bobinas) ? it.bobinas : [];
    if (bobinas.length > 0) {
      for (const b of bobinas) {
        body.push([
          String(linha),
          codigo,
          desc,
          String(b.metros ?? ''),
          String(b.serialnumber ?? ''),
          String(b.lote ?? ''),
          obs
        ]);
        linha += 1;
      }
    } else {
      const qtyBase = it.quantidade_preparada ?? it.quantidade ?? 0;
      body.push([
        String(linha),
        codigo,
        desc,
        String(Number(qtyBase) || 0),
        String(it.serialnumber ?? ''),
        String(it.lote ?? ''),
        obs
      ]);
      linha += 1;
    }
  }
  return body;
}

function drawHeaderDigi(doc, pageWidth) {
  const yLogo = 38;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(NOTA_ENTREGA_BLUE[0], NOTA_ENTREGA_BLUE[1], NOTA_ENTREGA_BLUE[2]);
  doc.text('DIGI', MARGIN, yLogo);
  const digiW = doc.getTextWidth('DIGI');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(40, 40, 40);
  doc.text(' Clog', MARGIN + digiW, yLogo);

  const lines = [
    'DIGI PORTUGAL, LDA',
    'Avenida José Malhoa, 11 - 3º, 1070-157 Lisboa',
    'www.digi.pt'
  ];
  doc.setFontSize(9);
  doc.setTextColor(30, 30, 30);
  let ry = 26;
  for (const line of lines) {
    doc.text(line, pageWidth - MARGIN, ry, { align: 'right' });
    ry += 11;
  }

  return Math.max(yLogo + 8, ry) + 14;
}

function drawOrigemDestino(doc, req, pageWidth, startY) {
  const origemArm = req?.armazem_origem_descricao || '—';
  const destinoArm = req?.armazem_descricao || '—';
  const enderecoOrigem = (req?.localizacao && String(req.localizacao).trim()) || '—';

  const colLeft = MARGIN;
  const colRight = pageWidth / 2 + 12;
  const colW = pageWidth / 2 - MARGIN - 20;
  let y = startY;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NOTA_ENTREGA_BLUE[0], NOTA_ENTREGA_BLUE[1], NOTA_ENTREGA_BLUE[2]);
  doc.text('ORIGEM', colLeft, y);
  doc.text('DESTINO', colRight, y);
  y += 13;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(30, 30, 30);
  doc.text(String(origemArm), colLeft, y, { maxWidth: colW });
  doc.text(String(destinoArm), colRight, y, { maxWidth: colW });
  y += 28;
  doc.text(enderecoOrigem, colLeft, y, { maxWidth: colW });
  y += 22;

  return y;
}

/**
 * Desenha uma página completa de nota de entrega (template DIGI) para uma requisição.
 * @param {import('jspdf').jsPDF} doc
 * @param {object} req requisição (com itens)
 * @param {object} opts
 * @param {boolean} [opts.isFirstPage=true]
 * @param {Date} [opts.dataRef] data impressa na linha de data do documento
 * @param {string} [opts.tituloDocumento='NOTA DE ENTREGA'] título central (ex.: NOTA DE DEVOLUÇÃO)
 * @param {string} [opts.rotuloNumeroNota='Nº Nota de entrega:'] texto antes do número
 * @param {string} [opts.rotuloDataNota='Data da nota de entrega:'] texto antes da data
 */
export function desenharPaginaNotaEntregaDigi(doc, req, opts = {}) {
  const isFirstPage = opts.isFirstPage !== false;
  const dataRef = opts.dataRef instanceof Date ? opts.dataRef : new Date();
  const tituloDocumento = String(opts.tituloDocumento || 'NOTA DE ENTREGA').trim() || 'NOTA DE ENTREGA';
  const rotuloNumeroNota =
    opts.rotuloNumeroNota != null ? String(opts.rotuloNumeroNota) : 'Nº Nota de entrega:';
  const rotuloDataNota =
    opts.rotuloDataNota != null ? String(opts.rotuloDataNota) : 'Data da nota de entrega:';
  const pageWidth = doc.internal.pageSize.getWidth();

  if (!isFirstPage) {
    doc.addPage();
  }

  let y = drawHeaderDigi(doc, pageWidth);
  y = drawOrigemDestino(doc, req, pageWidth, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(NOTA_ENTREGA_BLUE[0], NOTA_ENTREGA_BLUE[1], NOTA_ENTREGA_BLUE[2]);
  doc.text(tituloDocumento, pageWidth / 2, y, { align: 'center' });
  y += 12;
  doc.setDrawColor(NOTA_ENTREGA_BLUE[0], NOTA_ENTREGA_BLUE[1], NOTA_ENTREGA_BLUE[2]);
  doc.setLineWidth(0.8);
  doc.line(MARGIN, y, pageWidth - MARGIN, y);
  y += 20;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 30, 30);
  const idNota = req?.id != null ? String(req.id) : '—';
  doc.text(`${rotuloNumeroNota} ${idNota}`, MARGIN, y);
  const dataStr = dataRef.toLocaleDateString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  doc.text(`${rotuloDataNota} ${dataStr}`, pageWidth / 2 + 6, y);
  y += 14;
  doc.text(`Separado por: ${formatSeparadorRequisicao(req)}`, MARGIN, y);
  y += 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NOTA_ENTREGA_BLUE[0], NOTA_ENTREGA_BLUE[1], NOTA_ENTREGA_BLUE[2]);
  doc.text('Referência do produto', MARGIN, y);
  y += 10;

  const body = buildLinhasProdutoTableBody(req);

  // Cabeçalhos curtos + larguras fixas evitam quebra de linha no título das colunas
  autoTable(doc, {
    startY: y,
    head: [['Linha', 'Cód.', 'Descrição', 'Qtd.', 'N.º série', 'Lote', 'Observações']],
    body: body.length > 0 ? body : [['—', '—', 'Sem itens', '', '', '', '']],
    styles: {
      fontSize: 8,
      cellPadding: { top: 3, right: 3, bottom: 3, left: 3 },
      lineColor: NOTA_ENTREGA_BLUE,
      lineWidth: 0.2,
      overflow: 'linebreak'
    },
    headStyles: {
      fillColor: NOTA_ENTREGA_BLUE,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      halign: 'center',
      valign: 'middle',
      fontSize: 7.5,
      overflow: 'visible',
      minCellHeight: 14
    },
    bodyStyles: { textColor: [20, 20, 20], valign: 'top' },
    theme: 'grid',
    margin: { left: MARGIN, right: MARGIN },
    tableWidth: pageWidth - 2 * MARGIN,
    // Larguras (soma ≈ largura útil A4) para cabeçalhos numa linha + coluna de observações
    columnStyles: {
      0: { cellWidth: 30, halign: 'center' },
      1: { cellWidth: 46, halign: 'left' },
      2: { cellWidth: 118, halign: 'left' },
      3: { cellWidth: 32, halign: 'right' },
      4: { cellWidth: 58, halign: 'center' },
      5: { cellWidth: 42, halign: 'left' },
      6: { cellWidth: 189, halign: 'left' }
    },
    didParseCell: (hookData) => {
      if (hookData.section === 'head') {
        hookData.cell.styles.overflow = 'visible';
        if (Array.isArray(hookData.cell.text)) {
          hookData.cell.text = hookData.cell.text.map((t) => String(t).replace(/\s+/g, ' '));
        }
      }
    }
  });

  return doc;
}
