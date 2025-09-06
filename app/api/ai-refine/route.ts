// app/api/ai-refine/route.ts
import { NextResponse } from 'next/server';
import { smartParse } from '@/lib/smartParser';
import { parseInvoice } from '@/lib/invoiceParser';

export const runtime = 'nodejs';

/* -------------------- Text normalizer (TH/EN) -------------------- */
function normalizeThaiOCR(s: string) {
  if (!s) return s;
  s = s.normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');

  // รวมบรรทัดเว้น heading/bullet
  const lines = s.split(/\r?\n/).map(l => l.trim());
  const merged: string[] = [];
  for (const l of lines) {
    const isBullet = /^[-•▪■●○]|^\d+\)|^\(?\d+\)|^[A-Za-z]\)/.test(l);
    const isHeading =
      /^(เกี่ยวกับฉัน|โปรไฟล์|สรุป|ประสบการณ์|ประสบการณ์การทำงาน|ติดต่อ|ประวัติการศึกษา|ทักษะ|ภาษา|รางวัล|โครงการ|PROFILE|SUMMARY|EXPERIENCE|EDUCATION|SKILLS|LANGUAGES|AWARDS|PROJECTS|CONTACT|INVOICE|RECEIPT|BILL)\b/i
        .test(l);
    if (!l) { merged.push(''); continue; }
    if (isBullet || isHeading) { merged.push(l); continue; }
    if (!merged.length || merged[merged.length - 1] === '') merged.push(l);
    else merged[merged.length - 1] += ' ' + l;
  }
  s = merged.join('\n');

  // แก้คำเพี้ยนที่พบบ่อย
  const fixes: Array<[RegExp, string]> = [
    [/กลยุทร์|กลยทร์/g, 'กลยุทธ์'],
    [/ดิวิทัล|ดิงิทัล/g, 'ดิจิทัล'],
    [/ออพฟไลน์|ออฟฟไลน์/g, 'ออฟไลน์'],
    [/เพมยอดขาย/g, 'เพิ่มยอดขาย'],
    [/ประสิกธิภภาพ/g, 'ประสิทธิภาพ'],
    [/ป๊จจุบัน|ปัจจุบันน์?/g, 'ปัจจุบัน'],
    [/ท่างาน/g, 'ทำงาน'],
    [/บรณญูญาตร์|ปรณญูญาตร์|ปริญญาตร์/g, 'ปริญญาตรี'],
    [/โทบริหารธุรกิว/g, 'โทบริหารธุรกิจ'],
    [/รางวัลท์/g, 'รางวัล'],
  ];
  for (const [re, rep] of fixes) s = s.replace(re, rep);

  // ลบช่องว่างระหว่างอักษรไทย
  const THAI = '\u0E00-\u0E7F';
  for (let i = 0; i < 3; i++) s = s.replace(new RegExp(`([${THAI}])\\s+([${THAI}])`, 'gu'), '$1$2');

  // วรรคตอน
  s = s.replace(/\s+([,.;:!?%)(\]\}”])(?=\s|$)/g, '$1')
       .replace(/([([“])\s+/g, '$1')
       .replace(/ \)/g, ')')
       .replace(/ ,/g, ',');

  return s.trim();
}

/* -------------------- Heuristics -------------------- */
function looksLikeInvoice(text: string) {
  const t = text;
  const must = /INVOICE\b/i.test(t);
  const cols = /(DESCRIPTION).*(UNIT PRICE).*(QTY|QUANTITY).*(TOTAL|AMOUNT)/i.test(t);
  const money = /\bSUBTOTAL\b|\bTOTAL\b|\bTAX\b|\bVat\b/i.test(t);
  const meta = /(INVOICE\s*(NO|#)|DUE\s*DATE|INVOICE\s*DATE)/i.test(t);
  return must && (cols || money || meta);
}

/* -------------------- Sectionizers -------------------- */
function sectionizeResume(text: string) {
  const HEADERS = [
    'เกี่ยวกับฉัน','โปรไฟล์','สรุป','PROFILE','SUMMARY',
    'ติดต่อ','CONTACT',
    'ประสบการณ์','ประสบการณ์การทำงาน','WORK EXPERIENCE','EXPERIENCE',
    'ประวัติการศึกษา','EDUCATION',
    'ทักษะ','SKILLS','ภาษา','LANGUAGES',
    'รางวัล','AWARDS','โครงการ','PROJECTS','CERTIFICATIONS'
  ];
  const headingRE = new RegExp(
    `^(${HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'i'
  );
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out: { heading: string; content: string[] }[] = [];
  let cur: { heading: string; content: string[] } | null = null;

  const push = () => { if (cur) out.push(cur); cur = null; };

  for (const l of lines) {
    if (headingRE.test(l) || (/^[A-Zก-๙ ]{6,}$/.test(l) && l.length < 60)) {
      push(); cur = { heading: l.replace(/^[-•●○]\s?/, ''), content: [] };
    } else {
      if (!cur) cur = { heading: 'เกี่ยวกับฉัน', content: [] };
      cur.content.push(l.replace(/^[•\-▪■●○]\s?/, ''));
    }
  }
  push();
  return out;
}

function sectionizeInvoice(text: string) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const out: { heading: string; content: string[] }[] = [];

  const idx = (re: RegExp) => lines.findIndex(l => re.test(l));

  const iIssued = idx(/\b(ISSUED TO|BILL TO)\b/i);
  const iPay    = idx(/\b(PAY TO|SHIP TO)\b/i);
  const iMeta   = idx(/\b(INVOICE\s*(NO|#)|INVOICE\s*DATE|DUE\s*DATE|P\.?O\.?#?)\b/i);
  const iTable  = idx(/(DESCRIPTION).*(UNIT PRICE).*(QTY|QUANTITY).*(TOTAL|AMOUNT)/i);
  const iSub    = idx(/\bSUBTOTAL\b/i);
  const iTotal  = idx(/^\s*(TOTAL|Grand Total)\b/i);

  const take = (from: number, until: number) =>
    (from >= 0 ? lines.slice(from + 1, (until >= 0 ? until : lines.length))
      .filter(l => l && !/^-{2,}$/.test(l)) : []);

  if (iMeta >= 0) {
    out.push({ heading: 'Invoice Meta', content: [lines[iMeta]] });
  }
  if (iIssued >= 0) {
    const until = Math.min(
      ...[iPay, iTable, iSub, iTotal].map(x => (x >= 0 ? x : Number.POSITIVE_INFINITY))
    );
    out.push({ heading: lines[iIssued], content: take(iIssued, until) });
  }
  if (iPay >= 0) {
    const until = Math.min(
      ...[iTable, iSub, iTotal].map(x => (x >= 0 ? x : Number.POSITIVE_INFINITY))
    );
    out.push({ heading: lines[iPay], content: take(iPay, until) });
  }
  if (iTable >= 0) {
    const until = Math.min(
      ...[iSub, iTotal].map(x => (x >= 0 ? x : Number.POSITIVE_INFINITY))
    );
    out.push({
      heading: 'Line Items',
      content: [lines[iTable], ...lines.slice(iTable + 1, until).filter(Boolean)],
    });
  }
  if (iSub >= 0 || iTotal >= 0) {
    const start = (iSub >= 0 ? iSub : iTotal);
    out.push({
      heading: 'Totals',
      content: lines.slice(start).filter(l => /\b(SUBTOTAL|TOTAL|TAX|VAT)\b/i.test(l)),
    });
  }
  // สำรอง: ถ้าไม่เจออะไรเลยให้โยนทั้งก้อน
  if (!out.length) out.push({ heading: 'Invoice', content: lines.filter(Boolean) });
  return out;
}

/* -------------------- Name/Title guess (resume only) -------------------- */
function guessNameTitle(text: string) {
  const firstBlock = text.split('\n').slice(0, 10).join(' ');
  const email = firstBlock.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = firstBlock.match(/\+?\d[\d\- ]{7,}\d/)?.[0];
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean).slice(0,8);

  let name: string|undefined;
  for (const l of lines) {
    if (email && l.includes(email)) continue;
    if (phone && l.includes(phone)) continue;
    if (/^(EXPERIENCE|EDUCATION|SKILLS|PROFILE|SUMMARY|CONTACT|ประสบการณ์|การศึกษา|ทักษะ|สรุป|ติดต่อ)/i.test(l)) break;
    const wc = l.split(/\s+/).length;
    if (wc>=1 && wc<=5 && l.length<=50) { name = l; break; }
  }
  const title = firstBlock.match(/(SENIOR|JUNIOR)?\s*(MARKETING MANAGER|MARKETING EXECUTIVE|SOFTWARE ENGINEER|DEVELOPER|DESIGNER|DATA ANALYST|ผู้จัดการ|นักการตลาด|วิศวกร|นักออกแบบ)/i)?.[0];
  return { name, title };
}

/* -------------------- Local refine (ฟรี) -------------------- */
function localRefine(raw: string) {
  const clean = normalizeThaiOCR(raw);

  if (looksLikeInvoice(clean)) {
    // ใช้ parser invoice + sectionizer แบบ invoice
    const inv = parseInvoice(clean);
    const sections = sectionizeInvoice(clean);
    return {
      ok: true,
      from: 'local-invoice',
      cleanText: clean,
      sections,
      fields: {
        ...(inv.fields || {}),
        docType: 'invoice',
      },
      lineItems: inv.lineItems || [],
    };
  }

  // Resume / Generic
  const sp = smartParse(clean, { lang: 'auto' });
  const sections = sectionizeResume(clean);
  const { name, title } = guessNameTitle(clean);

  return {
    ok: true,
    from: 'local-resume',
    cleanText: clean,
    sections,
    fields: {
      ...(sp.fields || {}),
      docType: 'resume',
      name: name || (sp as any)?.fields?.name,
      title: title || (sp as any)?.fields?.title,
    },
    lineItems: sp.lineItems || [],
  };
}

/* -------------------- Cloud refine (optional) -------------------- */
async function cloudRefineOpenAI(raw: string) {
  // dynamic import เพื่อไม่บังคับติดตั้งแพ็กเกจ
  // @ts-ignore
  const mod = await import('openai');
  const client = new mod.default({ apiKey: process.env.OPENAI_API_KEY! });

  const sys = `You are a proofreading & structuring assistant for OCR Thai/English.
Detect if the doc is an INVOICE; if yes, prefer invoice sections:
["Invoice Meta","ISSUED TO|BILL TO","PAY TO|SHIP TO","Line Items","Totals"].
Return STRICT JSON ONLY:
{"cleanText":"...", "sections":[{"heading":"...","content":["..."]}], "fields":{"docType":"invoice|resume|generic","name": "...","title":"..."}}`;

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `RAW OCR:\n${raw}` },
    ],
  });

  const content = resp.choices?.[0]?.message?.content || '{}';
  const jsonStr = content.replace(/^```json|```$/g, '').trim();
  const payload = JSON.parse(jsonStr);

  // ถ้าเป็น invoice รวมผล parseInvoice ด้วย
  let extra: any = {};
  if ((payload?.fields?.docType || '').toLowerCase() === 'invoice') {
    const inv = parseInvoice(payload.cleanText || raw);
    extra = { fields: { ...(payload.fields||{}), ...(inv.fields||{}) }, lineItems: inv.lineItems || [] };
  }

  return {
    ok: true,
    from: 'openai',
    cleanText: payload.cleanText ?? '',
    sections: payload.sections ?? [],
    fields: payload.fields ?? { docType: 'generic' },
    ...extra,
  };
}

/* -------------------- Route -------------------- */
export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    if (!text || !text.trim()) {
      return NextResponse.json({ ok: true, from: 'noop', cleanText: '', sections: [], fields: { docType: 'generic' } });
    }

    const pref = (process.env.AI_PROVIDER || 'local').toLowerCase();
    const hasOpenAI = !!process.env.OPENAI_API_KEY;

    // local ตลอด (ฟรี/เสถียร)
    if (pref === 'local' || !hasOpenAI) {
      return NextResponse.json(localRefine(text));
    }

    // cloud → ถ้าพัง/โควต้าเกิน → local fallback
    try {
      const r = await cloudRefineOpenAI(text);
      return NextResponse.json(r);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/401|403|429|quota|billing|insufficient/i.test(msg)) {
        const local = localRefine(text);
        return NextResponse.json({ ...local, from: 'local-fallback', meta: { cloudError: msg } });
      }
      const local = localRefine(text);
      return NextResponse.json({ ...local, from: 'local-fallback', meta: { cloudError: msg } });
    }
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
