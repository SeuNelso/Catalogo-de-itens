/**
 * PDF de identificação de item (etiqueta) — layout DIGI em A4.
 * Folha inteira: horizontal; múltiplos por folha: vertical.
 * QR = localização; código de barras 1D = código do artigo.
 */
import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';

/** Azul «DIGI» na etiqueta (próximo do cyan da marca) */
const DIGI_BLUE = [0, 174, 239];

/** Proporção base da etiqueta (largura : altura = 2 : 1). */
const LABEL_ASPECT = 2;
const LABEL_W_MM = 100;
const LABEL_H_MM = 50;

const A4_LANDSCAPE_W_MM = 297;
const A4_LANDSCAPE_H_MM = 210;
const A4_PORTRAIT_W_MM = 210;
const A4_PORTRAIT_H_MM = 297;
const PAGE_MARGIN_MM = 8;
const GAP_ENTRE_ETIQUETAS_MM = 3;
const MAX_ETIQUETAS_TRES_POR_FOLHA = 3;
export const MAX_QTD_DIGITOS = 6;

/** Faixa superior (DIGI + código) — mais baixa = mais espaço para descrição. */
const HEADER_FRAC = 0.19;
const BOTTOM_FRAC = 0.30;
const LEFT_COL_FRAC = 0.3;
const PAD_MM = 0.8;

const RASTER_DPI = 300;

/** Tamanhos de referência (etiqueta base 50 mm altura) — fixos, não encolhem com o texto. */
const FONT_DIGI_REF_PT = 14;
const FONT_CODIGO_REF_PT = 18;
const FONT_LOC_REF_PT = 13;
const FONT_QTD_LABEL_REF_PT = 10;
const FONT_QTD_REF_PT = 26;
/** Fração da faixa inferior esquerda reservada à quantidade (folha inteira). */
const QTY_FRAC_BOTTOM_LEFT = 0.5;
/** Descrição: começa grande e reduz até caber na faixa central. */
const FONT_DESC_MAX_REF_PT = 16;
const FONT_DESC_MIN_REF_PT = 6;
const LINE_HEIGHT_FACTOR = 0.38;

function escalaEtiqueta(labelH) {
  return Math.max(0.45, labelH / LABEL_H_MM);
}

function fontePadraoPt(labelH, refPt) {
  return refPt * escalaEtiqueta(labelH);
}

export const MODOS_PDF = Object.freeze({
  FOLHA_INTEIRA: 'folha_inteira',
  TRES_POR_FOLHA: 'tres_por_folha'
});

function calcLayoutMetrics(labelW, labelH, { comQuantidade = false } = {}) {
  const innerW = labelW - PAD_MM * 2;
  const innerH = labelH - PAD_MM * 2;
  const leftW = innerW * LEFT_COL_FRAC;
  const rightW = innerW - leftW;
  const headerH = innerH * HEADER_FRAC;
  const bottomH = innerH * BOTTOM_FRAC;
  const qtyH = comQuantidade ? bottomH * QTY_FRAC_BOTTOM_LEFT : 0;
  const locBottomH = bottomH - qtyH;
  return {
    pad: PAD_MM,
    innerW,
    innerH,
    leftW,
    rightW,
    headerH,
    descH: innerH - headerH - bottomH,
    bottomH,
    qtyH,
    locBottomH,
    qrSizeMm: Math.min(leftW - 0.6, innerH - bottomH - 0.4),
    barcodeWidthMm: rightW - 1.5,
    barcodeHeightMm: bottomH - 2
  };
}

function mmToPx(mm) {
  return Math.max(1, Math.round((Number(mm) / 25.4) * RASTER_DPI));
}

function localizacaoEmCaixaAlta(localizacao) {
  return String(localizacao || '')
    .trim()
    .toLocaleUpperCase('pt-PT');
}

function sanitizeFilenamePart(s) {
  return String(s || '')
    .trim()
    .replace(/[^\w.\-]+/gi, '_')
    .slice(0, 40) || 'item';
}

function normalizarQuantidade(val) {
  const raw = String(val ?? '').trim().replace(/\s/g, '');
  if (!raw) return null;
  if (!/^\d{1,6}$/.test(raw)) return null;
  return raw;
}

function normalizarItem(item, localizacaoPartilhada) {
  const codigo = String(item?.codigo || '').trim();
  const descricao = String(item?.descricao || '').trim();
  const locRaw = item?.localizacao != null ? item.localizacao : localizacaoPartilhada;
  const localizacao = localizacaoEmCaixaAlta(locRaw);
  const quantidade = normalizarQuantidade(item?.quantidade);
  return {
    codigo,
    descricao: descricao || codigo,
    localizacao,
    quantidade
  };
}

async function qrDataUrlForLocalizacao(localizacao, sizeMm) {
  const px = mmToPx(sizeMm);
  return QRCode.toDataURL(String(localizacao).trim(), {
    margin: 0,
    width: px,
    errorCorrectionLevel: 'M'
  });
}

function barcodeDataUrlCodigoArtigo(codigoArtigo, widthMm, heightMm) {
  const payload = String(codigoArtigo || '').trim();
  if (!payload) throw new Error('Código do artigo é obrigatório para o código de barras.');

  const targetW = mmToPx(widthMm);
  const targetH = mmToPx(heightMm);
  const barHeight = Math.round(targetH * 0.92);

  const tmp = document.createElement('canvas');
  JsBarcode(tmp, payload, {
    format: 'CODE128',
    displayValue: false,
    margin: 0,
    height: barHeight,
    width: 2.5
  });

  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, targetW, targetH);

  return out.toDataURL('image/png');
}

async function prepararAssetsEtiqueta(item, labelW, labelH) {
  const layout = calcLayoutMetrics(labelW, labelH);
  const [qrLocalizacao, barcodeCodigoArtigo] = await Promise.all([
    qrDataUrlForLocalizacao(item.localizacao, layout.qrSizeMm),
    Promise.resolve(
      barcodeDataUrlCodigoArtigo(item.codigo, layout.barcodeWidthMm, layout.barcodeHeightMm)
    )
  ]);
  return { payload: item, qrLocalizacao, barcodeCodigoArtigo };
}

/** Orientação da folha por modo de impressão. */
export function orientacaoFolhaPdf(modo) {
  return modo === MODOS_PDF.TRES_POR_FOLHA ? 'portrait' : 'landscape';
}

/** Calcula posição e tamanho de cada etiqueta na folha A4. */
export function calcSlotsA4(modo, quantidade) {
  const portrait = modo === MODOS_PDF.TRES_POR_FOLHA;
  const pageW = portrait ? A4_PORTRAIT_W_MM : A4_LANDSCAPE_W_MM;
  const pageH = portrait ? A4_PORTRAIT_H_MM : A4_LANDSCAPE_H_MM;
  const usableW = pageW - PAGE_MARGIN_MM * 2;
  const usableH = pageH - PAGE_MARGIN_MM * 2;

  if (modo === MODOS_PDF.FOLHA_INTEIRA) {
    const scale = Math.min(usableW / LABEL_W_MM, usableH / LABEL_H_MM);
    const labelW = LABEL_W_MM * scale;
    const labelH = LABEL_H_MM * scale;
    const x = PAGE_MARGIN_MM + (usableW - labelW) / 2;
    const y = PAGE_MARGIN_MM + (usableH - labelH) / 2;
    return [{ x, y, w: labelW, h: labelH }];
  }

  const n = Math.min(Math.max(Number(quantidade) || 1, 1), MAX_ETIQUETAS_TRES_POR_FOLHA);
  const gaps =
    (MAX_ETIQUETAS_TRES_POR_FOLHA - 1) * GAP_ENTRE_ETIQUETAS_MM;
  const labelH = (usableH - gaps) / MAX_ETIQUETAS_TRES_POR_FOLHA;
  const labelW = Math.min(usableW, labelH * LABEL_ASPECT);
  const x = PAGE_MARGIN_MM + (usableW - labelW) / 2;
  const slots = [];
  for (let i = 0; i < n; i += 1) {
    slots.push({
      x,
      y: PAGE_MARGIN_MM + i * (labelH + GAP_ENTRE_ETIQUETAS_MM),
      w: labelW,
      h: labelH
    });
  }
  return slots;
}

/** Ajusta só a descrição: tamanho e quebras para caber na caixa (largura + altura). */
function fitDescricaoNoEspaco(doc, text, maxWidthMm, maxHeightMm, startPt, minPt) {
  const payload = String(text || '').trim() || ' ';
  let size = startPt;
  doc.setFont('helvetica', 'bold');
  while (size >= minPt) {
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(payload, maxWidthMm);
    const lineH = size * LINE_HEIGHT_FACTOR;
    const blockH = lines.length * lineH;
    if (blockH <= maxHeightMm) {
      return { size, lines, lineH, blockH };
    }
    size -= 0.5;
  }
  doc.setFontSize(minPt);
  const lines = doc.splitTextToSize(payload, maxWidthMm);
  const lineH = minPt * LINE_HEIGHT_FACTOR;
  return { size: minPt, lines, lineH, blockH: lines.length * lineH };
}

/** Uma linha de texto que caiba em largura e altura (mm). */
function fitTextSingleLineInBox(doc, text, maxWmm, maxHmm, startPt, minPt) {
  const payload = String(text || '').trim() || ' ';
  let size = startPt;
  doc.setFont('helvetica', 'bold');
  while (size >= minPt) {
    doc.setFontSize(size);
    const d = doc.getTextDimensions(payload);
    if (d.w <= maxWmm && d.h <= maxHmm) return size;
    size -= 0.5;
  }
  doc.setFontSize(minPt);
  return minPt;
}

function baselineCentroCelula(doc, y, h, fontSizePt, textoAmostra) {
  doc.setFontSize(fontSizePt);
  const d = doc.getTextDimensions(textoAmostra);
  return y + (h + d.h) / 2 - d.h * 0.12;
}

function drawCaixaQuantidade(doc, x, y, w, h, qtyText, labelH) {
  const padLeft = 1;
  const padRight = 1.6;
  const gapQtdValor = 1.2;
  const maxHmm = Math.max(1, h - 0.8);
  const capPt = maxHmm / 0.36;

  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');

  const qtdLabelPt = Math.min(fontePadraoPt(labelH, FONT_QTD_LABEL_REF_PT), capPt * 0.85);
  doc.setFontSize(qtdLabelPt);
  const qtdLabelW = doc.getTextWidth('QTD');
  const valX0 = x + padLeft + qtdLabelW + gapQtdValor;
  const valX1 = x + w - padRight;
  const valWmm = Math.max(1, valX1 - valX0);
  const valCenterX = valX0 + valWmm / 2;

  const qtdMaxPt = Math.min(fontePadraoPt(labelH, FONT_QTD_REF_PT), capPt);
  const qtdMinPt = fontePadraoPt(labelH, 7);

  const labelBaseY = baselineCentroCelula(doc, y, h, qtdLabelPt, 'QTD');
  doc.text('QTD', x + padLeft, labelBaseY);

  const valPt = fitTextSingleLineInBox(doc, qtyText, valWmm, maxHmm, qtdMaxPt, qtdMinPt);
  doc.setFontSize(valPt);
  const valBaseY = baselineCentroCelula(doc, y, h, valPt, qtyText);
  doc.text(qtyText, valCenterX, valBaseY, { align: 'center' });
}

/** Linha horizontal na coluna esquerda, do limite esquerdo até à divisória vertical. */
function linhaHorizontalColunaEsquerda(doc, leftX, rightX, y) {
  doc.setDrawColor(0);
  doc.setLineWidth(0.25);
  doc.line(leftX, y, rightX, y);
}

function drawEtiqueta(doc, x0, y0, w, h, { codigo, descricao, localizacao, quantidade }, { qrLocalizacao, barcodeCodigoArtigo }) {
  const qtyText = quantidade ? String(quantidade) : '';
  const comQuantidade = Boolean(qtyText);
  const m = calcLayoutMetrics(w, h, { comQuantidade });
  const innerX = x0 + m.pad;
  const innerY = y0 + m.pad;
  const innerBottom = innerY + m.innerH;
  const leftX = innerX;
  const rightX = innerX + m.leftW;
  const headerBottom = innerY + m.headerH;
  const bottomSection = innerY + m.innerH - m.bottomH;

  doc.setDrawColor(0);
  doc.setLineWidth(0.25);
  doc.rect(x0, y0, w, h);

  const innerRight = innerX + m.innerW;

  doc.line(rightX, innerY, rightX, innerBottom);
  doc.line(rightX, headerBottom, innerRight, headerBottom);
  linhaHorizontalColunaEsquerda(doc, leftX, rightX, bottomSection);
  doc.line(rightX, bottomSection, innerRight, bottomSection);

  const qtyTop = comQuantidade ? bottomSection + m.locBottomH : null;
  if (qtyTop != null) {
    linhaHorizontalColunaEsquerda(doc, leftX, rightX, qtyTop);
  }

  const locText = localizacaoEmCaixaAlta(localizacao);
  const codText = String(codigo || '').trim();
  const descText = String(descricao || '').trim();

  const qrBoxH = bottomSection - innerY;
  const qrSize = Math.min(m.qrSizeMm, qrBoxH - 0.2);
  if (qrLocalizacao) {
    const qrX = leftX + (m.leftW - qrSize) / 2;
    const qrY = innerY + (qrBoxH - qrSize) / 2;
    doc.addImage(qrLocalizacao, 'PNG', qrX, qrY, qrSize, qrSize, undefined, 'NONE');
  }

  const scale = escalaEtiqueta(h);
  const locFont = fontePadraoPt(h, FONT_LOC_REF_PT);
  const digiFont = fontePadraoPt(h, FONT_DIGI_REF_PT);
  const codFont = fontePadraoPt(h, FONT_CODIGO_REF_PT);
  const descMaxPt = FONT_DESC_MAX_REF_PT * scale;
  const descMinPt = FONT_DESC_MIN_REF_PT * scale;

  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  const locMaxW = m.leftW - 1;
  const locAreaTop = bottomSection;
  const locAreaH = comQuantidade ? m.locBottomH : m.bottomH;

  if (comQuantidade) {
    const locCapPt = Math.min(locFont, locAreaH / 0.38);
    const locFit = fitDescricaoNoEspaco(
      doc,
      locText,
      locMaxW,
      Math.max(1, locAreaH - 0.6),
      locCapPt,
      fontePadraoPt(h, 7)
    );
    doc.setFontSize(locFit.size);
    const locY = locAreaTop + (locAreaH - locFit.blockH) / 2 + locFit.size * 0.32;
    doc.text(locFit.lines, leftX + m.leftW / 2, locY, { align: 'center' });

    drawCaixaQuantidade(doc, leftX, qtyTop, m.leftW, m.qtyH, qtyText, h);
  } else {
    doc.setFontSize(locFont);
    const locLines = doc.splitTextToSize(locText, locMaxW);
    const locLineH = locFont * LINE_HEIGHT_FACTOR;
    const locBlockH = locLines.length * locLineH;
    const locY = locAreaTop + (locAreaH - locBlockH) / 2 + locFont * 0.32;
    doc.text(locLines, leftX + m.leftW / 2, locY, { align: 'center' });
  }

  const headerMidY = innerY + m.headerH * 0.58;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(digiFont);
  doc.setTextColor(DIGI_BLUE[0], DIGI_BLUE[1], DIGI_BLUE[2]);
  doc.text('DIGI', rightX + 2.5, headerMidY);

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(codFont);
  doc.text(codText, innerX + m.innerW - 2, headerMidY, { align: 'right' });

  const descMaxW = m.rightW - 3;
  const descAreaH = bottomSection - headerBottom - 1;
  const { size: descFont, lines: descLines, lineH: descLineH, blockH: descBlockH } =
    fitDescricaoNoEspaco(doc, descText, descMaxW, descAreaH, descMaxPt, descMinPt);
  doc.setFontSize(descFont);
  const descStartY = headerBottom + (descAreaH - descBlockH) / 2 + descFont * 0.32;
  doc.text(descLines, rightX + m.rightW / 2, descStartY, { align: 'center' });

  if (barcodeCodigoArtigo) {
    const bcW = m.barcodeWidthMm;
    const bcH = m.barcodeHeightMm;
    const bcX = rightX + (m.rightW - bcW) / 2;
    const bcY = bottomSection + (m.bottomH - bcH) / 2;
    doc.addImage(barcodeCodigoArtigo, 'PNG', bcX, bcY, bcW, bcH, undefined, 'NONE');
  }
}

/**
 * Gera PDF: folha inteira (1 etiqueta) ou múltiplos por folha (3/página, páginas extra).
 * @param {{ modo: string, itens: Array<{ codigo: string, descricao?: string, localizacao?: string, quantidade?: string|number }>, localizacao?: string }} params
 * @param {{ filename?: string }} [opts]
 */
export async function gerarPdfIdentificacao(params, opts = {}) {
  const modo = params?.modo === MODOS_PDF.TRES_POR_FOLHA ? MODOS_PDF.TRES_POR_FOLHA : MODOS_PDF.FOLHA_INTEIRA;
  const localizacaoPartilhada = localizacaoEmCaixaAlta(params?.localizacao);

  const brutos = Array.isArray(params?.itens) ? params.itens : [];
  const itens = brutos
    .map((row) => normalizarItem(row, localizacaoPartilhada))
    .filter((row) => row.codigo && row.localizacao);

  if (itens.length === 0) {
    const msg =
      modo === MODOS_PDF.TRES_POR_FOLHA
        ? 'Indique pelo menos um artigo com código e localização (por artigo).'
        : 'Indique o artigo com código e localização.';
    throw new Error(msg);
  }

  const itensPdf = modo === MODOS_PDF.FOLHA_INTEIRA ? itens.slice(0, 1) : itens;
  const orientation = orientacaoFolhaPdf(modo);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation });

  if (modo === MODOS_PDF.TRES_POR_FOLHA) {
    for (let pageStart = 0; pageStart < itensPdf.length; pageStart += MAX_ETIQUETAS_TRES_POR_FOLHA) {
      if (pageStart > 0) {
        doc.addPage('a4', orientation);
      }
      const pageItens = itensPdf.slice(pageStart, pageStart + MAX_ETIQUETAS_TRES_POR_FOLHA);
      const slots = calcSlotsA4(modo, pageItens.length);
      for (let i = 0; i < pageItens.length; i += 1) {
        const slot = slots[i];
        if (!slot) break;
        const assets = await prepararAssetsEtiqueta(pageItens[i], slot.w, slot.h);
        drawEtiqueta(doc, slot.x, slot.y, slot.w, slot.h, assets.payload, assets);
      }
    }
  } else {
    const slots = calcSlotsA4(modo, itensPdf.length);
    const assets = await prepararAssetsEtiqueta(itensPdf[0], slots[0].w, slots[0].h);
    drawEtiqueta(doc, slots[0].x, slots[0].y, slots[0].w, slots[0].h, assets.payload, assets);
  }

  const primeiro = itensPdf[0];
  const baseName =
    opts.filename ||
    (modo === MODOS_PDF.TRES_POR_FOLHA
      ? `IDENT_${itensPdf.length}x_${sanitizeFilenamePart(primeiro.localizacao)}.pdf`
      : `IDENT_${sanitizeFilenamePart(primeiro.codigo)}_${sanitizeFilenamePart(primeiro.localizacao)}.pdf`);
  doc.save(baseName.endsWith('.pdf') ? baseName : `${baseName}.pdf`);
}

/** Compatível com chamada antiga (1 artigo, folha inteira). */
export async function gerarPdfIdentificacaoItem(dados, opts = {}) {
  return gerarPdfIdentificacao(
    {
      modo: MODOS_PDF.FOLHA_INTEIRA,
      localizacao: dados?.localizacao,
      itens: [dados]
    },
    opts
  );
}

export {
  LABEL_W_MM,
  LABEL_H_MM,
  A4_LANDSCAPE_W_MM as A4_W_MM,
  A4_LANDSCAPE_H_MM as A4_H_MM,
  A4_PORTRAIT_W_MM,
  A4_PORTRAIT_H_MM
};
