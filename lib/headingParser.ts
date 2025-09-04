import { parseHeadings, ParsedSection } from "./headingParser";

/** ===== Types ===== */
export type DocType = "receipt" | "invoice" | "business_letter" | "generic";

export type Money = { value?: number; text?: string; currency?: string };
export type LineItem = {
  description: string;
  qty?: number;
  unitPrice?: number;
  amount?: number;
};

export type SmartFields = {
  // common
  docType: DocType;
  docNo?: string;
  date?: string;
  dueDate?: string;

  // parties
  seller?: string;
  buyer?: string;
  taxIdSeller?: string;
  taxIdBuyer?: string;
  addressSeller?: string;
  addressBuyer?: string;

  // totals
  subtotal?: Money;
  vat?: Money;
  total?: Money;
  currency?: string;

  // business letter
  subject?: string; // เรื่อง / Subject
  recipient?: string; // เรียน / Dear
  sender?: string; // ลงชื่อ
};

export type SmartParseResult = {
  fields: SmartFields;
  lineItems?: LineItem[];
  sections: ParsedSection[];
};

/** ===== Helpers ===== */
const NUM = /[\d.,]+/;
const MONEY = /[A-Z]{3}|\฿|\$|€|£/i;

function toNumber(s?: string): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/[, ]/g, ""));
  return isFinite(n) ? n : undefined;
}

function findOne(re: RegExp, text: string, g = 2): string | undefined {
  const m = text.match(re);
  return m ? (m[g] || m[1])?.trim() : undefined;
}

function has(text: string, kws: string[]) {
  const t = text.toUpperCase();
  return kws.some((k) => t.includes(k.toUpperCase()));
}

/** ===== Doc classifier ===== */
function classify(text: string): DocType {
  const T = text.toUpperCase();
  if (
    has(T, [
      "TAX INVOICE",
      "INVOICE",
      "ใบกำกับภาษี",
      "ใบเสร็จรับเงิน",
      "RECEIPT",
      "CASH RECEIPT",
      "ใบรับเงิน",
    ])
  ) {
    // ถ้าเจอคำว่า INVOICE/RECEIPT ชัดๆ
    if (has(T, ["RECEIPT", "ใบเสร็จรับเงิน"])) return "receipt";
    if (has(T, ["INVOICE", "TAX INVOICE", "ใบกำกับภาษี"])) return "invoice";
    return "invoice";
  }
  if (has(T, ["SUBJECT:", "เรื่อง:", "เรียน ", "DEAR ", "SINCERELY", "ขอแสดงความนับถือ"])) {
    return "business_letter";
  }
  return "generic";
}

/** ===== Extractors ===== */
function extractReceiptOrInvoice(text: string): {
  fields: SmartFields;
  lineItems: LineItem[];
} {
  // header block
  const fields: SmartFields = {
    docType: classify(text),
  };

  // doc no.
  fields.docNo =
    findOne(/(?:เลขที่(?:เอกสาร)?|ใบเสร็จ|เลขที่ใบกำกับ|INVOICE\s*NO\.?|RECEIPT\s*NO\.?|NO\.?)\s*[:#]?\s*([A-Z0-9\-\/]+)/i, text, 1) ||
    undefined;

  // dates
  fields.date =
    findOne(
      /(?:วันที่|ออกวันที่|INVOICE\s*DATE|DATE)\s*[:\-]?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}|[0-9\-]{8,10})/i,
      text,
      1
    ) || undefined;

  fields.dueDate =
    findOne(
      /(?:ครบกำหนด|กำหนดชำระ|DUE\s*DATE)\s*[:\-]?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}|[0-9\-]{8,10})/i,
      text,
      1
    ) || undefined;

  // parties & tax id
  fields.taxIdSeller = findOne(/(?:เลขประจำตัวผู้เสียภาษี|TAX\s*ID)\s*[:\-]?\s*([0-9\-]+)/i, text, 1) || undefined;
  fields.taxIdBuyer = findOne(/(?:Tax\s*ID\s*\(Buyer\)|Tax\s*ID\s*:\s*Buyer)\s*[:\-]?\s*([0-9\-]+)/i, text, 1) || undefined;

  // Simple guesses for seller/buyer blocks
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sellerIdx = lines.findIndex((l) => has(l, ["ผู้ขาย", "ผู้ประกอบการ", "SELLER"]));
  if (sellerIdx >= 0) {
    fields.seller = lines.slice(sellerIdx, sellerIdx + 3).join(" ");
  }
  const buyerIdx = lines.findIndex((l) => has(l, ["ผู้ซื้อ", "ลูกค้า", "BUYER", "CUSTOMER"]));
  if (buyerIdx >= 0) {
    fields.buyer = lines.slice(buyerIdx, buyerIdx + 3).join(" ");
  }

  // currency (guess)
  const currency = (text.match(MONEY)?.[0] || "").toUpperCase();
  if (currency) fields.currency = currency;

  // totals
  const subtotalTxt =
    findOne(/(?:ยอดรวม(?:ก่อนภาษี)?|SUBTOTAL)\s*[:\-]?\s*([0-9,.\s]+)/i, text, 1) || undefined;
  const vatTxt = findOne(/(?:ภาษีมูลค่าเพิ่ม|VAT)\s*[:\-]?\s*([0-9,.\s]+)/i, text, 1) || undefined;
  const totalTxt =
    findOne(/(?:รวมทั้งสิ้น|ยอดชำระ|TOTAL|AMOUNT\s*DUE)\s*[:\-]?\s*([0-9,.\s]+)/i, text, 1) || undefined;

  fields.subtotal = subtotalTxt ? { text: subtotalTxt, value: toNumber(subtotalTxt), currency } : undefined;
  fields.vat = vatTxt ? { text: vatTxt, value: toNumber(vatTxt), currency } : undefined;
  fields.total = totalTxt ? { text: totalTxt, value: toNumber(totalTxt), currency } : undefined;

  // line items heuristic
  const itemLines: LineItem[] = [];
  for (const raw of lines) {
    const l = raw.replace(/\s{2,}/g, " ").trim();
    if (!/\d/.test(l)) continue; // ignore lines without digits

    // patterns:
    // 1) "desc   qty x price = amount"
    let m =
      l.match(/^(.+?)\s+(\d+(?:[\.,]\d+)?)\s*[x×]\s*(\d+(?:[\.,]\d+)?)\s*=\s*(\d+(?:[\.,]\d+)?)(?:\s*.*)?$/i) ||
      l.match(/^(.+?)\s+(\d+(?:[\.,]\d+)?)\s+(\d+(?:[\.,]\d+)?)\s+(\d+(?:[\.,]\d+)?)$/i);

    if (m) {
      const [, desc, qty, unit, amt] = m;
      itemLines.push({
        description: desc.trim(),
        qty: toNumber(qty),
        unitPrice: toNumber(unit),
        amount: toNumber(amt),
      });
      continue;
    }

    // 2) generic: last number is amount, earlier number maybe qty or unit
    const nums = l.match(/[\d.,]+/g);
    if (nums && nums.length >= 1 && /[\d.,]+\s*$/.test(l)) {
      const amount = toNumber(nums[nums.length - 1]);
      // description = remove trailing numbers
      const desc = l.replace(/[\s\d.,]+$/, "").trim();
      const maybeQty = nums.length >= 2 ? toNumber(nums[0]) : undefined;
      const maybeUnit = nums.length >= 3 ? toNumber(nums[1]) : undefined;
      // ต้องมีคำอธิบายและ amount ถึงจะนับเป็น item
      if (desc && amount !== undefined) {
        itemLines.push({
          description: desc,
          qty: maybeQty,
          unitPrice: maybeUnit,
          amount,
        });
      }
    }
  }

  return { fields, lineItems: itemLines };
}

function extractBusinessLetter(text: string): { fields: SmartFields } {
  const fields: SmartFields = { docType: "business_letter" };

  fields.subject =
    findOne(/(?:เรื่อง|Subject)\s*[:\-]\s*(.+)/i, text, 1) ||
    // subject on next line
    findOne(/(?:เรื่อง|Subject)\s*[:\-]?\s*\n(.+)/i, text, 1) ||
    undefined;

  fields.recipient =
    findOne(/^(?:เรียน|Dear)\s+(.+)$/im, text, 1) || undefined;

  fields.date =
    findOne(/^(?:วันที่|Date)\s*[:\-]?\s*(.+)$/im, text, 1) ||
    findOne(/(?:\bDate\b)\s*[:\-]?\s*(.+)$/i, text, 1) ||
    undefined;

  // crude sender guess from closing
  fields.sender =
    findOne(/(?:ขอแสดงความนับถือ|Sincerely|Best regards)[\s,\n]+(.+)/i, text, 1) || undefined;

  return { fields };
}

/** ===== Public: smartParse ===== */
export function smartParse(
  raw: string,
  opts?: { lang?: "auto" | "tha" | "eng" }
): SmartParseResult {
  const text = raw ?? "";
  const docType = classify(text);

  let fields: SmartFields = { docType };
  let lineItems: LineItem[] | undefined;

  if (docType === "receipt" || docType === "invoice") {
    const ex = extractReceiptOrInvoice(text);
    fields = { ...fields, ...ex.fields };
    lineItems = ex.lineItems;
  } else if (docType === "business_letter") {
    const ex = extractBusinessLetter(text);
    fields = { ...fields, ...ex.fields };
  }

  // sections จากพาร์เซอร์หัวข้อเดิม (เผื่อโชว์สรุป)
  const sections = parseHeadings(text, [
    // เสริมหัวข้อที่พบบ่อยในงานธุรกิจ/การเงิน
    "INVOICE",
    "TAX INVOICE",
    "RECEIPT",
    "BILLING",
    "PAYMENT",
    "VENDOR",
    "CUSTOMER",
    "TERMS",
    "TOTAL",
    "SUBTOTAL",
    "VAT",
    "EDUCATION",
    "EXPERIENCE",
    "ADDITIONAL INFORMATION",
    "SKILLS",
    "SUMMARY",
    "CONTACT",
    "PROJECTS",
    "LANGUAGES",
    "CERTIFICATIONS",
    "AWARDS",
    "PUBLICATIONS",

    // ไทย
    "ใบกำกับภาษี",
    "ใบเสร็จรับเงิน",
    "ผู้ขาย",
    "ผู้ซื้อ",
    "เงื่อนไข",
    "ยอดรวม",
    "ภาษีมูลค่าเพิ่ม",
    "รวมทั้งสิ้น",
    "การศึกษา",
    "ทักษะ",
    "ภาษา",
    "โครงการ",
    "ข้อมูลเพิ่มเติม",
    "สรุป",
  ]);

  return { fields, lineItems, sections };
}
