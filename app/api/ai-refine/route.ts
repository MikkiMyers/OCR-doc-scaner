// app/api/ai-refine/route.ts
import { NextResponse } from 'next/server';
import { smartParse } from '@/lib/smartParser';

export const runtime = 'nodejs';
export const maxDuration = 30;

// โพรพท์กลาง: ทำความสะอาดข้อความ + จัดหัวข้อสำหรับเรซูเม่/โปรไฟล์/เอกสารทั่วไป
const SYSTEM =
  `คุณเป็นผู้ช่วยแก้ถ้อยคำภาษาไทยให้ "อ่านง่าย สุภาพ ไม่เปลี่ยนสาระ" 
- ลบตัวอักษรเพี้ยนจาก OCR, รวมบรรทัดที่ขาดตอน
- รักษา bullet และปี/ช่วงเวลา ถ้าเป็นเรซูเม่ให้พยายามหา name/title
- คืนค่าเป็น JSON เท่านั้น (อย่าใส่คำบรรยายหรือโค้ดบล็อค):
{
  "cleanText": string,
  "sections": [{"heading": string, "content": string[]}],
  "name": string|null,
  "title": string|null
}`;

type AiResult = {
  cleanText: string;
  sections: Array<{ heading: string; content: string[] }>;
  name?: string | null;
  title?: string | null;
};

function ok(data: AiResult | { from: 'fallback'; cleanText: string; sections: any; name?: any; title?: any }) {
  return NextResponse.json({ ok: true, ...data }, { status: 200 });
}
function bad(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

// --- Providers (เปิดใช้เท่าที่ตั้งค่าไว้) -------------------------

async function refineWithOpenAI(text: string): Promise<AiResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  // import แบบไดนามิก เผื่อโปรเจกต์ยังไม่ได้ลงแพ็กเกจ openai
  // (จะโยน error ตรงนี้แทน 500 บน runtime)
  // @ts-ignore
  const mod = await import('openai');
  const client = new mod.default({ apiKey });

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const r = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' }, // บังคับให้ตอบ JSON ล้วน
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ข้อความดิบจาก OCR:\n${text}` },
    ],
  });

  const raw = r.choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

async function refineWithGemini(text: string): Promise<AiResult> {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set');
  // @ts-ignore
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });

  const prompt = `${SYSTEM}\n\nข้อความดิบจาก OCR:\n${text}\n\nโปรดตอบเป็น JSON เท่านั้น`;
  const r = await model.generateContent(prompt);
  // บางครั้ง Gemini จะครอบด้วย ```json ... ``` ให้ลอกคราบก่อน parse
  const out = r.response.text().replace(/^```json|```$/g, '').trim();
  return JSON.parse(out);
}

// --- Handler --------------------------------------------------------

export async function POST(req: Request) {
  try {
    const bodyText = await req.text(); // ป้องกัน JSON ว่าง
    if (!bodyText) return bad(400, 'Empty body');
    let payload: any = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return bad(400, 'Body is not valid JSON');
    }

    const text: string = String(payload?.text || '').trim();
    if (!text) return bad(400, 'Missing "text"');

    // เลือกผู้ให้บริการตาม env ที่มี
    let data: AiResult | null = null;
    const providers: Array<() => Promise<AiResult>> = [];

    if (process.env.OPENAI_API_KEY) providers.push(() => refineWithOpenAI(text));
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) providers.push(() => refineWithGemini(text));

    // ไม่มีคีย์ → ใช้ fallback local ทันที
    if (providers.length === 0) {
      const sp = smartParse(text, { lang: 'auto' });
      return ok({ from: 'fallback', cleanText: text, sections: sp.sections, name: null, title: null });
    }

    // พยายามเรียกทีละเจ้า (ถ้าตัวแรกพัง จะลองตัวถัดไป)
    let lastError: any = null;
    for (const run of providers) {
      try {
        data = await run();
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!data) {
      // สุดท้ายจริง ๆ → fallback
      const sp = smartParse(text, { lang: 'auto' });
      return ok({ from: 'fallback', cleanText: text, sections: sp.sections, name: null, title: null });
    }

    return ok(data);
  } catch (e: any) {
    // ไม่ปล่อยให้ Next ส่ง HTML กลับ → ส่ง JSON เสมอ
    return bad(500, e?.message || 'Internal error');
  }
}
