// lib/smartParser.ts
export type MoneyField = { raw?: string; value?: number; text?: string };

export interface LineItem {
  description: string;
  qty?: string;
  unitPrice?: string;
  amount?: string;
}

export interface SmartFields {
  docType: 'invoice' | 'receipt' | 'resume' | 'generic';
  subject?: string;
  sender?: string;
  recipient?: string;

  seller?: string;
  buyer?: string;
  docNo?: string;
  date?: string;
  dueDate?: string;
  subtotal?: MoneyField;
  vat?: MoneyField;
  total?: MoneyField;

  name?: string;
  title?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface SmartParseOptions {
  lang?: 'auto' | 'tha' | 'eng';
}
export interface SmartParseResult {
  sections: Array<{ heading: string; content: string[] }>;
  fields: SmartFields;
  lineItems?: LineItem[];
}

const TH = '\u0E00-\u0E7F';
const reEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const rePhone = /(?:\+?\d[\d\s\-]{7,}\d)/;
const reYearRange = /\b((?:19|20)\d{2})\s*(?:–|—|-|ถึง|to)\s*(ปัจจุบัน|((?:19|20)\d{2}))\b/i;
const reSingleYear = /\b(?:19|20)\d{2}\b/;

function normalizeBullets(s: string) {
  return (s || '')
    .replace(/[๑©⦿•·●▪■◦◘○●]/g, '•')
    .replace(/[–—]/g, '-')
    .replace(/\t+/g, ' ')
    .replace(/[ \u00A0]{2,}/g, ' ');
}
function toLines(s: string) {
  return normalizeBullets(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''));
}
function isBullet(l: string) {
  return /^([•·●▪■\-–*]|\d+\)|\(\d+\))\s+/.test(l);
}

// fuzzy heading match: ทำให้ “ประสบการณ์ทำงาน” ที่เพี้ยนเล็กน้อยยังติด
const fuzzyHeads = [
  { key: 'experience', labels: ['ประสบการณ์การทำงาน', 'ประสบการณ์ทำงาน', 'ประสบการณ์', 'Experience'] },
  { key: 'contact',    labels: ['ติดต่อ', 'Contact', 'ข้อมูลติดต่อ'] },
  { key: 'about',      labels: ['เกี่ยวกับฉัน', 'เกี่ยวกับ', 'โปรไฟล์', 'Profile', 'Summary'] },
  { key: 'education',  labels: ['ประวัติการศึกษา', 'การศึกษา', 'Education'] },
  { key: 'skills',     labels: ['ทักษะ', 'Skills', 'Skill'] },
  { key: 'languages',  labels: ['ทักษะทางภาษา', 'ภาษา', 'Languages'] },
  { key: 'awards',     labels: ['รางวัลที่ได้รับ', 'รางวัล', 'Awards'] },
  { key: 'projects',   labels: ['ผลงาน', 'Projects', 'Project', 'Portfolio'] },
] as const;

type HeadKey = (typeof fuzzyHeads)[number]['key'];
const headOrder: HeadKey[] = ['about','contact','experience','education','skills','languages','awards','projects'];

function normTH(s: string) {
  // เก็บเฉพาะตัวอักษร/ตัวเลขแบบหยาบ เพื่อตรวจ heading แบบ includes
  return (s || '').toLowerCase()
    .replace(/[^\w\u0E00-\u0E7F]+/g, '')
    .replace(/ํ/g, ''); // ไว้เผื่อสระลอย
}
function matchHead(l: string): HeadKey | null {
  const nl = normTH(l);
  for (const h of fuzzyHeads) {
    for (const lb of h.labels) {
      if (nl.includes(normTH(lb))) return h.key as HeadKey;
    }
  }
  return null;
}

function guessNameTitle(lines: string[]) {
  const top = lines.slice(0, 8);
  let name: string | undefined;
  let title: string | undefined;
  const reThaiName = new RegExp(`^[${TH}A-Za-z][^0-9@/|]{1,40}\\s+[${TH}A-Za-z][^0-9@/|]{1,40}$`);
  for (const l of top) {
    if (!name && reThaiName.test(l)) name = l;
    if (!title && /(MANAGER|ENGINEER|DESIGNER|DEVELOPER|MARKETING|SALES|EXECUTIVE|ANALYST)/i.test(l))
      title = l;
  }
  return { name, title };
}

function extractContacts(lines: string[]) {
  const contact: string[] = [];
  const remain: string[] = [];
  let contactMode = false;

  for (let l of lines) {
    if (/^(ติดต่อ|contact)\b/i.test(l)) { contactMode = true; continue; }
    const email = l.match(reEmail);
    const phone = l.match(rePhone);

    if (contactMode || email || phone) {
      if (phone) contact.push(phone[0]);
      if (email) contact.push(email[0]);
      const rest = l.replace(reEmail, '').replace(rePhone, '').trim();
      if (rest) {
        if (/(ซอย|ถ\.|ถนน|เขต|แขวง|จังหวัด|อำเภอ|เลขที่|St\.?|Street|Road|Rd\.?|City|Zip)/i.test(rest))
          contact.push(rest);
        else remain.push(rest);
      }
      continue;
    }
    remain.push(l);
  }
  return { contact: contact.filter(Boolean), remain };
}

function groupExperience(lines: string[]) {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) { out.push(cur.join(' ')); cur = []; } };

  for (const l of lines) {
    if (reYearRange.test(l) || (/^\d{4}\b/.test(l) && reSingleYear.test(l))) {
      flush(); cur.push(l); continue;
    }
    if (isBullet(l)) { cur.push(l); continue; }
    if (!l.trim()) flush();
    else {
      if (!cur.length) cur.push(l);
      else cur.push(l);
    }
  }
  flush();
  return out;
}

function makeMap() {
  return { about:[], contact:[], experience:[], education:[], skills:[], languages:[], awards:[], projects:[] } as Record<HeadKey, string[]>;
}

export function smartParse(text: string, _opts?: SmartParseOptions): SmartParseResult {
  const lines0 = toLines(text);

  const { name, title } = guessNameTitle(lines0);
  const { contact, remain } = extractContacts(lines0);

  const map = makeMap();
  let cur: HeadKey | null = null;

  const push = (k: HeadKey, line: string) => {
    if (!line) return;
    if (line.includes(' • ')) {
      line.split(/\s+•\s+/).map((x)=>x.trim()).filter(Boolean)
        .forEach((x,i)=>map[k].push(i===0 && !isBullet(x) ? x : `• ${x}`));
    } else map[k].push(line);
  };

  for (const raw of remain) {
    const l = raw.trim();
    if (!l) continue;

    const hk = matchHead(l);
    if (hk) { cur = hk; continue; }

    if (reYearRange.test(l) || (/^\d{4}\b/.test(l) && reSingleYear.test(l))) {
      cur = 'experience'; push('experience', l); continue;
    }

    if (cur) push(cur, l);
    else {
      if (isBullet(l)) {
        if (l.replace(/^([•·●▪■\-–*]|\d+\)|\(\d+\))\s+/, '').length < 40) push('skills', l);
        else push('experience', l);
      } else {
        if (l.length > 30 && map.about.length < 6) push('about', l);
        else push('experience', l);
      }
    }
  }

  map.contact.push(...contact);

  if (map.experience.length) map.experience = groupExperience(map.experience);
  if (map.skills.length) {
    map.skills = map.skills.flatMap((l) =>
      l.includes('•') ? l.split(/\s*•\s*/).filter(Boolean).map((x)=>`• ${x}`) : [l]
    );
  }
  if (!map.languages.length) {
    const cands = Object.values(map).flat().filter((l)=>/(ภาษา(ไทย|อังกฤษ|จีน|ญี่ปุ่น)|Languages?)/i.test(l));
    if (cands.length) map.languages = cands;
  }

  const sections = headOrder
    .map((k) => ({
      heading:
        k==='experience'?'ประสบการณ์การทำงาน':
        k==='contact'?'ติดต่อ':
        k==='about'?'เกี่ยวกับฉัน':
        k==='education'?'ประวัติการศึกษา':
        k==='skills'?'ทักษะ':
        k==='languages'?'ทักษะทางภาษา':
        k==='awards'?'รางวัลที่ได้รับ':'ผลงาน',
      content: map[k].filter(Boolean),
    }))
    .filter((s)=>s.content.length>0);

  const fields: SmartFields = { docType: sections.length ? 'resume' : 'generic', name, title };
  const phoneHit = map.contact.find((c)=>rePhone.test(c));
  const emailHit = map.contact.find((c)=>reEmail.test(c));
  const addrHit  = map.contact.find((c)=>/(ซอย|ถ\.|ถนน|เขต|แขวง|จังหวัด|อำเภอ|เลขที่|St\.?|Street|Road|Rd\.?|City|Zip)/i.test(c));
  if (phoneHit) fields.phone = (phoneHit.match(rePhone)||[phoneHit])[0];
  if (emailHit) fields.email = (emailHit.match(reEmail)||[emailHit])[0];
  if (addrHit)  fields.address = addrHit;

  return { sections, fields, lineItems: [] };
}
