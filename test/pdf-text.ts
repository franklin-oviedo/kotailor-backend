export function pdfText(pdf: Buffer): string {
  return [...pdf.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .map((line) => [...line[1].matchAll(/<([0-9a-f]+)>/gi)]
      .map((fragment) => Buffer.from(fragment[1], 'hex').toString('latin1')).join(''))
    .join('\n');
}
