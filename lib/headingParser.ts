/** ===== Types ===== */
export interface ParsedSection {
  heading: string;
  content: string[];
}

/** ===== Helpers ===== */
const isMostlyUpper = (s: string) => {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  const uppers = letters.replace(/[^A-Z]/g, '').length;
  return uppers / letters.length >= 0.75;
};

const normalize = (s: string) =>
  (s || '')
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/** ตรวจว่าเป็นหัวข้อไหม (TH/EN) */
const isHeadingLine = (line: string): boolean => {
  const l = line.trim();

  if (!l) return false;

  // รูปแบบทั่วไป: คำขึ้นต้น + ":" หรือ ลงท้าย ":" / "--"
  if (/^.{2,40}[:：]\s*$/.test(l)) return true;

  // All-caps (อังกฤษ) ยาวพอสมควร
  if (isMostlyUpper(l)) return true;

  // คีย์เวิร์ดหัวข้อไทย/อังกฤษยอดฮิต
  if (
    /^(เนื้อหา|หัวข้อ|สรุป|หมายเหตุ|รายละเอียด|ข้อมูล|ภาคผนวก|อ้างอิง)\b/.test(l) ||
    /^(SUMMARY|ABSTRACT|INTRODUCTION|EDUCATION|EXPERIENCE|PROJECTS?|SKILLS|CERTIFICATIONS?|ADDITIONAL INFORMATION|INVOICE|RECEIPT|BILL TO|SHIP TO|ISSUED TO|PAY TO|TOTAL|SUBTOTAL)\b/i.test(
      l
    )
  ) {
    return true;
  }

  // “INVOICE NO ... DATE ...” แบบยาวในบรรทัดเดียว
  if (/^(INVOICE|RECEIPT)\b.+(DATE|DUE DATE)\b/i.test(l)) return true;

  return false;
};

/** บูลเล็ต/รายการ */
const isBullet = (line: string): boolean =>
  /^(\-|\*|•|▪|■|●|○)\s+/.test(line) || // • item
  /^\(?\d{1,3}\)?[.)]\s+/.test(line) || // 1) / 1. / (1)
  /^[A-Za-z][.)]\s+/.test(line); // A) / a)

/** ===== Main parser ===== */
export function parseHeadings(rawText: string): ParsedSection[] {
  const text = normalize(rawText);
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((l) => normalize(l));
  const sections: ParsedSection[] = [];

  let current: ParsedSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;

    if (isHeadingLine(l)) {
      // เปิดหัวข้อใหม่
      current && sections.push(current);
      current = { heading: l.replace(/\s*[:：]\s*$/, ''), content: [] };
      continue;
    }

    // ถ้ายังไม่มีหัวข้อ ให้ยัดไปเป็น "เนื้อหา"
    if (!current) {
      current = { heading: 'เนื้อหา', content: [] };
    }

    // จัดการบูลเล็ต/ข้อความย่อย
    if (isBullet(l)) {
      current.content.push(l.replace(/^\(?\d{1,3}\)?[.)]\s+/, '').replace(/^(\-|\*|•|▪|■|●|○)\s+/, ''));
    } else {
      // รวมบรรทัดให้เป็นย่อหน้า
      const last = current.content[current.content.length - 1];
      if (!last || /[.:;!?。！？]$/.test(last)) {
        current.content.push(l);
      } else {
        current.content[current.content.length - 1] = `${last} ${l}`;
      }
    }
  }

  current && sections.push(current);

  // เก็บกวาด: ตัดช่องว่าง, ตัด content ที่ซ้ำว่าง
  return sections.map((s) => ({
    heading: s.heading.trim(),
    content: s.content.map((c) => c.trim()).filter(Boolean),
  }));
}