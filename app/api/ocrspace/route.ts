import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

type OCRSpaceResponse = {
  ParsedResults?: Array<{ ParsedText?: string }>;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
};

export async function POST(req: NextRequest) {
  try {
    const { dataURL, language } = await req.json();
    if (!dataURL) return NextResponse.json({ error: "Missing dataURL" }, { status: 400 });

    const apiKey = process.env.OCRSPACE_API_KEY || "helloworld";
    const form = new FormData();
    form.append("base64Image", dataURL);

    const rawLang = String(language ?? "").trim().toLowerCase();
    const lang = ["tha", "eng", "auto"].includes(rawLang) ? rawLang : "tha";
    form.append("language", lang);

    form.append("scale", "true");
    form.append("isTable", "true");
    form.append("detectOrientation", "true");
    form.append("isOverlayRequired", "false");
    form.append("ocrengine", "2");

    // --- timeout 45s ---
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45_000);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: apiKey },
      body: form,
      signal: controller.signal,
    }).catch((e) => {
      throw new Error(e.name === "AbortError" ? "Upstream timeout" : e.message);
    });
    clearTimeout(t);

    const raw = await resp.text();
    let json: OCRSpaceResponse | null = null;
    try { json = JSON.parse(raw); } catch {
      // upstream ตอบ HTML/ข้อความ ไม่ใช่ JSON
      return NextResponse.json(
        { error: `Upstream ${resp.status}: ${raw.slice(0, 200)}` },
        { status: 502 }
      );
    }

    if (!resp.ok) {
      const msg = Array.isArray(json?.ErrorMessage) ? json?.ErrorMessage?.join("; ") : json?.ErrorMessage;
      return NextResponse.json({ error: msg || `Upstream ${resp.status}` }, { status: 502 });
    }
    if (json?.IsErroredOnProcessing) {
      const msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join("; ") : json.ErrorMessage;
      return NextResponse.json({ error: msg || "OCR failed" }, { status: 502 });
    }

    const text = json?.ParsedResults?.[0]?.ParsedText ?? "";
    return NextResponse.json({ text });
  } catch (e: any) {
    const msg = e?.message || "Unexpected error";
    const status = /timeout/i.test(msg) ? 504 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
