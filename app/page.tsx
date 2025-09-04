'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Spinner from '@/components/Spinner';
import { Download, Image as ImageIcon, ScanLine } from 'lucide-react';
import { createWorker, PSM } from 'tesseract.js';
import { smartParse, SmartFields, LineItem as SmartLineItem } from '@/lib/smartParser';
import { parseInvoice } from '@/lib/invoiceParser';

declare global {
  interface Window { cv: any }
}

type OCRState = 'idle' | 'preprocess' | 'ocr' | 'done' | 'error';
type OCRProgress = { stage: OCRState; progress: number; message?: string };

/* ---------- utils (ประกาศนอก component ให้ stable) ---------- */
const dataURLBytes = (d: string) => {
  const i = d.indexOf(','); const b64 = i >= 0 ? d.slice(i + 1) : d;
  return Math.ceil((b64.length * 3) / 4);
};
const loadImageFromDataURL = (d: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = d;
  });

export default function Page() {
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [processedURL, setProcessedURL] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const [status, setStatus] = useState<OCRProgress>({ stage: 'idle', progress: 0 });
  const [cvReady, setCvReady] = useState(false);

  // ภาษาเอกสาร: auto = tha+eng
  const [ocrLang, setOcrLang] = useState<'auto' | 'tha' | 'eng' | 'tha+eng'>('auto');

  // smart parser outputs
  const [sections, setSections] = useState<{ heading: string; content: string[] }[]>([]);
  const [docFields, setDocFields] = useState<SmartFields | null>(null);
  const [lineItems, setLineItems] = useState<SmartLineItem[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ---------- OpenCV init ---------- */
  useEffect(() => {
    let interval: any;
    const check = () => {
      const ok = typeof window !== 'undefined' && !!window.cv && !!window.cv.Mat;
      if (ok) {
        if (window.cv.onRuntimeInitialized) {
          window.cv.onRuntimeInitialized = () => setCvReady(true);
        }
        setCvReady(true);
        clearInterval(interval);
      }
    };
    interval = setInterval(check, 200);
    return () => clearInterval(interval);
  }, []);

  /* ---------- Tesseract worker cache ตามภาษา ---------- */
  const workersRef = useRef<Record<string, Promise<any>>>({});
  const getWorker = useCallback((lang: 'tha' | 'eng' | 'tha+eng') => {
    if (!workersRef.current[lang]) {
      workersRef.current[lang] = createWorker(
        lang,
        undefined,
        {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              setStatus({ stage: 'ocr', progress: m.progress ?? 0 });
            }
          },
          workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        }
      );
    }
    return workersRef.current[lang];
  }, []);

  /* ---------- basic UI handlers ---------- */
  const reset = () => {
    setImageURL(null);
    setProcessedURL(null);
    setText('');
    setSections([]);
    setDocFields(null);
    setLineItems([]);
    setStatus({ stage: 'idle', progress: 0 });
  };
  const onPickFile = () => inputRef.current?.click();
  const onFile = useCallback((file: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageURL(url);
  }, []);
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };
  const prevent = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault();

  /* ---------- helpers ---------- */
  const urlToDataURL = useCallback(async (url: string): Promise<string> => {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, []);

  const tidyText = useCallback((s: string) => {
    // normalize + แทน spaces พิเศษเป็น space
    s = (s || '').normalize('NFC').replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
    s = s.replace(/[ \t]{2,}/g, ' ');
    // รวมบรรทัด (ยกเว้นหัวข้อ/บูลเล็ต)
    const lines = s.split(/\r?\n/).map(l => l.trim());
    const merged: string[] = [];
    for (const l of lines) {
      const isBullet = /^[-•▪■●○]|^\d+\)|^\(?\d+\)|^[A-Za-z]\)/.test(l);
      const isHeading = /^[\d]+\)\s|^ข้อ\s*\d+|^(หัวข้อ|สรุป|หมายเหตุ|เนื้อหา|SUMMARY|RELATED|PROJECT|EDUCATION|EXPERIENCE|ADDITIONAL INFORMATION|INVOICE|RECEIPT|BILL)\b/i.test(l);
      if (!l) { merged.push(''); continue; }
      if (isBullet || isHeading) { merged.push(l); continue; }
      if (!merged.length || merged[merged.length - 1] === '') merged.push(l);
      else merged[merged.length - 1] += ' ' + l;
    }
    s = merged.join('\n');
    // ลบช่องว่างระหว่างอักษรไทย
    const THAI = '\u0E00-\u0E7F';
    for (let i = 0; i < 3; i++) s = s.replace(new RegExp(`([${THAI}])\\s+([${THAI}])`, 'gu'), '$1$2');
    // วรรคตอน
    s = s.replace(/\s+([,.;:!?%)(\]\}”])(?=\s|$)/g, '$1').replace(/([([“])\s+/g, '$1').replace(/ \)/g, ')').replace(/ ,/g, ',');
    return s.trim();
  }, []);

  const compressDataURL = useCallback(async (d: string, maxBytes = 1_300_000) => {
    if (dataURLBytes(d) <= maxBytes) return d;
    const img = await loadImageFromDataURL(d);
    const canvas = document.createElement('canvas');
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.8; let out = canvas.toDataURL('image/jpeg', q);
    while (dataURLBytes(out) > maxBytes && q > 0.5) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
    return out;
  }, []);

  /* ---------- Cloud OCR (OCR.space) ---------- */
  const toOcrSpaceLang = (l: 'auto' | 'tha' | 'eng' | 'tha+eng') => (l === 'auto' ? 'tha,eng' : l.replace('+', ','));
  const cloudOCR = useCallback(async (processedDataURL: string) => {
    setStatus({ stage: 'ocr', progress: 0.01, message: 'กำลังส่งให้โมเดล AI...' });
    let payload = await compressDataURL(processedDataURL);
    if (dataURLBytes(payload) < 20_000 && imageURL) {
      const raw = await urlToDataURL(imageURL);
      payload = await compressDataURL(raw);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch('/api/ocrspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataURL: payload, language: toOcrSpaceLang(ocrLang) }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Cloud OCR error');
      return json.text as string;
    } finally {
      clearTimeout(timeoutId);
    }
  }, [compressDataURL, imageURL, urlToDataURL, ocrLang]);

  /* ---------- Core pipeline ---------- */
  const runPipeline = useCallback(async () => {
    if (!imageURL || !cvReady) return;

    try {
      setStatus({ stage: 'preprocess', progress: 0.05, message: 'กำลังเตรียมภาพ...' });

      // โหลดรูป
      const img = new Image();
      img.src = imageURL;
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('โหลดรูปไม่สำเร็จ')); });

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error('2D canvas context not available');

      // fit -> วาด
      const scale = Math.min(1200 / img.width, 1200 / img.height, 1);
      const w = Math.round(img.width * scale); const h = Math.round(img.height * scale);
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);

      const cv = (window as any).cv;

      // OpenCV: gray/blur/edge/contours → warp ถ้าเจอสี่เหลี่ยมใหญ่
      const src = cv.imread(canvas);
      const gray = new cv.Mat(), blur = new cv.Mat(), edged = new cv.Mat();
      const contours = new cv.MatVector(), hierarchy = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edged, 50, 150);
      cv.findContours(edged, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      let maxArea = 0, approxCandidate: any = null;
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i), peri = cv.arcLength(cnt, true), approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        if (approx.rows === 4) {
          const area = cv.contourArea(approx);
          if (area > maxArea) { maxArea = area; if (approxCandidate) approxCandidate.delete(); approxCandidate = approx; }
          else approx.delete();
        } else approx.delete();
      }

      let warped = new cv.Mat();
      const imageArea = src.rows * src.cols;
      if (approxCandidate && maxArea > imageArea * 0.25) {
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < 4; i++) { const x = approxCandidate.intPtr(i, 0)[0]; const y = approxCandidate.intPtr(i, 0)[1]; pts.push({ x, y }); }
        pts.sort((a, b) => a.y - b.y || a.x - b.x);
        const top = pts.slice(0, 2).sort((a, b) => a.x - b.x), bottom = pts.slice(2).sort((a, b) => a.x - b.x);
        const tl = top[0], tr = top[1], bl = bottom[0], br = bottom[1];
        const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
        const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
        const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
        const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
        const maxW = Math.max(widthTop, widthBottom) | 0;
        const maxH = Math.max(heightLeft, heightRight) | 0;
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxW, 0, maxW, maxH, 0, maxH]);
        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        cv.warpPerspective(src, warped, M, new cv.Size(maxW, maxH));
        srcTri.delete(); dstTri.delete(); M.delete();
      } else {
        warped = src.clone();
      }

      // เตรียมภาพสำหรับ OCR
      const gray0 = new cv.Mat(); cv.cvtColor(warped, gray0, cv.COLOR_RGBA2GRAY, 0);
      const up = new cv.Mat(); cv.resize(gray0, up, new cv.Size(0, 0), 2, 2, cv.INTER_CUBIC);
      const den = new cv.Mat(); cv.bilateralFilter(up, den, 9, 75, 75);
      const bin = new cv.Mat(); cv.threshold(den, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.imshow(canvas, bin);

      // cleanup mats
      src.delete(); gray.delete(); blur.delete(); edged.delete();
      contours.delete(); hierarchy.delete();
      if (approxCandidate) approxCandidate.delete();
      warped.delete(); gray0.delete(); up.delete(); den.delete(); bin.delete();

      // ส่งเข้า OCR
      const processed = canvas.toDataURL('image/png');
      setProcessedURL(processed);
      setStatus({ stage: 'ocr', progress: 0.0, message: 'กำลังอ่านตัวอักษร...' });

      const tesseractLang: 'tha' | 'eng' | 'tha+eng' = ocrLang === 'auto' ? 'tha+eng' : ocrLang;
      const worker = await getWorker(tesseractLang);
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
        user_defined_dpi: '300',
        preserve_interword_spaces: '0',
      });
      if (tesseractLang === 'eng') {
        await worker.setParameters({
          tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-–—.,:;!?()[]{}\'"@/&%+*#_$ ',
        });
      }
      const { data } = await worker.recognize(processed);
      let out = data.text ?? '';

      // fallback cloud
      const tooShort = (s: string) => !s || s.replace(/\s/g, '').length < 20;
      if (tooShort(out)) {
        try {
          let cloud = await cloudOCR(processed);
          if (tooShort(cloud) && imageURL) {
            const raw = await urlToDataURL(imageURL);
            const cloudRaw = await cloudOCR(raw);
            if (!tooShort(cloudRaw) && (cloudRaw.length > (cloud?.length ?? 0))) cloud = cloudRaw;
          }
          if (!tooShort(cloud) && cloud.length > out.length) out = cloud;
        } catch (e) {
          console.warn('Cloud OCR fallback failed:', e);
        }
      }

      // ---- tidy + parsing รวมผล invoice + generic ----
      const cleaned = tidyText(out);
      setText(cleaned);

      // 1) parser เฉพาะ invoice
      const inv = parseInvoice(cleaned);

      // 2) parser ทั่วไป (มี sections)
      const langForSmart: 'auto' | 'tha' | 'eng' =
        ocrLang === 'eng' ? 'eng' : ocrLang === 'tha' ? 'tha' : 'auto';
      const sp = smartParse(cleaned, { lang: langForSmart });

      // heuristic ว่าเป็น invoice/receipt ไหม
      const looksLikeInvoice =
        inv.lineItems.length > 0 ||
        !!inv.fields.total?.value ||
        !!inv.fields.docNo ||
        /INVOICE|RECEIPT/i.test(cleaned);

      const finalFields: SmartFields = looksLikeInvoice ? inv.fields : sp.fields;
      const finalLineItems: SmartLineItem[] = looksLikeInvoice ? inv.lineItems : (sp.lineItems ?? []);

      setSections(sp.sections);
      setDocFields(finalFields);
      setLineItems(finalLineItems);

      setStatus({ stage: 'done', progress: 1 });
    } catch (err) {
      console.error(err);
      setStatus({ stage: 'error', progress: 0, message: (err as Error).message });
    }
  }, [imageURL, cvReady, ocrLang, getWorker, cloudOCR, urlToDataURL, tidyText]);

  useEffect(() => { if (imageURL && cvReady) runPipeline(); }, [imageURL, cvReady, runPipeline]);

  /* ---------- download JSON ---------- */
  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify({ text, fields: docFields, lineItems, sections }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ocr_result.json'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <main className="max-w-6xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">DocScan OCR (ไทย/อังกฤษ)</h1>
        <p className="text-gray-600 mt-2">
          อัปโหลดหรือถ่ายภาพเอกสาร → ระบบจะตัดภาพ/ปรับมุมให้อัตโนมัติ แล้วทำ OCR และแยกหัวข้อ/สรุปเอกสารอัจฉริยะ
        </p>
      </div>

      <div onDrop={handleDrop} onDragOver={prevent} onDragEnter={prevent} className="border-2 border-dashed rounded-2xl p-8 text-center bg-white shadow-soft">
        <div className="flex flex-col items-center gap-3">
          <div className="p-3 rounded-xl bg-gray-100"><ScanLine className="h-7 w-7" /></div>
          <p className="text-gray-700">ลากรูปมาวางที่นี่ หรือ</p>
          <button className="px-4 py-2 rounded-xl bg-black text-white hover:opacity-90 transition" onClick={onPickFile}>เลือกรูปเอกสาร</button>
          <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          <p className="text-xs text-gray-500">รองรับ .jpg .png ขนาดไม่เกิน ~10MB</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-8">
        {/* ภาพ */}
        <div className="bg-white rounded-2xl p-4 shadow-soft">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><ImageIcon className="h-5 w-5" /> ภาพ</h2>
          <div className="space-y-4">
            <div className="rounded-xl overflow-hidden border bg-gray-50 flex items-center justify-center min-h-[240px]">
              {imageURL ? <img src={imageURL} alt="original" className="max-w-full max-h-[360px]" /> : <div className="text-gray-400">ยังไม่เลือกรูป</div>}
            </div>
            <div className="rounded-xl overflow-hidden border bg-gray-50 flex items-center justify-center min-h-[240px]">
              <canvas ref={canvasRef} className="max-w-full max-h-[360px]" />
            </div>
            <div className="flex gap-2">
              <button onClick={reset} className="px-3 py-2 rounded-lg border hover:bg-gray-50">ล้างค่า</button>
              <button onClick={runPipeline} className="px-3 py-2 rounded-lg bg-black text-white hover:opacity-90" disabled={!imageURL || !cvReady}>ประมวลผลอีกครั้ง</button>
            </div>
            <div className="text-sm text-gray-600">
              สถานะ{' '}
              {status.stage === 'idle' && 'รออัปโหลด'}
              {status.stage !== 'idle' && (
                <span className="inline-flex items-center gap-2">
                  {status.stage !== 'done' && status.stage !== 'error' && <Spinner />}
                  {status.stage === 'preprocess' && `เตรียมภาพ (${Math.round((status.progress || 0) * 100)}%)`}
                  {status.stage === 'ocr' && `อ่านตัวอักษร (${Math.round((status.progress || 0) * 100)}%)`}
                  {status.stage === 'done' && 'เสร็จสมบูรณ์'}
                  {status.stage === 'error' && `ผิดพลาด: ${status.message}`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ผลลัพธ์ */}
        <div className="bg-white rounded-2xl p-4 shadow-soft">
          <h2 className="font-semibold mb-3">ผลลัพธ์ OCR</h2>

          {/* แถบควบคุม */}
          <div className="flex gap-2 mb-3 items-center flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">ภาษาเอกสาร:</span>
              <select
                value={ocrLang}
                onChange={(e) => setOcrLang(e.target.value as any)}
                className="px-2 py-1 border rounded-lg text-sm"
                title="เลือกภาษาเอกสารเพื่อความแม่นยำ"
              >
                <option value="auto">Auto (ไทย+อังกฤษ)</option>
                <option value="tha">ไทย (tha)</option>
                <option value="eng">อังกฤษ (eng)</option>
                <option value="tha+eng">ไทย+อังกฤษ</option>
              </select>
            </div>

            <button onClick={downloadJSON} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border hover:bg-gray-50" disabled={!text}>
              <Download className="h-4 w-4" /> ดาวน์โหลด JSON
            </button>

            <button
              onClick={async () => {
                if (!processedURL) return;
                try {
                  const t = await cloudOCR(processedURL);
                  const cleaned = tidyText(t);
                  setText(cleaned);

                  const inv = parseInvoice(cleaned);
                  const langForSmart: 'auto' | 'tha' | 'eng' =
                    ocrLang === 'eng' ? 'eng' : ocrLang === 'tha' ? 'tha' : 'auto';
                  const sp = smartParse(cleaned, { lang: langForSmart });

                  const looksLikeInvoice =
                    inv.lineItems.length > 0 ||
                    !!inv.fields.total?.value ||
                    !!inv.fields.docNo ||
                    /INVOICE|RECEIPT/i.test(cleaned);

                  const finalFields: SmartFields = looksLikeInvoice ? inv.fields : sp.fields;
                  const finalLineItems: SmartLineItem[] = looksLikeInvoice ? inv.lineItems : (sp.lineItems ?? []);

                  setSections(sp.sections);
                  setDocFields(finalFields);
                  setLineItems(finalLineItems);

                  setStatus({ stage: 'done', progress: 1 });
                } catch (e: any) {
                  alert(`Cloud OCR error: ${e?.message || e}`);
                  setStatus({ stage: 'error', progress: 0, message: String(e?.message || e) });
                }
              }}
              className="px-3 py-2 rounded-lg border hover:bg-gray-50"
              disabled={!processedURL}
            >
              ลอง AI OCR (คลาวด์)
            </button>
          </div>

          {/* Smart summary */}
          {docFields && docFields.docType !== 'generic' && (
            <div className="mb-4 p-3 border rounded-lg bg-gray-50 text-sm">
              <div className="font-semibold mb-1">สรุปเอกสาร (Smart Parser)</div>
              <div><b>ชนิดเอกสาร:</b> {docFields.docType}</div>
              {docFields.docNo && <div><b>เลขที่:</b> {docFields.docNo}</div>}
              {docFields.date && <div><b>วันที่:</b> {docFields.date}</div>}
              {docFields.dueDate && <div><b>กำหนดชำระ:</b> {docFields.dueDate}</div>}
              {(docFields.seller || docFields.buyer) && (
                <>
                  {docFields.seller && <div><b>ผู้ขาย/ผู้ให้บริการ:</b> {docFields.seller}</div>}
                  {docFields.buyer && <div><b>ผู้ซื้อ/ลูกค้า:</b> {docFields.buyer}</div>}
                </>
              )}
              {(docFields.subtotal || docFields.vat || docFields.total) && (
                <>
                  {docFields.subtotal?.text && <div><b>Subtotal:</b> {docFields.subtotal.text}</div>}
                  {docFields.vat?.text && <div><b>VAT:</b> {docFields.vat.text}</div>}
                  {docFields.total?.text && <div><b>Total:</b> {docFields.total.text}</div>}
                </>
              )}
              {(docFields.subject || docFields.recipient || docFields.sender) && (
                <>
                {docFields.subject && <div><b>เรื่อง/Subject:</b> {docFields.subject}</div>}
                {docFields.recipient && <div><b>เรียน/Dear:</b> {docFields.recipient}</div>}
                {docFields.sender && <div><b>ผู้ส่ง/ลงชื่อ:</b> {docFields.sender}</div>}
                </>
              )}
            </div>
          )}

          {lineItems?.length ? (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left p-2">รายการ</th>
                    <th className="text-right p-2">จำนวน</th>
                    <th className="text-right p-2">ราคาต่อหน่วย</th>
                    <th className="text-right p-2">เป็นเงิน</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((it, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2">{it.description}</td>
                      <td className="p-2 text-right">{it.qty ?? ''}</td>
                      <td className="p-2 text-right">{it.unitPrice ?? ''}</td>
                      <td className="p-2 text-right">{it.amount ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* ข้อความดิบ + หัวข้อ */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-600">ข้อความดิบ</h3>
              <pre className="mt-1 p-3 bg-gray-50 rounded-lg max-h-64 overflow-auto text-sm whitespace-pre-wrap">
                {text || '—'}
              </pre>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-600">แยกเป็นหัวข้อ (heuristic)</h3>
              <div className="mt-2 space-y-3">
                {sections.length ? sections.map((s, i) => (
                  <div key={i} className="border rounded-lg p-3">
                    <div className="font-semibold">{s.heading}</div>
                    {s.content.length ? (
                      <ul className="list-disc ml-6 mt-2 space-y-1">
                        {s.content.map((c, ci) => (<li key={ci} className="text-sm">{c}</li>))}
                      </ul>
                    ) : <div className="text-sm text-gray-500 mt-2">—</div>}
                  </div>
                )) : <div className="text-gray-500">—</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 text-xs text-gray-500">
        หมายเหตุ: ใช้ OpenCV.js จาก CDN และ Tesseract.js (โหลดไฟล์ภาษาตามที่เลือก) — ประมวลผลบนเบราว์เซอร์ทั้งหมด
      </div>
    </main>
  );
}
