import { Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { invoiceDisplayLabels, type InvoiceDisplayStatus } from './invoice-collection.js';

interface InvoicePdfData {
  number: number;
  displayStatus: InvoiceDisplayStatus;
  issueDate: string;
  dueDate: string | null;
  workshop: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; discountCents: number; subtotalCents: number }[];
  subtotalCents: number;
  taxCents: number | null;
  totalCents: number | null;
  hasTax: boolean;
  paidCents: number;
  balanceCents: number | null;
  terms: string;
  notes: string;
  voidReason: string | null;
}

const money = new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP' });
const quantity = new Intl.NumberFormat('es-DO', { maximumFractionDigits: 3 });
const val = (value: unknown) => typeof value === 'string' ? value : '';
const price = (cents: number | null) => cents === null ? 'Sin calcular' : money.format(cents / 100);
const logger = new Logger('InvoicePdf');

export function invoicePdf(invoice: InvoicePdfData, taxLabel: string, logo: Buffer | null, seal: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ pdfVersion: '1.4', size: 'A4', margin: 42, compress: false, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    const left = 42;
    const width = pdf.page.width - 84;
    const primary = '#00A4B4';
    const accent = '#005D74';
    const dark = '#61666A';
    const bottom = () => pdf.page.height - pdf.page.margins.bottom;
    function image(buffer: Buffer | null, x: number, y: number, size: number, label: string): boolean {
      if (!buffer) return false;
      try {
        pdf.image(buffer, x, y, { fit: [size, size] });
        return true;
      } catch {
        logger.warn(`No se pudo renderizar ${label} de la factura administrativa ${invoice.number}.`);
        return false;
      }
    }

    pdf.rect(left, 42, width, 4).fill(primary);
    const start = 64;
    const hasLogo = image(logo, left, start, 76, 'el logo');
    const hasSeal = image(seal, left + width - 62, start, 62, 'el sello');
    const identityLeft = left + (hasLogo ? 94 : 0);
    const identityWidth = width - (hasLogo ? 94 : 0) - (hasSeal ? 80 : 0);
    const business = val(invoice.workshop.tradeName);
    const legal = val(invoice.workshop.legalName);
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(18).text(business || legal || val(invoice.workshop.workshopName) || 'Sastrería',
      identityLeft, start, { width: identityWidth });
    pdf.fillColor(dark).font('Helvetica').fontSize(9);
    const companyInfo = [
      legal && `Razón social: ${legal}`, val(invoice.workshop.rnc) && `RNC: ${val(invoice.workshop.rnc)}`,
      val(invoice.workshop.fiscalAddress) && `Dirección fiscal: ${val(invoice.workshop.fiscalAddress)}`,
      val(invoice.workshop.phone) && `Teléfono: ${val(invoice.workshop.phone)}`,
      val(invoice.workshop.email) && `Correo: ${val(invoice.workshop.email)}`,
    ].filter(Boolean);
    if (companyInfo.length) pdf.text(companyInfo.join('\n'), identityLeft, pdf.y + 6, { width: identityWidth, lineGap: 3 });
    pdf.y = Math.max(pdf.y + 20, start + (hasLogo ? 88 : hasSeal ? 74 : 0));
    const documentY = pdf.y;
    const number = `FA-${String(invoice.number).padStart(6, '0')}`;
    const state = invoiceDisplayLabels[invoice.displayStatus];
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(16).text('Factura administrativa', left, documentY);
    pdf.fontSize(12).text(number, left, pdf.y + 4);
    pdf.roundedRect(left + width - 126, documentY, 126, 26, 5).fill(accent);
    pdf.fillColor('#ffffff').fontSize(9).text(`Estado: ${state}`, left + width - 120, documentY + 8,
      { width: 114, align: 'center', lineBreak: false });
    pdf.fillColor(dark).font('Helvetica').fontSize(9).text(
      [`Emisión: ${invoice.issueDate}`, invoice.dueDate && `Vencimiento: ${invoice.dueDate}`].filter(Boolean).join('   ·   '),
      left, documentY + 47, { width },
    );
    pdf.fontSize(8).text(taxLabel, left, pdf.y + 4, { width });
    pdf.fontSize(7).text('NO CONSTITUYE UN COMPROBANTE FISCAL AUTORIZADO POR LA DGII', left, pdf.y + 5, { width });
    pdf.y += 18;
    const customer = [
      val(invoice.customer.name), val(invoice.customer.phone), val(invoice.customer.email), val(invoice.customer.address),
      invoice.customer.documentKind === 'rnc' && val(invoice.customer.documentNumber) &&
        `RNC: ${val(invoice.customer.documentNumber)}`,
    ].filter(Boolean).join('\n');
    pdf.font('Helvetica').fontSize(9);
    const customerY = pdf.y;
    const customerHeight = pdf.heightOfString(customer, { width: width - 24 }) + 42;
    pdf.fillOpacity(0.06).rect(left, customerY, width, customerHeight).fill(primary).fillOpacity(1);
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(9).text('DATOS DEL CLIENTE', left + 12, customerY + 10);
    pdf.fillColor(dark).font('Helvetica').fontSize(9).text(customer, left + 12, customerY + 27, { width: width - 24 });
    pdf.y = customerY + customerHeight + 20;

    const columns = [width - 228, 54, 86, 88];
    const rowHeight = (values: string[]) =>
      Math.max(...values.map((text, index) => pdf.heightOfString(text, { width: columns[index] - 14 }))) + 16;
    function row(values: string[], header = false, shaded = false): void {
      const y = pdf.y;
      pdf.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      const height = rowHeight(values);
      if (header) pdf.rect(left, y, width, height).fill(accent);
      else if (shaded) pdf.fillOpacity(0.04).rect(left, y, width, height).fill(primary).fillOpacity(1);
      pdf.fillColor(header ? '#ffffff' : dark);
      let x = left;
      values.forEach((text, index) => {
        pdf.text(text, x + 7, y + 7, { width: columns[index] - 14, align: index === 0 ? 'left' : 'right' });
        x += columns[index];
      });
      pdf.y = y + height;
    }
    const headers = ['Descripción', 'Cantidad', 'Precio', 'Subtotal'];
    if (pdf.y + 48 > bottom()) pdf.addPage();
    row(headers, true);
    invoice.lines.forEach((line, index) => {
      pdf.font('Helvetica').fontSize(9);
      const values = [line.description, quantity.format(line.quantityMilli / 1000), price(line.unitPriceCents), price(line.subtotalCents)];
      const needed = rowHeight(values);
      if (pdf.y + needed > bottom()) { pdf.addPage(); row(headers, true); }
      row(values, false, index % 2 === 0);
    });
    if (pdf.y + 190 > bottom()) pdf.addPage();
    pdf.moveDown();
    const totalsLeft = left + width - 255;
    const discount = invoice.lines.reduce((sum, line) => sum + line.discountCents, 0);
    pdf.fillColor(dark).font('Helvetica').fontSize(10);
    const totalLine = (label: string, value: string) => {
      const y = pdf.y;
      pdf.text(label, totalsLeft, y, { width: 140 });
      pdf.text(value, totalsLeft + 140, y, { width: 115, align: 'right' });
      pdf.y += 7;
    };
    totalLine('Subtotal', price(invoice.subtotalCents + discount));
    totalLine('Descuento', price(discount));
    if (invoice.hasTax) totalLine('ITBIS:', price(invoice.taxCents));
    const totalY = pdf.y;
    pdf.rect(totalsLeft - 7, totalY, 269, 32).fill(accent);
    pdf.rect(totalsLeft - 7, totalY, 3, 32).fill(primary);
    pdf.y = totalY + 10;
    pdf.fillColor('#ffffff').font('Helvetica-Bold');
    totalLine('TOTAL GENERAL', price(invoice.totalCents));
    pdf.y = totalY + 45;
    pdf.fillColor(dark).font('Helvetica').fontSize(9);
    if (invoice.balanceCents !== null) {
      totalLine('Monto pagado', price(invoice.paidCents));
      totalLine('Saldo pendiente', price(invoice.balanceCents));
    }
    pdf.moveDown();
    for (const [heading, text] of [['Observaciones', invoice.terms], ['Notas', invoice.notes], ['Motivo de anulación', invoice.voidReason]]) {
      if (!text) continue;
      if (pdf.y + 35 > bottom()) pdf.addPage();
      pdf.fillColor(dark).font('Helvetica-Bold').text(heading!, left, pdf.y, { width });
      pdf.font('Helvetica').text(text, left, pdf.y, { width }).moveDown();
    }
    const pages = pdf.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page++) {
      pdf.switchToPage(page);
      // Footer text must not trigger automatic body pagination.
      const bottomMargin = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      pdf.moveTo(left, pdf.page.height - 34).lineTo(left + width, pdf.page.height - 34).strokeColor(primary).stroke();
      pdf.fillColor(dark).font('Helvetica').fontSize(7).text(
        `${number}  ·  Página ${page + 1} de ${pages.count}`, left, pdf.page.height - 25,
        { width, align: 'right', lineBreak: false },
      );
      pdf.page.margins.bottom = bottomMargin;
    }
    pdf.end();
  });
}
