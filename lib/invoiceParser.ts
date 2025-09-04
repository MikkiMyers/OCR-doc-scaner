// lib/invoiceParser.ts
import { SmartFields, LineItem, MoneyField as SMoneyField } from '@/lib/smartParser';

export interface InvoiceParseResult {
  text: string;
  fields: SmartFields;
  lineItems: LineItem[];
}

/* --------------------- helpers --------------------- */
const trim = (s: string) => (s || '').replace(/[ \t]+/g, ' ').trim();
const toThousands = (n: number | undefined): string | undefined =>
  typeof n === 'number' && isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : undefined;

const cleanText = (t: string) =>
  trim(
    (t || '')
      .normalize('NFC')
      .replace(/\u00A0/g, ' ')
      .replace(/[|[\]]/g, '') // ตัดตัวอักษรเกะกะ เช่น | ]
  );

/** "23 75" -> "23.75", "2375" -> "23.75" */
const normalizeQty = (raw: string) => {
  let s = String(raw).replace(/[^\d\s.,-]/g, '').replace(/,/g, '');
  s = s.replace(/\b(\d+)\s+(\d{2})\b/g, '$1.$2');
  if (/^\d{3,}$/.test(s) && !/\./.test(s)) s = s.slice(0, -2) + '.' + s.slice(-2);
  return s;
};

const parseMoneyToken = (raw: string): number | undefined => {
  if (!raw) return undefined;
  let s = String(raw).replace(/[^\d\s.,]/g, '');
  s = s.replace(/\b(\d+)\s+(\d{2})\b/g, '$1.$2'); // "40 00" -> "40.00"
  s = s.replace(/,/g, '');
  if (/\d\.\d{1,}/.test(s)) {
    const n = parseFloat(s); return isFinite(n) ? n : undefined;
  }
  if (/^\d{3,}$/.test(s)) {
    const n = parseFloat(`${s.slice(0, -2)}.${s.slice(-2)}`);
    return isFinite(n) ? n : undefined;
  }
  if (/^\d+$/.test(s)) {
    const n = parseFloat(s); return isFinite(n) ? n : undefined;
  }
  return undefined;
};

const moneyField = (raw?: string): SMoneyField | undefined => {
  if (!raw) return undefined;
  const v = parseMoneyToken(raw);
  return { raw: String(raw), value: v, text: toThousands(v) };
};

/* ------------------ line items (token stream) ------------------ */
const sliceItemsRegion = (clean: string): string | undefined => {
  // ยอมให้อยู่บรรทัดเดียวกันได้
  const headerRe = /\b(QUANTITY|QTY)\b\s+DESCRIPTION\s+\b(UNIT\s+PRICE|PRICE)\b\s+\b(COST|AMOUNT)\b/i;
  const h = headerRe.exec(clean);
  if (!h || h.index == null) return undefined;

  const afterHeaderIdx = h.index + h[0].length;

  // ตัดท้ายที่ SUBTOTAL หรือ TOTAL (แบบ word boundary กันชน Subtotal)
  const tail = clean.slice(afterHeaderIdx);
  const endMatch = /(\bSUBTOTAL\b|\bTOTAL\s+DUE\b|\bTOTAL\b)/i.exec(tail);
  const endIdx = endMatch?.index != null ? afterHeaderIdx + endMatch.index! : clean.length;

  const seg = clean.slice(afterHeaderIdx, endIdx);
  return seg.trim() || undefined;
};

const isWord = (t: string) => /[A-Za-z]/.test(t);
const isNum = (t: string) => /^\$?[\d.,]+$/.test(t);

// รวมโทเคนเงินกรณีแตกเป็น "40 00"
const readMoney = (tokens: string[], i: number) => {
  const cur = tokens[i] || '';
  const nxt = tokens[i + 1] || '';

  // case มีจุดอยู่แล้ว / มี comma
  if (/\d[\d,]*\.\d{1,2}/.test(cur) || /^\$?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cur)) {
    const v = parseMoneyToken(cur);
    if (v != null) return { raw: cur, value: v, next: i + 1 };
  }

  // case "40 00"
  if (/^\d+$/.test(cur) && /^\d{2}$/.test(nxt)) {
    const raw = `${cur} ${nxt}`;
    const v = parseMoneyToken(raw);
    if (v != null) return { raw, value: v, next: i + 2 };
  }

  // case "100000" (-> 1000.00)
  if (/^\d{3,}$/.test(cur)) {
    const v = parseMoneyToken(cur);
    if (v != null) return { raw: cur, value: v, next: i + 1 };
  }

  return null;
};

const readQty = (tokens: string[], i: number) => {
  const cur = tokens[i] || '';
  const nxt = tokens[i + 1] || '';
  if (/^\d+$/.test(cur) && /^\d{2}$/.test(nxt)) {
    return { raw: `${cur} ${nxt}`, text: normalizeQty(`${cur} ${nxt}`), next: i + 2 };
  }
  if (/^\d{1,4}([.,]\d{1,2})?$/.test(cur) || /^\d{3,}$/.test(cur)) {
    return { raw: cur, text: normalizeQty(cur), next: i + 1 };
  }
  return null;
};

const parseLineItems = (seg: string): LineItem[] => {
  const tokens = seg.replace(/\n+/g, ' ').split(/\s+/).filter(Boolean);
  const items: LineItem[] = [];
  let i = 0;

  while (i < tokens.length) {
    // อ่าน qty
    const q = readQty(tokens, i);
    if (!q) { i++; continue; }
    let j = q.next;

    // เดินเก็บคำอธิบายจนพบเงินก้อนแรก
    let firstMoneyIdx = -1;
    for (let k = j; k < Math.min(tokens.length, j + 20); k++) {
      const m = readMoney(tokens, k);
      if (m) { firstMoneyIdx = k; break; }
    }
    if (firstMoneyIdx === -1) { i = j; continue; }

    // เงินก้อนที่สอง (amount)
    const m1 = readMoney(tokens, firstMoneyIdx)!;
    const m2 = readMoney(tokens, m1.next || firstMoneyIdx + 1);
    if (!m2) { i = m1.next; continue; }

    const desc = trim(tokens.slice(j, firstMoneyIdx).join(' '));
    if (!desc || !isWord(desc)) { i = m2.next; continue; }

    const unit = m1.value;
    const amt = m2.value;

    // sanity check: unit * qty ~ amount (ยอมเพี้ยนเล็กน้อย)
    const qn = parseFloat(q.text);
    const expect = isFinite(qn) && unit != null ? +(qn * unit).toFixed(2) : undefined;
    const ok = expect == null || amt == null ? true : Math.abs(amt - expect) <= Math.max(0.05, expect * 0.02);

    if (ok) {
      items.push({
        description: desc,
        unitPrice: unit != null ? toThousands(unit) ?? String(unit) : undefined as any,
        qty: q.text,
        amount: amt != null ? toThousands(amt) ?? String(amt) : undefined as any,
      } as LineItem);
      i = m2.next;
    } else {
      // ถ้าไม่แมตช์ ให้ขยับทีละหนึ่งกันติดลูป
      i = j;
    }
  }

  return items;
};

/* --------------------- main parser --------------------- */
export function parseInvoice(text: string): InvoiceParseResult {
  const clean = cleanText(text);
  const fields: SmartFields = { docType: 'invoice' } as any;

  // doc no
  const docNo = clean.match(/(?:INVOICE\s*NO|INVOICE\s*#|เลขที่ใบแจ้งหนี้)\s*[:#-]?\s*([A-Za-z0-9\-\/]+)/i);
  if (docNo) fields.docNo = docNo[1].trim();

  // date
  const date = clean.match(/(?:DATE|วันที่)\s*[:\-]?\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i);
  if (date) fields.date = date[1];

  // totals
  const subtotalRaw = clean.match(/\bSUBTOTAL\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)?.[1];

  // หา VAT/TAX เฉพาะโซนหลัง SUBTOTAL เพื่อหลบ "Tax Registered No"
  let vatRaw: string | undefined;
  const afterSub = clean.split(/\bSUBTOTAL\b/i)[1];
  if (afterSub) {
    vatRaw = afterSub.match(/\b(?:TAX|VAT)\b\s*[:\-]?\s*\$?([\d\s,.-]+%?)/i)?.[1];
  }

  const totalRaw =
    clean.match(/\bTOTAL\s+DUE\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)?.[1] ||
    clean.match(/\bTOTAL\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)?.[1];

  const subtotal = moneyField(subtotalRaw);
  const total = moneyField(totalRaw);

  // VAT/TAX
  let vat: SMoneyField | undefined;
  if (vatRaw) {
    if (/%/.test(vatRaw)) {
      vat = { raw: vatRaw, text: vatRaw };
    } else {
      let v = parseMoneyToken(vatRaw);
      if (v != null) {
        const ref = subtotal?.value ?? total?.value;
        if (ref && v > ref * 0.8) v = v / 100; // OCR ยุบจุด
      }
      vat = { raw: vatRaw, value: v, text: toThousands(v) };
    }
  }
  // fallback: คำนวณจาก total - subtotal
  if (!vat && subtotal?.value != null && total?.value != null) {
    const v = +(total.value - subtotal.value).toFixed(2);
    if (v >= 0 && v <= subtotal.value * 0.3) {
      vat = { raw: String(v), value: v, text: toThousands(v) };
    }
  }

  if (subtotal) (fields as any).subtotal = subtotal;
  if (vat) (fields as any).vat = vat;
  if (total) (fields as any).total = total;

  // line items
  const seg = sliceItemsRegion(clean);
  const lineItems = seg ? parseLineItems(seg) : [];

  return { text: clean, fields, lineItems };
}

export default parseInvoice;
