import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdfkit';

const regularFont = fileURLToPath(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url));
const boldFont = fileURLToPath(new URL('../assets/fonts/NotoSans-Bold.ttf', import.meta.url));
const colors = { ink: '#17313B', muted: '#70818D', green: '#398F73', line: '#DFE7EB', pale: '#F3F8F6' };
const cleanText = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[\u2010-\u2015]/g, '-');

export function invoicePdfFileName(invoice) {
  const number = String(invoice.invoiceNumber || invoice._id || 'invoice').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${number || 'invoice'}.pdf`;
}

// Only saved invoice fields are used. There is no invented tax, payment or issuer address.
export function invoicePdfData(invoice, settings = {}) {
  const amount = typeof invoice.amount === 'number' ? invoice.amount : NaN;
  if (!Number.isFinite(amount) || amount < 0 || !['INR', 'USD', 'EUR'].includes(invoice.currency) || !['Draft', 'Issued', 'Paid', 'Void'].includes(invoice.status)) throw new Error('The saved invoice has invalid billing details.');
  let dateFormatter;
  try { dateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: settings.defaultTimezone || 'Asia/Kolkata' }); }
  catch { dateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  const date = value => { const parsed = value ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? dateFormatter.format(parsed) : 'Not set'; };
  const money = value => `${invoice.currency} ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
  return {
    platformName: cleanText(settings.platformName || 'WABADesk'),
    support: [settings.supportEmail, settings.supportPhone].filter(Boolean).map(cleanText),
    number: cleanText(invoice.invoiceNumber || invoice._id),
    workspace: cleanText(invoice.workspace?.name || 'Workspace unavailable'),
    workspaceId: cleanText(invoice.workspace?._id || ''),
    description: cleanText(invoice.description || 'No description provided'),
    status: invoice.status,
    createdOn: date(invoice.createdAt), dueOn: date(invoice.dueAt),
    paidOn: invoice.paidAt ? date(invoice.paidAt) : '',
    paymentReference: cleanText(invoice.paymentReference || ''),
    total: money(amount),
    balance: invoice.status === 'Paid' ? money(0) : invoice.status === 'Issued' ? money(amount) : 'Not payable',
  };
}

// Split very long words as well as normal paragraphs, without breaking Unicode graphemes.
function wrapText(doc, text, width) {
  const lines = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const paragraph of cleanText(text).split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\S+\s*/gu) || []) {
      if (doc.widthOfString((line + token).trimEnd()) <= width) { line += token; continue; }
      if (line.trimEnd()) { lines.push(line.trimEnd()); line = ''; }
      for (const { segment } of segmenter.segment(token)) {
        if (line && doc.widthOfString(line + segment) > width) { lines.push(line.trimEnd()); line = ''; }
        line += segment;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function generateInvoicePdf(invoice, settings = {}) {
  const data = invoicePdfData(invoice, settings);
  const doc = new PDFDocument({ size: 'A4', margin: 48, autoFirstPage: false, bufferPages: true, info: { Title: `Invoice ${data.number}`, Author: data.platformName, Subject: 'Saved WABA platform invoice' } });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('Body', regularFont); doc.registerFont('Bold', boldFont);
      renderInvoice(doc, data);
      doc.end();
    } catch (error) { reject(error); }
  });
}

function renderInvoice(doc, data) {
  const left = 48, width = 499.28, right = left + width;
  let y = 48, descriptionContinued = false;
  const style = (size = 11, bold = false, color = colors.ink) => doc.font(bold ? 'Bold' : 'Body').fontSize(size).fillColor(color);
  const rule = position => doc.save().strokeColor(colors.line).lineWidth(0.7).moveTo(left, position).lineTo(right, position).stroke().restore();
  const textAt = (text, x, position, options = {}) => {
    style(options.size, options.bold, options.color);
    const textWidth = options.width || width;
    const fontSize = options.fit ? Math.min(options.size || 11, (options.size || 11) * (textWidth - 1) / Math.max(1, doc.widthOfString(text))) : options.size || 11;
    doc.fontSize(fontSize);
    // An explicit single-line height prevents PDFKit's width wrapper from adding
    // pages while drawing positioned footer text below the normal content margin.
    doc.text(text, x, position, { width: textWidth, height: fontSize * 1.5, lineBreak: false, align: options.align || 'left' });
  };
  const tableHeading = continued => {
    doc.save().fillColor(colors.pale).rect(left, y, width, 30).fill().restore();
    textAt(continued ? 'DESCRIPTION (CONTINUED)' : 'DESCRIPTION', left + 12, y + 8, { size: 9, bold: true, color: colors.muted, width: 340 });
    textAt('AMOUNT', right - 130, y + 8, { size: 9, bold: true, color: colors.muted, width: 118, align: 'right' });
    y += 43;
  };
  const addPage = (first = false) => {
    doc.addPage(); y = 48;
    doc.save().fillColor(colors.green).rect(left, 32, width, 4).fill().restore();
    if (!first) {
      // Full branding/number appear on page one; compact identifiers repeat on later pages.
      style(11, true); doc.text(data.platformName, left, y, { width: width - 150, height: 18, ellipsis: true, lineBreak: false });
      textAt('INVOICE / CONTINUED', right - 145, y + 2, { size: 9, color: colors.muted, width: 145, align: 'right' });
      textAt(data.number, left, 75, { size: 9, color: colors.muted });
      y = 105;
      if (descriptionContinued) tableHeading(true);
    }
  };
  const ensure = height => { if (y + height > doc.page.height - 78) addPage(); };
  const linesFor = (text, options = {}) => { style(options.size, options.bold, options.color); return wrapText(doc, text, options.width || width); };
  const write = (text, options = {}) => {
    const lines = linesFor(text, options), lineHeight = (options.size || 11) * 1.5;
    for (const line of lines) { ensure(lineHeight); textAt(line, options.x || left, y, options); y += lineHeight; }
  };
  const label = text => write(text, { size: 9, bold: true, color: colors.muted });

  addPage(true);
  const brandLines = linesFor(data.platformName, { size: 22, bold: true, width: width - 155 });
  textAt('INVOICE', right - 145, y, { size: 24, bold: true, color: colors.green, width: 145, align: 'right' });
  write(brandLines.join('\n'), { size: 22, bold: true, width: width - 155 });
  y += 6;
  for (const contact of data.support) write(contact, { size: 9, color: colors.muted });
  y += 18;
  label('INVOICE NUMBER');
  write(data.number, { size: 12, bold: true });
  y += 18; rule(y); y += 22;

  const details = [['Status', data.status], ['Created on', data.createdOn], ['Due on', data.dueOn]];
  if (data.paidOn) details.push(['Payment recorded on', data.paidOn]);
  const customerLines = linesFor(data.workspace, { size: 15, bold: true, width: 240 });
  const blockHeight = Math.max(27 + customerLines.length * 22.5 + (data.workspaceId ? 25 : 0), details.length * 25);
  ensure(blockHeight + 20);
  const blockTop = y;
  label('BILLED WORKSPACE'); y += 7;
  write(data.workspace, { size: 15, bold: true, width: 240 });
  if (data.workspaceId) { y += 8; write(`ID: ${data.workspaceId}`, { size: 8, color: colors.muted, width: 240 }); }
  details.forEach(([key, value], index) => {
    textAt(key, left + 280, blockTop + index * 25, { size: 9, color: colors.muted, width: 113 });
    textAt(value, left + 395, blockTop + index * 25, { size: 9, bold: true, width: width - 395, align: 'right' });
  });
  y = blockTop + blockHeight + 28;

  ensure(65); tableHeading(false);
  textAt(data.total, right - 140, y, { size: 11, bold: true, width: 128, align: 'right', fit: true });
  descriptionContinued = true;
  write(data.description, { size: 11, x: left + 12, width: width - 168 });
  descriptionContinued = false;
  y += 18; ensure(112); rule(y); y += 24;

  doc.save().fillColor(colors.pale).roundedRect(right - 254, y, 254, 82, 6).fill().restore();
  textAt('Invoice total', right - 238, y + 14, { size: 10, width: 110 });
  textAt(data.total, right - 130, y + 12, { size: 12, bold: true, width: 114, align: 'right', fit: true });
  textAt('Balance due', right - 238, y + 49, { size: 10, width: 110 });
  textAt(data.balance, right - 130, y + 47, { size: 11, bold: true, color: colors.green, width: 114, align: 'right', fit: true });
  y += 106;
  if (data.paymentReference) { ensure(36); label('EXTERNAL PAYMENT REFERENCE'); y += 6; write(data.paymentReference, { size: 10 }); y += 20; }
  if (data.status === 'Draft') write('DRAFT - This invoice is not a payment request.', { size: 10, bold: true, color: colors.muted });
  if (data.status === 'Void') write('VOID - This invoice is no longer payable.', { size: 10, bold: true, color: colors.muted });
  y += 10;
  write('Payments are confirmed outside WABA. Downloading this document does not charge a card, deduct wallet money or trigger Smartping billing.', { size: 9, color: colors.muted });

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    const footerY = doc.page.height - 49;
    rule(footerY - 12);
    textAt('Saved invoice record', left, footerY, { size: 8, color: colors.muted, width: 260 });
    textAt(`Page ${index - pages.start + 1} of ${pages.count}`, right - 110, footerY, { size: 8, color: colors.muted, width: 110, align: 'right' });
  }
}
