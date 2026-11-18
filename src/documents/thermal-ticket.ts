import { createHash } from 'node:crypto';
import QRCode from 'qrcode';

type Field = { label: string; value: string };
export interface ThermalTicket {
  title: string;
  number: string;
  date: Date;
  documentDate?: string;
  user: string;
  business: Record<string, unknown>;
  customer: Record<string, unknown>;
  logo: { mime: string; bytes: Buffer } | null;
  seal: { mime: string; bytes: Buffer } | null;
  status?: string;
  facts?: Field[];
  lines?: { description: string; quantity: string; price: string; amount: string }[];
  totals: (Field & { emphasis?: boolean })[];
  notes?: string[];
  qrUrl?: string;
}

const css = `
:root{font:14px/1.4 Arial,sans-serif;color:#61666A;--primary:#00A4B4;--secondary:#005D74}
*{box-sizing:border-box}
body{margin:0;background:rgba(0,164,180,.06)}
.controls{padding:1rem;text-align:center}
button{font:inherit;background:var(--secondary);color:white;border:0;border-radius:5px;padding:.65rem 1rem;cursor:pointer}
button:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.ticket{width:72mm;max-width:100%;margin:0 auto 1rem;padding:3mm;background:white;border-top:3px solid var(--primary);overflow-wrap:anywhere}
header,.center{text-align:center}
h1,h2,p,dl,dd,ol,figure{margin:0}
h1{font-size:1.35em;color:var(--secondary);line-height:1.2;margin-bottom:2mm}
h2{font-size:.92em;color:var(--secondary);margin-bottom:1mm}
header p{font-size:.88em;margin-top:.5mm}
.document-number{font-size:1.05em;letter-spacing:.04em}
.status{display:inline-block;background:var(--secondary);color:white;border:1px solid var(--secondary);border-radius:4px;padding:1mm 2mm;margin:2mm 0;font-size:.88em}
section,footer{margin-top:2mm;padding-top:2mm;border-top:1px dashed currentColor}
ul,ol{list-style:none;padding:0}
li{margin-top:1mm}
dl div,.line-data{display:flex;justify-content:space-between;align-items:baseline;gap:2mm}
dd{text-align:right;font-variant-numeric:tabular-nums}
.concept,.totals div,figure{break-inside:avoid}
.line-data{font-size:.92em;flex-wrap:wrap}
.emphasis{font-weight:bold;font-size:1.1em;background:var(--secondary);color:white;border-left:3px solid var(--primary);padding:2mm 1mm;margin-block:1mm}
.brand{display:block;max-width:100%;max-height:23mm;margin:0 auto 1mm;object-fit:contain}
.qr{width:30mm;height:30mm;display:block;margin:auto;image-rendering:pixelated}
.note{margin-top:1mm;white-space:pre-wrap}
@page{size:auto;margin:0}
@media print{
  :root{font-size:9pt;color:#000}
  body{background:white}
  .controls{display:none}
  .ticket{margin:0 auto;border-color:#000}
  h1,h2{color:#000}
  .status{background:white;color:#000;border-color:#000}
  .brand{filter:grayscale(1)}
  .emphasis{background:white;color:#000;border-color:#000;border-block:1px solid #000}
  h1,h2{break-after:avoid}
}`;
const printScript = `document.getElementById('print-ticket').addEventListener('click',()=>globalThis.print());`;
const hash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
export const thermalTicketCsp = `default-src 'none'; script-src ${hash(printScript)}; style-src ${hash(css)}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const dateFormat = new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeZone: 'America/Santo_Domingo' });
const timeFormat = new Intl.DateTimeFormat('es-DO', { timeStyle: 'short', timeZone: 'America/Santo_Domingo' });
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => entities[char]);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const paragraphs = (values: string[]) => values.filter(Boolean).map((value) => `<p>${escape(value)}</p>`).join('');
const field = ({ label, value }: Field) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`;
const image = (asset: ThermalTicket['logo'], alt: string) =>
  asset?.bytes.length && (asset.mime === 'image/png' || asset.mime === 'image/jpeg')
    ? `<img class="brand" src="data:${asset.mime};base64,${asset.bytes.toString('base64')}" alt="${alt}">` : '';

export async function renderThermalTicket(ticket: ThermalTicket): Promise<string> {
  const { business, customer } = ticket;
  const name = text(business.tradeName) || text(business.legalName) || text(business.workshopName) || 'Sastrería';
  const legalName = text(business.legalName);
  const rnc = text(business.rnc);
  const document = text(customer.documentNumber);
  const documentDate = ticket.documentDate ? new Date(`${ticket.documentDate}T12:00:00-04:00`) : ticket.date;
  const date = dateFormat.format(documentDate);
  const qr = await QRCode.toDataURL(ticket.qrUrl ?? `${ticket.number}\n${date}`, { errorCorrectionLevel: 'M', scale: 6, margin: 4 });
  return `<!doctype html>
<html lang="es-DO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(`${ticket.title} ${ticket.number}`)}</title><style>${css}</style></head>
<body><div class="controls"><button id="print-ticket" type="button">Imprimir ticket</button>
<p>Papel de 80 mm · escala 100 % · sin encabezados ni pies del navegador</p></div>
<main class="ticket"><header>${image(ticket.logo, 'Logo de la sastrería')}<h1>${escape(name)}</h1>
${paragraphs([legalName && `Razón social: ${legalName}`, rnc && `RNC: ${rnc}`,
    text(business.fiscalAddress) && `Dirección fiscal: ${text(business.fiscalAddress)}`,
    text(business.phone) && `Teléfono: ${text(business.phone)}`, text(business.email) && `Correo: ${text(business.email)}`])}
${image(ticket.seal, 'Sello de la sastrería')}
<section class="center"><h2>${escape(ticket.title)}</h2><p class="document-number"><strong>${escape(ticket.number)}</strong></p>
${ticket.status ? `<p class="status">Estado: <strong>${escape(ticket.status)}</strong></p>` : ''}
<p>${escape(date)} · ${escape(timeFormat.format(ticket.date))}</p><p>Usuario: ${escape(ticket.user)}</p></section></header>
<section><h2>Cliente</h2>${paragraphs([text(customer.name), text(customer.phone), text(customer.email), text(customer.address),
    document && `${text(customer.documentKind).toLowerCase() === 'rnc' ? 'RNC' : 'Documento'}: ${document}`])}</section>
${ticket.facts?.length ? `<section><dl>${ticket.facts.map((item) => `<div>${field(item)}</div>`).join('')}</dl></section>` : ''}
${ticket.lines?.length ? `<section><h2>Detalle</h2><ol>${ticket.lines.map((line) => `<li class="concept">
<strong>${escape(line.description)}</strong><div class="line-data">
<span>Cant.: ${escape(line.quantity)} × ${escape(line.price)}</span><span>Importe: ${escape(line.amount)}</span></div></li>`).join('')}</ol></section>` : ''}
<section><dl class="totals">${ticket.totals.map((item) => `<div${item.emphasis ? ' class="emphasis"' : ''}>${field(item)}</div>`).join('')}</dl></section>
<footer class="center">
${ticket.notes?.filter(Boolean).map((note) => `<p class="note">${escape(note)}</p>`).join('') ?? ''}
<figure><img class="qr" src="${qr}" alt="Código QR de referencia del documento"></figure></footer></main>
<script>${printScript}</script></body></html>`;
}
