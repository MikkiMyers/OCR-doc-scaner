// app/api/ai-refine/route.ts
import { NextResponse } from 'next/server';
import { smartParse } from '@/lib/smartParser';
import { parseInvoice } from '@/lib/invoiceParser';
import { cleanOCRText } from '@/lib/textCleanup';
import { parseThaiMemo } from '@/lib/headingParser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* -------------------- utils -------------------- */
function normalizeThaiOCR(s: string) {
  if (!s) return s;
  s = cleanOCRText(s || '');
  s = s.normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
  const lines = s.split(/\r?\n/).map(l => l.trim());
  const merged: string[] = [];
  for (const l of lines) {
    const isBullet = /^[-•▪■●○]|^\d+\)|^\(?\d+\)|^[A-Za-z]\)/.test(l);
    const isHeading =
      /^(เกี่ยวกับฉัน|โปรไฟล์|สรุป|ประสบการณ์|ติดต่อ|ประวัติการศึกษา|ทักษะ|ภาษา|รางวัล|โครงการ|PROFILE|SUMMARY|EXPERIENCE|EDUCATION|SKILLS|LANGUAGES|AWARDS|PROJECTS|CONTACT|INVOICE|RECEIPT|BILL|ส่วนราชการ|เรื่อง|สิ่งที่ส่งมาด้วย|เรียน|ลงชื่อ|วันที่|ที่)\b/i
        .test(l);
    if (!l) { merged.push(''); continue; }
    if (isBullet || isHeading) { merged.push(l); continue; }
    if (!merged.length || merged[merged.length - 1] === '') merged.push(l);
    else merged[merged.length - 1] += ' ' + l;
  }
  s = merged.join('\n');
  const fixes: Array<[RegExp, string]> = [
    [/^(เรือง|เรีอง|เริ่อง|เรียง)(\s|:)/im, 'เรื่อง$2'],
    [/^เรยน(\s|:)/im, 'เรียน$1'],
    [/^วันที(\s|:)/im, 'วันที่$1'],
    [/^วันทึ(\s|:)/im, 'วันที่$1'],
    [/^สิ่งทีส่งมาด้วย\b/im, 'สิ่งที่ส่งมาด้วย'],
    [/^สิ่งที่สงมาด้วย\b/im, 'สิ่งที่ส่งมาด้วย'],
  ];
  for (const [re, rep] of fixes) s = s.replace(re, rep);
  const THAI = '\u0E00-\u0E7F';
  for (let i = 0; i < 3; i++) s = s.replace(new RegExp(`([${THAI}])\\s+([${THAI}])`, 'gu'), '$1$2');
  s = s.replace(/\s+([,.;:!?%)(\]\}”])(?=\s|$)/g, '$1').replace(/([([“])\s+/g, '$1').replace(/ \)/g, ')').replace(/ ,/g, ',');
  return s.trim();
}

function looksLikeInvoice(text: string) {
  const t = text;
  const must = /INVOICE\b/i.test(t);
  const cols = /(DESCRIPTION).*(UNIT PRICE).*(QTY|QUANTITY).*(TOTAL|AMOUNT)/i.test(t);
  const money = /\bSUBTOTAL\b|\bTOTAL\b|\bTAX\b|\bVat\b/i.test(t);
  const meta  = /(INVOICE\s*(NO|#)|DUE\s*DATE|INVOICE\s*DATE)/i.test(t);
  return must && (cols || money || meta);
}

function looksLikeThaiMemo(text: string) {
  const t = text || '';
  if (!/บันทึก\s*ข้อความ/.test(t)) return false;
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pats: Record<string, RegExp[]> = {
    agency:  [/^ส่วน\s*ราชการ/],
    refNo:   [/^ที่\b|^ที\b/],
    date:    [/^วันที่\b|^วันที\b|^วันทึ\b/],
    title:   [/^เรื่อง\b|^เรือง\b|^เรีอง\b|^เริ่อง\b|^เรียง\b/],
    to:      [/^เรียน\b|^เรยน\b/],
    attach:  [/^สิ่ง.?ที่.?ส่งมาด้วย\b|^สิ่งทีส่งมาด้วย\b|^สิ่งที่สงมาด้วย\b/],
    signer:  [/^ลงชื่อ\b/],
  };
  const hit = (k: string) => lines.some(l => pats[k].some(r => r.test(l)));
  const headerHits = ['agency','refNo','date','title'].filter(hit).length;
  const bodyHits   = ['to','attach','signer'].filter(hit).length;
  return headerHits >= 2 && bodyHits >= 1;
}

/* -------------------- refine core -------------------- */
function localRefine(raw: string) {
  const clean = normalizeThaiOCR(raw);

  // invoice
  if (looksLikeInvoice(clean)) {
    const inv = parseInvoice(clean);
    return {
      ok: true, from: 'local-invoice', cleanText: clean,
      sections: [],
      fields: { ...(inv.fields || {}), docType: 'invoice' },
      lineItems: inv.lineItems || [],
    };
  }

  // thai memo via smartParse / heuristic
  const sp = smartParse(clean, { lang: 'auto' } as any);
  if (sp?.fields?.docType === 'thai_memo' || looksLikeThaiMemo(clean)) {
    const memo = parseThaiMemo(clean);
    return {
      ok: true, from: 'local-thai-memo', cleanText: clean,
      sections: memo.sections || [],
      fields: { docType: 'thai_memo', ...(memo.fields || {}) },
      lineItems: [],
    };
  }

  // resume/generic
  return {
    ok: true, from: 'local-generic', cleanText: clean,
    sections: sp.sections || [],
    fields: { ...(sp.fields || {}), docType: (sp.fields?.docType as any) || 'generic' },
    lineItems: sp.lineItems || [],
  };
}

/* -------------------- Route -------------------- */
export async function POST(req: Request) {
  try {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const text: string = String(body?.text || '');

    if (!text.trim()) {
      return NextResponse.json({ ok: true, from: 'noop', cleanText: '', sections: [], fields: { docType: 'generic' } }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    // ใช้ local เสมอ (ไม่มี external dependency → จะไม่ล่ม)
    const r = localRefine(text);
    return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    // ไม่โยน 500 ออกไป ให้ UI แสดงข้อความได้
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
}
