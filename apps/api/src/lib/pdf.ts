/**
 * Minimal dependency-free PDF 1.4 writer for text statements (Helvetica, A4/Letter-agnostic 612x792 pt pages).
 * Non-ASCII characters are replaced so the standard font encoding is always valid.
 */
const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export interface PdfLine { text: string; bold?: boolean; size?: number }

export function textPdf(lines: PdfLine[], title: string): Buffer {
  const perPage = 54;
  const pages: PdfLine[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));
  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((pl, pi) => {
    let y = 750;
    const ops = ['BT'];
    for (const l of pl) {
      ops.push(`/${l.bold ? 'F2' : 'F1'} ${l.size ?? 10} Tf 1 0 0 1 50 ${y} Tm (${esc(l.text)}) Tj`);
      y -= (l.size ?? 10) + 3;
    }
    ops.push(`/F1 8 Tf 1 0 0 1 50 30 Tm (${esc(`${title} - page ${pi + 1} of ${pages.length}`)}) Tj`, 'ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Title (${esc(title)}) /Producer (RMN) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
