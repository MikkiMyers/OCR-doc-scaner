// lib/headingParser.ts
// Stronger heading extractor + Thai official memo parser (บันทึกข้อความ)
// Backward-compatible: functions accept optional 2nd arg (_opts?: unknown).

export interface ParsedSection {
  heading: string;
  content: string[];
}

const THAI_KEYS = [
  'บันทึกข้อความ','ส่วนราชการ','ที่','วันที่','เรื่อง','เรียน','สิ่งที่ส่งมาด้วย',
  'สรุป','วัตถุประสงค์','สถานที่','กำหนดการ','ผู้รับผิดชอบ','ลงชื่อ','ตำแหน่ง','หมายเหตุ'
];

const RE_COLON_END = /[:：]$/;
const RE_ALLCAPS_LATIN = /^[A-Z0-9 ().\/\-]{4,}$/;
const RE_BULLET = /^[-•–—●▪︎■□] ?/;
const RE_ENUM = /^((ข้อ|หัวข้อ)\s*\d+|[0-9]+[.)]|[๑-๙]+[.)]|\(\d+\)|\d+\.)\s*/;
const RE_SOFT_SPLIT = /([A-Za-zก-ฮ0-9])[‐-]\s*$/;

function norm(s: string): string {
  return (s||'')
    .replace(/\u00A0/g,' ')
    .replace(/[ \t]+/g,' ')
    .replace(/\s+$/,'')
    .replace(/^\s+/,'')
}

function looksLikeHeading(line: string): boolean {
  const l = line.trim();
  if (!l) return false;
  if (RE_COLON_END.test(l)) return true;
  if (l.length <= 20 && THAI_KEYS.some(k => l.startsWith(k))) return true;
  if (RE_ALLCAPS_LATIN.test(l)) return true;
  if (l.length <= 24 && !/[.!?…]$/.test(l)) return true;
  return false;
}

function shouldJoin(prev: string, cur: string): boolean {
  if (!prev) return false;
  const p = prev.trim(); const c = cur.trim();
  if (!p || !c) return false;
  if (/[,:;–—-]$/.test(p)) return true;
  if (/^[a-zก-ฮ]/.test(c) && /[a-zก-ฮ0-9]$/.test(p)) return true;
  if (RE_SOFT_SPLIT.test(p)) return true;
  return false;
}

// 2nd argument kept for backward-compat; currently unused.
export function parseHeadings(text: string, _opts?: unknown): ParsedSection[] {
  const lines = (text||'').split(/\r?\n/).map(norm);
  const out: ParsedSection[] = [];
  let cur: ParsedSection | null = null;

  for (const raw of lines) {
    if (!raw) continue;
    const l = raw.replace(RE_BULLET,'').replace(RE_ENUM,'');
    if (looksLikeHeading(l)) {
      if (cur) out.push(cur);
      cur = { heading: l.replace(RE_COLON_END,''), content: [] };
    } else {
      if (!cur) cur = { heading: 'เนื้อหา', content: [] };
      if (cur.content.length) {
        const last = cur.content[cur.content.length-1];
        if (shouldJoin(last, raw)) cur.content[cur.content.length-1] = (last + ' ' + raw).replace(/\s{2,}/g,' ');
        else cur.content.push(raw);
      } else {
        cur.content.push(raw);
      }
    }
  }
  if (cur) out.push(cur);
  return out.map(s => ({ heading: s.heading.trim(), content: s.content.map(c => c.trim()).filter(Boolean)}))
            .filter(s => s.heading || s.content.length);
}

// ---------- Thai official memo (บันทึกข้อความ) ----------

export interface ThaiMemoFields {
  agency?: string;  // ส่วนราชการ
  refNo?: string;   // ที่
  date?: string;    // วันที่
  title?: string;   // เรื่อง
  to?: string;      // เรียน
  signer?: string;  // ลงชื่อ
  position?: string;// ตำแหน่ง
}

// 2nd argument kept for backward-compat; currently unused.
export function detectThaiMemo(text: string, _opts?: unknown): boolean {
  const t = (text||'');
  const must = ['บันทึกข้อความ','ส่วนราชการ','เรื่อง'];
  return must.every(k => t.includes(k));
}

// 2nd argument kept for backward-compat; currently unused.
export function parseThaiMemo(text: string, _opts?: unknown): { sections: ParsedSection[], fields: ThaiMemoFields } {
  const lines = (text||'').replace(/\r/g,'').split('\n').map(norm).filter(l=>l!=='');
  const fields: ThaiMemoFields = {};
  const sections: ParsedSection[] = [];

  function grab(key: string): string | null {
    const i = lines.findIndex(l => l.startsWith(key));
    if (i === -1) return null;
    return lines[i].replace(new RegExp('^' + key + '\\s*[:： ]?'), '').trim() || null;
  }

  fields.agency = grab('ส่วนราชการ') || undefined;
  fields.refNo  = grab('ที่') || undefined;
  fields.date   = grab('วันที่') || undefined;
  fields.title  = grab('เรื่อง') || undefined;

  // "เรียน" block
  const learnIdx = lines.findIndex(l => l.startsWith('เรียน'));
  if (learnIdx !== -1) {
    const first = lines[learnIdx].replace(/^เรียน\s*[:： ]?/, '').trim();
    const arr: string[] = first ? [first] : [];
    for (let i=learnIdx+1;i<lines.length;i++) {
      const ln = lines[i];
      if (/^(สิ่งที่ส่งมาด้วย|ลงชื่อ|หมายเหตุ)\b/.test(ln)) break;
      arr.push(ln);
    }
    sections.push({ heading: 'เรียน', content: arr.filter(Boolean) });
    if (first) fields.to = first;
  }

  // Attachments
  const attachIdx = lines.findIndex(l => l.startsWith('สิ่งที่ส่งมาด้วย'));
  if (attachIdx !== -1) {
    const list: string[] = [];
    for (let i=attachIdx;i<lines.length;i++) {
      const ln = lines[i];
      if (i===attachIdx) {
        const first = ln.replace(/^สิ่งที่ส่งมาด้วย\s*[:： ]?/, '').trim();
        if (first) list.push(first);
        continue;
      }
      if (/^(เรียน|ลงชื่อ|หมายเหตุ)\b/.test(ln)) break;
      list.push(ln.replace(RE_BULLET,'').replace(RE_ENUM,''));
    }
    sections.push({ heading: 'สิ่งที่ส่งมาด้วย', content: list.filter(Boolean) });
  }

  // Body (between attachments/learn and signature)
  const signIdx = lines.findIndex(l => l.startsWith('ลงชื่อ'));
  const body: string[] = [];
  const bodyStart = Math.max(learnIdx + 1, attachIdx !== -1 ? attachIdx + 1 : 0);
  for (let i = bodyStart; (learnIdx !== -1) && i < (signIdx === -1 ? lines.length : signIdx); i++) {
    const ln = lines[i];
    if (/^(ส่วนราชการ|ที่|วันที่|เรื่อง|เรียน|สิ่งที่ส่งมาด้วย)\b/.test(ln)) continue;
    body.push(ln);
  }
  if (body.length) sections.push({ heading: 'รายละเอียด', content: body });

  // Signature block (avoid fragile regex literals)
  if (signIdx !== -1) {
    const sig = lines.slice(signIdx, Math.min(lines.length, signIdx + 6));
    const sigText = sig.join(' ');
    const nameRe = new RegExp('ลงชื่อ\s*([^\(\n]+?)(?:\s*\(|\s*ตำแหน่ง|$)');
    const posRe  = new RegExp('ตำแหน่ง[:： ]?(.+?)$');
    const mName = sigText.match(nameRe);
    const mPos  = sigText.match(posRe);
    if (mName) fields.signer = mName[1].trim();
    if (mPos)  fields.position = mPos[1].trim();
    sections.push({ heading: 'ลงชื่อ', content: sig.map(s => s.replace(/^ลงชื่อ[:： ]?/, '').trim()).filter(Boolean) });
  }

  // Header section (compact)
  const head: string[] = [];
  if (fields.agency) head.push(`ส่วนราชการ: ${fields.agency}`);
  if (fields.refNo)  head.push(`ที่: ${fields.refNo}`);
  if (fields.date)   head.push(`วันที่: ${fields.date}`);
  if (fields.title)  head.push(`เรื่อง: ${fields.title}`);
  if (head.length) sections.unshift({ heading: 'ส่วนหัวเอกสาร', content: head });

  return { sections, fields };
}
