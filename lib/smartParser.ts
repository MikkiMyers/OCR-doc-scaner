// lib/smartParser.ts
// Heuristic Smart Parser สำหรับเอกสารทั่วไป/ธุรกิจ (ไทย/อังกฤษ)
// - ตรวจชนิดเอกสาร (invoice/receipt/letter/resume/generic)
// - ดึงฟิลด์สำคัญ (เลขที่เอกสาร, วันที่, ผู้ขาย/ผู้ซื้อ, ยอดรวม ฯลฯ)
// - พยายามแตกตารางรายการสินค้า/บริการแบบง่าย
// - แยกหัวข้อ (sections) จาก heading ที่พบบ่อย

export type MoneyField = {
  raw?: string;     // ข้อความดิบที่เจอ
  value?: number;   // แปลงเป็นตัวเลข (ถ้าทำได้)
  text?: string;    // รูปแบบที่สวยขึ้น เช่น ใส่คอมม่า
};

export type SmartFields = {
  docType:
    | 'invoice' | 'tax_invoice' | 'receipt' | 'quotation'
    | 'po' | 'credit_note' | 'debit_note' | 'bill'
    | 'letter' | 'resume' | 'generic';
  docNo?: string;
  date?: string;
  dueDate?: string;
  buyer?: string;
  seller?: string;
  subject?: string;     // สำหรับจดหมาย/บันทึกข้อความ
  recipient?: string;   // Dear/เรียน
  sender?: string;      // ผู้ส่ง/ลงชื่อ
  subtotal?: MoneyField;
  vat?: MoneyField;
  total?: MoneyField;
};

export type LineItem = {
  description: string;
  qty?: string | number;
  unitPrice?: string | number;
  amount?: string | number;
};

export type Section = { heading: string; content: string[] };

export type SmartParseOptions = {
  lang?: 'auto' | 'tha' | 'eng';
};

export type SmartParseResult = {
  fields: SmartFields;
  sections: Section[];
  lineItems?: LineItem[];
};

/* -------------------- helpers -------------------- */

const clean = (s: string) =>
  (s || '')
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const toNumber = (raw?: string): number | undefined => {
  if (!raw) return undefined;
  const s = raw.replace(/[, ]+/g, '').replace(/[฿$€£]|บาท|THB|USD|EUR|GBP/gi, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : undefined;
};

const formatMoney = (n?: number): string | undefined =>
  typeof n === 'number' && isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : undefined;

const linesOf = (text: string) =>
  clean(text).split(/\r?\n/).map(l => l.trim()).filter(l => l.length || l === '');

/* -------------------- doc type detection -------------------- */

const has = (text: string, words: string[]) =>
  words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(text));

function detectDocType(text: string): SmartFields['docType'] {
  const t = text.toUpperCase();

  // Thai keywords
  const th = (kw: string) => text.includes(kw);

  if (has(t, ['TAX INVOICE']) || th('ใบกำกับภาษี') || th('ใบกํากับภาษี')) return 'tax_invoice';
  if (has(t, ['INVOICE']) || th('ใบแจ้งหนี้')) return 'invoice';
  if (has(t, ['RECEIPT']) || th('ใบเสร็จรับเงิน') || th('ใบรับเงิน')) return 'receipt';
  if (has(t, ['QUOTATION']) || th('ใบเสนอราคา')) return 'quotation';
  if (has(t, ['PURCHASE ORDER', 'P/O', 'PO']) || th('ใบสั่งซื้อ')) return 'po';
  if (has(t, ['CREDIT NOTE']) || th('ใบลดหนี้')) return 'credit_note';
  if (has(t, ['DEBIT NOTE'])) return 'debit_note';
  if (has(t, ['BILL']) || th('บิล')) return 'bill';

  // Letter / Resume heuristics
  if (has(t, ['DEAR', 'SUBJECT']) || /(^|\n)\s*(เรื่อง|เรียน)\b/.test(text)) return 'letter';
  if (has(t, ['EDUCATION', 'EXPERIENCE', 'SKILLS', 'ADDITIONAL INFORMATION', 'SUMMARY'])) return 'resume';

  return 'generic';
}

/* -------------------- field extraction -------------------- */

function extractFieldWithLabel(text: string, labels: RegExp[], maxLineSpan = 2): string | undefined {
  const ls = linesOf(text);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    for (const re of labels) {
      const m = line.match(re);
      if (m) {
        // เอาหลังเครื่องหมาย หรือบรรทัดถัดไป
        const after = line.slice(m.index! + m[0].length).trim().replace(/^[:：\- ]+/, '').trim();
        if (after) return after;
        // หรือดูบรรทัดถัดๆ ไป
        for (let j = 1; j <= maxLineSpan && i + j < ls.length; j++) {
          const next = ls[i + j].trim();
          if (next) return next;
        }
      }
    }
  }
  return undefined;
}

function extractDocNo(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(เลขที่เอกสาร|เลขที่บิล|เลขที่ใบกำกับ|เลขที่|เลขที)\s*[:：\- ]?/i,
    /(Document\s*No\.?|Doc\.?\s*No\.?|Invoice\s*No\.?|No\.?)\s*[:：\- ]?/i,
  ]);
}

function extractDate(text: string): string | undefined {
  // หา date แบบระบุ label
  const raw =
    extractFieldWithLabel(text, [
      /(วันที่|ออกวันที่|ลงวันที่)\s*[:：\- ]?/,
      /(Issue\s*Date|Date)\s*[:：\- ]?/i,
    ]) ||
    // หรือจับรูปแบบวันที่ทั่วๆ ไป
    (text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/)?.[1]) ||
    (text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1]);
  return raw?.trim();
}

function extractDueDate(text: string): string | undefined {
  return (
    extractFieldWithLabel(text, [
      /(กำหนดชำระ|ครบกำหนด|วันครบกำหนด)\s*[:：\- ]?/,
      /(Due\s*Date|Payment\s*Due)\s*[:：\- ]?/i,
    ]) || undefined
  );
}

function extractBuyer(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(ผู้ซื้อ|ลูกค้า|บริษัทผู้ซื้อ)\s*[:：\- ]?/,
    /(Customer|Bill\s*To|Ship\s*To)\s*[:：\- ]?/i,
  ]);
}

function extractSeller(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(ผู้ขาย|ผู้ให้บริการ|บริษัทผู้ขาย|บริษัท)\s*[:：\- ]?/,
    /(Seller|Supplier|From)\s*[:：\- ]?/i,
  ]);
}

function extractSubject(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(เรื่อง)\s*[:：\- ]?/,
    /(Subject)\s*[:：\- ]?/i,
  ]);
}

function extractRecipient(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(เรียน)\s*[:：\- ]?/,
    /(Dear)\s*[:：\- ]?/i,
  ]);
}

function extractSender(text: string): string | undefined {
  return extractFieldWithLabel(text, [
    /(ผู้ส่ง|ลงชื่อ)\s*[:：\- ]?/,
    /(Sincerely|Best\s+regards|Regards)/i,
  ]);
}

function pickMoneyAround(text: string, keys: RegExp[]): MoneyField | undefined {
  const ls = linesOf(text);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (keys.some(re => re.test(line))) {
      // หาเลขในบรรทัดนั้นก่อน
      const cand = line.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g);
      if (cand?.length) {
        const raw = cand[cand.length - 1];
        const value = toNumber(raw);
        return { raw, value, text: formatMoney(value) };
      }
      // ไม่เจอ ลองบรรทัดถัดไป
      for (let j = 1; j <= 2 && i + j < ls.length; j++) {
        const next = ls[i + j];
        const c2 = next.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g);
        if (c2?.length) {
          const raw = c2[c2.length - 1];
          const value = toNumber(raw);
          return { raw, value, text: formatMoney(value) };
        }
      }
    }
  }
  return undefined;
}

function extractTotals(text: string) {
  const subtotal = pickMoneyAround(text, [
    /(ยอดรวมก่อนภาษี|รวมก่อนภาษี|Subtotal)/i,
  ]);
  const vat = pickMoneyAround(text, [
    /(ภาษีมูลค่าเพิ่ม|VAT|ภาษี|Tax)/i,
  ]);
  const total = pickMoneyAround(text, [
    /(รวมทั้งสิ้น|ยอดรวมสุทธิ|Grand\s*Total|Total)/i,
  ]) || pickMoneyAround(text, [/^Total\b/i]); // fallback

  return { subtotal, vat, total };
}

/* -------------------- line items extraction (best-effort) -------------------- */

function extractLineItems(text: string): LineItem[] {
  const ls = linesOf(text);
  const items: LineItem[] = [];

  // heuristic: บรรทัดที่มีเลข "จำนวน" กับ "ราคา" และ "รวมเงิน" อยู่ท้าย
  const moneyRe = /[0-9]+(?:,\d{3})*(?:\.\d+)?/;
  const qtyRe = /(?:^|\s)(\d+(?:\.\d{1,3})?)(?:\s*(?:pcs|ชิ้น|หน่วย|qty|จำนวน))?/i;

  for (const line of ls) {
    // ตัดหัวตารางทั่วไป
    if (/^(รายการ|description)\b/i.test(line)) continue;

    // เคส 3 ช่อง: desc ... qty ... unit ... amount
    let m = line.match(/^(.+?)\s{2,}(\d+(?:\.\d+)?)\s{1,}([0-9,]+(?:\.\d{1,2})?)\s{1,}([0-9,]+(?:\.\d{1,2})?)$/i);
    if (m) {
      const [, desc, q, up, amt] = m;
      items.push({
        description: desc.trim(),
        qty: q,
        unitPrice: up,
        amount: amt,
      });
      continue;
    }

    // เคส 2 ช่อง: desc ... amount (อย่างน้อยให้ได้ยอด)
    m = line.match(/^(.+?)\s{2,}([0-9,]+(?:\.\d{1,2})?)$/);
    if (m) {
      const [, desc, amt] = m;
      items.push({ description: desc.trim(), amount: amt });
      continue;
    }

    // เคส bullet ที่ลงท้ายด้วยตัวเลข
    m = line.match(/^[\-\u2022●▪■]?\s*(.+?)\s+([0-9,]+(?:\.\d{1,2})?)$/);
    if (m) {
      const [, desc, amt] = m;
      items.push({ description: desc.trim(), amount: amt });
      continue;
    }

    // เคสที่เจอ qty x price = amount แบบง่าย ๆ
    m = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*[x×*]\s*([0-9,]+(?:\.\d{1,2})?)\s*=\s*([0-9,]+(?:\.\d{1,2})?)$/i);
    if (m) {
      const [, desc, q, up, amt] = m;
      items.push({ description: desc.trim(), qty: q, unitPrice: up, amount: amt });
      continue;
    }

    // กรณีไม่มี amount แต่มี qty + unit ราคาก็เก็บบางส่วน
    const q2 = line.match(qtyRe);
    const prices = line.match(new RegExp(moneyRe, 'g'));
    if (q2 && prices?.length) {
      items.push({
        description: line.replace(qtyRe, '').replace(new RegExp(moneyRe, 'g'), '').trim(),
        qty: q2[1],
        unitPrice: prices[0],
        amount: prices[1],
      });
    }
  }

  // กรองรายการที่สั้น/สุ่มเกินไป
  return items.filter(it => (it.description?.length ?? 0) > 1);
}

/* -------------------- section extraction -------------------- */

const COMMON_HEADINGS_EN = [
  'SUMMARY', 'OBJECTIVE', 'PROFILE', 'EDUCATION', 'EXPERIENCE', 'WORK EXPERIENCE', 'PROJECTS',
  'SKILLS', 'TECHNICAL SKILLS', 'CERTIFICATIONS', 'AWARDS', 'ADDITIONAL INFORMATION',
  'CONTACT', 'REFERENCES', 'LANGUAGES',
  'INVOICE', 'TAX INVOICE', 'RECEIPT', 'QUOTATION', 'PURCHASE ORDER',
];

const COMMON_HEADINGS_TH = [
  'สรุป', 'วัตถุประสงค์', 'โปรไฟล์', 'ประวัติการศึกษา', 'ประสบการณ์', 'ประสบการณ์ทำงาน',
  'โครงการ', 'ทักษะ', 'ทักษะทางเทคนิค', 'ประกาศนียบัตร', 'รางวัล', 'ข้อมูลเพิ่มเติม',
  'ติดต่อ', 'อ้างอิง', 'ภาษา',
  'ใบแจ้งหนี้', 'ใบกำกับภาษี', 'ใบเสร็จรับเงิน', 'ใบเสนอราคา', 'ใบสั่งซื้อ', 'รายการสินค้า',
];

function isHeadingLine(line: string): boolean {
  if (!line) return false;
  // ขึ้นต้นด้วยหัวข้อชัดเจน หรือขึ้นต้นด้วยคำ + ':' เช่น EDUCATION:
  if (/[A-Za-zก-๙].{0,80}:$/.test(line)) return true;

  const upper = line === line.toUpperCase();
  const hasLetters = /[A-Za-z]/.test(line);
  const notTooLong = line.length <= 80;

  if (upper && hasLetters && notTooLong) return true;

  // ตรงกับรายการหัวข้อที่พบบ่อย
  const plain = line.replace(/\s+/g, ' ').trim();
  if (COMMON_HEADINGS_EN.includes(plain.toUpperCase())) return true;
  if (COMMON_HEADINGS_TH.includes(plain)) return true;

  // เริ่มด้วยตัวเลข/หัวข้อเช่น "1) " หรือ "ข้อ 1"
  if (/^\d+\)\s+/.test(line)) return true;
  if (/^ข้อ\s*\d+/.test(line)) return true;

  return false;
}

function splitSections(text: string): Section[] {
  const ls = linesOf(text);
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const l of ls) {
    const isHead = isHeadingLine(l);
    if (isHead) {
      current = { heading: l.replace(/:$/, ''), content: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { heading: 'เนื้อหา', content: [] };
      sections.push(current);
    }
    // แตก bullet ให้เป็นบรรทัดย่อย
    const bullets = l.split(/\s*[\u2022•\-▪■●]\s+/).filter(Boolean);
    if (bullets.length > 1) current.content.push(...bullets.map(b => b.trim()));
    else if (l.trim()) current.content.push(l.trim());
  }

  // รวมบรรทัดเนื้อหาติดกันที่ไม่ใช่ bullet เป็นหนึ่งย่อหน้า
  const merged = sections.map(sec => {
    const out: string[] = [];
    let buf: string[] = [];
    for (const c of sec.content) {
      if (/^[-•▪■●]/.test(c)) { // bullet จริงๆ
        if (buf.length) { out.push(buf.join(' ')); buf = []; }
        out.push(c.replace(/^[-•▪■●]\s*/, ''));
      } else if (c.length < 2) {
        if (buf.length) { out.push(buf.join(' ')); buf = []; }
      } else {
        buf.push(c);
      }
    }
    if (buf.length) out.push(buf.join(' '));
    return { heading: sec.heading, content: out };
  });

  return merged;
}

/* -------------------- main -------------------- */

export function smartParse(text: string, opts: SmartParseOptions = {}): SmartParseResult {
  const lang = opts.lang ?? 'auto';
  const t = clean(text);

  const docType = detectDocType(t);

  // fields
  const fields: SmartFields = { docType };

  fields.docNo = extractDocNo(t);
  fields.date = extractDate(t);
  fields.dueDate = extractDueDate(t);

  // only for business docs
  if (docType !== 'resume' && docType !== 'letter') {
    fields.buyer = extractBuyer(t);
    fields.seller = extractSeller(t);
    const totals = extractTotals(t);
    fields.subtotal = totals.subtotal;
    fields.vat = totals.vat;
    fields.total = totals.total;
  } else {
    // letter-like
    fields.subject = extractSubject(t);
    fields.recipient = extractRecipient(t);
    fields.sender = extractSender(t);
  }

  // line items (best effort) for business docs
  const lineItems = ((): LineItem[] => {
    if (['invoice', 'tax_invoice', 'receipt', 'quotation', 'po', 'bill', 'credit_note', 'debit_note'].includes(docType)) {
      return extractLineItems(t);
    }
    return [];
  })();

  // sections
  const sections = splitSections(t);

  return {
    fields,
    sections,
    lineItems: lineItems.length ? lineItems : undefined,
  };
}
