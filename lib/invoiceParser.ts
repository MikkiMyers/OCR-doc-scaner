// lib/invoiceParser.ts
import { SmartFields, LineItem, MoneyField as SMoneyField } from '@/lib/smartParser';

export interface InvoiceParseResult {
  text: string;
  fields: SmartFields;
  lineItems: LineItem[];
}

/* ---------------- utils ---------------- */
const normalizeNumber = (s: string): number | undefined => {
  const cleaned = (s || '')
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
};

const moneyField = (raw?: string | null): SMoneyField | undefined => {
  if (!raw) return undefined;
  const value = normalizeNumber(raw);
  return { raw, value, text: value !== undefined ? value.toFixed(2) : raw };
};

const percentFrom = (raw?: string | null): number | undefined => {
  if (!raw) return undefined;
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return m ? parseFloat(m[1]) : undefined;
};

/* ------------- core helpers ------------- */
function extractItemsSegment(clean: string): string | undefined {
  // หา header ของตาราง (รูปแบบพบบ่อย)
  const header =
    clean.match(/DESCRIPTION\s+UNIT\s+PRICE\s+QTY\s+TOTAL/i) ||
    clean.match(/DESCRIPTION\s+QTY\s+UNIT\s+PRICE\s+TOTAL/i) ||
    clean.match(/DESCRIPTION\s+PRICE\s+QTY\s+TOTAL/i) ||
    clean.match(/DESCRIPTION\s+QTY\s+TOTAL/i) || 
    clean.match(/DESCRIPTION\s+UNIT\s+PRICE\s+QUANTITY\s+TOTAL/i);

  if (!header || header.index === undefined) return undefined;

  const startIdx = header.index + header[0].length;
  const tailSlice = clean.slice(startIdx);

  // ตัดถึง SUBTOTAL หรือ TOTAL (word boundary กันชน SUBTOTAL)
  const tailMatch = tailSlice.match(/\bSUBTOTAL\b|(?:^|\b)TOTAL\b/i);
  const endIdx = tailMatch && tailMatch.index !== undefined
    ? startIdx + tailMatch.index
    : clean.length;

  const seg = clean.slice(startIdx, endIdx).replace(/\s+/g, ' ').trim();
  return seg || undefined;
}

function parseItemsFromSegment(seg: string): LineItem[] {
  const items: LineItem[] = [];

  // โครง: <desc> <unitPrice> <qty> <amount>
  // ตัวอย่าง: "Brand consultation 100 1 $100"
  // ใช้ lookahead ให้หยุดก่อนคำขึ้นต้นตัวอักษรถัดไป หรือจบสตริง
  const re =
    /([A-Za-z][A-Za-z0-9\s\-\/&.,]+?)\s+(\$?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+\$?(\d+(?:\.\d+)?)(?=\s+[A-Za-z]|$)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    items.push({
      description: m[1].trim(),
      unitPrice: m[2],
      qty: m[3],
      amount: m[4],
    });
  }
  return items;
}

/* ------------- main parser ------------- */
export function parseInvoice(text: string): InvoiceParseResult {
  const fields: SmartFields = { docType: 'invoice' };
  const lineItems: LineItem[] = [];

  const clean = (text || '').replace(/\r/g, '').trim();

  /* doc no (เอาเฉพาะจาก INVOICE NO:) */
  const docNoMatch = clean.match(/INVOICE\s*NO[:\s]*([A-Za-z0-9\-]+)/i);
  if (docNoMatch) fields.docNo = docNoMatch[1].trim();

  /* dates */
  const dateMatch = clean.match(/(?:^|\s)DATE[:\s]*([0-9./-]+)/i);
  if (dateMatch) fields.date = dateMatch[1].trim();

  const dueMatch = clean.match(/DUE\s*DATE[:\s]*([0-9./-]+)/i);
  if (dueMatch) fields.dueDate = dueMatch[1].trim();

  /* parties */
  // ISSUED TO: ... (จนกว่าจะถึง PAY TO: หรือ INVOICE)
  const issuedToBlock = clean.match(/ISSUED TO:?\s*([\s\S]*?)(?=\n\s*(PAY TO:|INVOICE\b))/i);
  if (issuedToBlock) {
    fields.buyer = issuedToBlock[1].replace(/\s+/g, ' ').trim();
  } else {
    const issuedSimple = clean.match(/ISSUED TO:?\s*([\s\S]*?)\n\n/i);
    if (issuedSimple) fields.buyer = issuedSimple[1].replace(/\s+/g, ' ').trim();
  }

  const payToBlock = clean.match(/PAY TO:?\s*([\s\S]*?)(?=\n\s*INVOICE\b)/i);
  if (payToBlock) {
    fields.seller = payToBlock[1].replace(/\s+/g, ' ').trim();
  } else {
    const payToSimple = clean.match(/PAY TO:?\s*([\s\S]*?)\n\n/i);
    if (payToSimple) fields.seller = payToSimple[1].replace(/\s+/g, ' ').trim();
  }

  /* amounts */
  const subtotalMatch = clean.match(/(?:^|\b)SUBTOTAL\b[:\s]*\$?([\d,]+(?:\.\d+)?)/i);
  if (subtotalMatch) fields.subtotal = moneyField(subtotalMatch[1]);

  // รองรับ "VAT: 40" หรือ "Tax 10%"
  const vatMatch = clean.match(/(?:VAT|Tax)\b[:\s]*([0-9.,]+%?)/i);
  if (vatMatch) {
    const raw = vatMatch[1];
    if (/%/.test(raw)) {
      fields.vat = { raw, value: undefined, text: raw };
    } else {
      fields.vat = moneyField(raw);
    }
  }

  // TOTAL ต้องเป็น word boundary ไม่ชน SUBTOTAL
  const totalMatch = clean.match(/(?:^|\b)TOTAL\b[:\s]*\$?([\d,]+(?:\.\d+)?)/i);
  if (totalMatch) fields.total = moneyField(totalMatch[1]);

  // ถ้าไม่เจอ TOTAL แต่มี subtotal + VAT%
  if (!fields.total?.value && fields.subtotal?.value !== undefined) {
    const p = percentFrom(fields.vat?.raw || fields.vat?.text);
    if (p !== undefined) {
      const est = +(fields.subtotal.value * (1 + p / 100)).toFixed(2);
      fields.total = { raw: est.toString(), value: est, text: est.toFixed(2) };
    }
  }

  /* line items (จาก segment ระหว่างหัวตาราง → SUBTOTAL/TOTAL) */
  const seg = extractItemsSegment(clean);
  if (seg) {
    const items = parseItemsFromSegment(seg);
    lineItems.push(...items);
  } else {
    // fallback แบบบรรทัดต่อบรรทัด (กรณีเอกสารบางแบบ)
    const lines = clean.split(/\n+/);
    const re = /^(.+?)\s+(\$?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+\$?(\d+(?:\.\d+)?)(?!\S)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) {
        lineItems.push({
          description: m[1].trim(),
          unitPrice: m[2],
          qty: m[3],
          amount: m[4],
        });
      }
    }
  }

  return { text: clean, fields, lineItems };
}

export default parseInvoice;
