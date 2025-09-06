'use client';
import './styles/app.minimal.pro.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, ScanLine, Wand2 } from 'lucide-react';
import { createWorker, PSM } from 'tesseract.js';
import { smartParse, SmartFields, LineItem as SmartLineItem } from '@/lib/smartParser';
import { parseInvoice } from '@/lib/invoiceParser';
import { parseThaiMemo } from '@/lib/headingParser';

declare global { interface Window { cv: any } }

type OCRState = 'idle' | 'preprocess' | 'ocr' | 'done' | 'error';
type OCRProgress = { stage: OCRState; progress: number; message?: string };

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'DocScan OCR';

/* -------------------- i18n -------------------- */
type Lang = 'th' | 'en';
const DICT: Record<Lang, Record<string, string>> = {
  th: {
    appTag: 'ไทย/อังกฤษ · OpenCV + Tesseract · Smart Parser',
    uploadBadge: 'อัปโหลดเอกสาร',
    dragHere: 'ลากไฟล์มาวางที่นี่ หรือ',
    chooseFile: 'เลือกไฟล์',
    formats: 'รองรับ .jpg / .png ขนาดไม่เกิน ~10MB',
    originalImage: 'ภาพต้นฉบับ',
    processedImage: 'ภาพหลังปรับ (สำหรับ OCR)',
    reset: 'ล้างค่า',
    reprocess: 'ประมวลผลอีกครั้ง',
    status: 'สถานะ',
    waiting: 'รออัปโหลด',
    preparing: 'กำลังเตรียมภาพ',
    reading: 'กำลังอ่านตัวอักษร…',
    done: 'เสร็จสมบูรณ์',
    error: 'ผิดพลาด',
    docLang: 'ภาษาเอกสาร',
    resultsTitle: 'ผลลัพธ์ OCR',
    autoAI: 'Auto AI',
    tryAI: 'ลอง AI',
    summary: 'สรุปเอกสาร (Smart Parser / AI)',
    docType: 'ชนิดเอกสาร',
    docNo: 'เลขที่',
    date: 'วันที่',
    dueDate: 'กำหนดชำระ',
    seller: 'ผู้ขาย/ผู้ให้บริการ',
    buyer: 'ผู้ซื้อ/ลูกค้า',
    subtotal: 'Subtotal',
    vat: 'VAT',
    total: 'Total',
    name: 'ชื่อ',
    title: 'ตำแหน่ง (อาชีพ)',
    rawText: 'ข้อความดิบ',
    sections: 'แยกเป็นหัวข้อ (heuristic/AI)',
    downloadJSON: 'ดาวน์โหลด JSON',
    toastDone: 'ประมวลผลเสร็จแล้ว',
    toastRefined: 'ปรับภาษา/จัดหัวข้อสำเร็จ',
    toastRefineFailed: 'AI refine ล้มเหลว',
    invoiceMeta: 'ข้อมูลใบแจ้งหนี้',
    lineItems: 'รายการ',
    totals: 'สรุปยอด',
    agency: 'ส่วนราชการ',
    refNo: 'ที่',
    memoTitle: 'เรื่อง',
    to: 'เรียน',
    signer: 'ลงชื่อ',
    position: 'ตำแหน่ง',
  },
  en: {
    appTag: 'Thai/English · OpenCV + Tesseract · Smart Parser',
    uploadBadge: 'Upload document',
    dragHere: 'Drag & drop here or',
    chooseFile: 'Choose file',
    formats: 'Supports .jpg / .png ~10MB',
    originalImage: 'Original image',
    processedImage: 'Processed (for OCR)',
    reset: 'Reset',
    reprocess: 'Re-run',
    status: 'Status',
    waiting: 'Waiting',
    preparing: 'Preprocessing',
    reading: 'Recognizing…',
    done: 'Completed',
    error: 'Error',
    docLang: 'Document language',
    resultsTitle: 'OCR Results',
    autoAI: 'Auto AI',
    tryAI: 'Try AI',
    summary: 'Document summary (Smart Parser / AI)',
    docType: 'Document type',
    docNo: 'No.',
    date: 'Date',
    dueDate: 'Due date',
    seller: 'Seller/Provider',
    buyer: 'Buyer/Client',
    subtotal: 'Subtotal',
    vat: 'VAT',
    total: 'Totals',
    name: 'Name',
    title: 'Title',
    rawText: 'Raw text',
    sections: 'Structured sections (heuristic/AI)',
    downloadJSON: 'Download JSON',
    toastDone: 'Processing finished',
    toastRefined: 'Language/Sections refined',
    toastRefineFailed: 'AI refine failed',
    invoiceMeta: 'Invoice meta',
    lineItems: 'Line items',
    totals: 'Totals',
    agency: 'Agency',
    refNo: 'Ref No.',
    memoTitle: 'Subject',
    to: 'To',
    signer: 'Signer',
    position: 'Position',
  }
};
const useI18n = () => {
  const [uiLang, setUiLang] = useState<Lang>('th');
  const t = useCallback((k: string) => DICT[uiLang]?.[k] ?? k, [uiLang]);
  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('uiLang')) as Lang | null;
    if (saved === 'th' || saved === 'en') setUiLang(saved);
  }, []);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('uiLang', uiLang); }, [uiLang]);
  return { uiLang, setUiLang, t };
};

/* -------------------- helpers -------------------- */
const dataURLBytes = (d: string) => {
  const i = d.indexOf(','); const b64 = i >= 0 ? d.slice(i + 1) : d;
  return Math.ceil((b64.length * 3) / 4);
};
const loadImageFromDataURL = (d: string) =>
  new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = d; });

const fmtNum = (n: any) => {
  const v = typeof n === 'number' ? n : parseFloat(String(n).replace(/[^0-9.-]/g, ''));
  if (isNaN(v)) return String(n ?? '');
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/* ---- Thai memo heuristic (client) ---- */
const looksLikeThaiMemoClient = (text: string) => {
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
};

export default function Page() {
  const { uiLang, setUiLang, t } = useI18n();

  const [imageURL, setImageURL] = useState<string | null>(null);
  const [processedURL, setProcessedURL] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const [status, setStatus] = useState<OCRProgress>({ stage: 'idle', progress: 0 });
  const [cvReady, setCvReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<{ type: 'success'|'error'|'info', message: string }|null>(null);
  const [autoAI, setAutoAI] = useState<boolean>(true);

  const [ocrLang, setOcrLang] = useState<'auto' | 'tha' | 'eng' | 'tha+eng'>('auto');

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
        if (window.cv.onRuntimeInitialized) window.cv.onRuntimeInitialized = () => setCvReady(true);
        setCvReady(true);
        clearInterval(interval);
      }
    };
    interval = setInterval(check, 200);
    return () => clearInterval(interval);
  }, []);

  /* ---------- Tesseract workers ---------- */
  const workersRef = useRef<Record<string, Promise<any>>>({ });
  const getWorker = useCallback((lang: 'tha' | 'eng' | 'tha+eng') => {
    if (!workersRef.current[lang]) {
      workersRef.current[lang] = createWorker(
        lang,
        undefined,
        {
          logger: (m) => { if (m.status === 'recognizing text') setStatus({ stage: 'ocr', progress: m.progress ?? 0 }); },
          workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        }
      );
    }
    return workersRef.current[lang];
  }, []);

  /* ---------- Drag/Drop ---------- */
  const reset = () => {
    setImageURL(null); setProcessedURL(null); setText('');
    setSections([]); setDocFields(null); setLineItems([]);
    setStatus({ stage: 'idle', progress: 0 });
  };
  const onPickFile = () => inputRef.current?.click();
  const onFile = useCallback((file: File) => { if (file) setImageURL(URL.createObjectURL(file)); }, []);
  const onDrag = {
    over: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(true); },
    enter: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(true); },
    leave: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); },
    drop: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); },
  };

  /* ---------- helpers ---------- */
  const urlToDataURL = useCallback(async (url: string): Promise<string> => {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject; reader.readAsDataURL(blob);
    });
  }, []);

  const tidyText = useCallback((s: string) => {
    s = (s || '').normalize('NFC').replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ').replace(/[ \t]{2,}/g, ' ');
    const lines = s.split(/\r?\n/).map(l => l.trim());
    const merged: string[] = [];
    for (const l of lines) {
      const isBullet = /^[-•▪■●○]|^\d+\)|^\(?\d+\)|^[A-Za-z]\)/.test(l);
      const isHeading = /^(เกี่ยวกับฉัน|ติดต่อ|ประสบการณ์|ประวัติการศึกษา|ทักษะ|ภาษา|รางวัล|SUMMARY|EXPERIENCE|EDUCATION|SKILLS|AWARDS|CONTACT|PROFILE|RESUME|INVOICE|RECEIPT|BILL|ISSUED TO|PAY TO|TOTAL|SUBTOTAL|ส่วนราชการ|เรื่อง|สิ่งที่ส่งมาด้วย|เรียน|ลงชื่อ|วันที่|ที่)\b/i.test(l);
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
  }, []);

  const compressDataURL = useCallback(async (d: string, maxBytes = 950_000) => {
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

  /* ---------- Cloud OCR ---------- */
  const toOcrSpaceLang = (l: 'auto' | 'tha' | 'eng' | 'tha+eng') => (l === 'auto' ? 'tha,eng' : l.replace('+', ','));
  const cloudOCR = useCallback(async (processedDataURL: string) => {
    setStatus({ stage: 'ocr', progress: 0.01, message: t('reading') });
    let payload = await compressDataURL(processedDataURL, 950_000);
    if (dataURLBytes(payload) < 20_000 && imageURL) {
      const raw = await urlToDataURL(imageURL);
      payload = await compressDataURL(raw, 950_000);
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
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || `OCR API ${res.status}`);
      let json: any; try { json = JSON.parse(raw); } catch { throw new Error(raw); }
      return json.text as string;
    } finally { clearTimeout(timeoutId); }
  }, [compressDataURL, imageURL, urlToDataURL, ocrLang, t]);

  /* ---------- client refine fallback ---------- */
  const clientRefine = useCallback((raw: string) => {
    const cleaned = tidyText(raw);
    const inv = parseInvoice(cleaned);
    const sp  = smartParse(cleaned, { lang: 'auto' });

    const invoiceLike =
      inv.lineItems.length > 0 || !!inv.fields.total?.value || !!inv.fields.docNo || /INVOICE|RECEIPT/i.test(cleaned);
    if (invoiceLike) {
      return {
        from: 'client-invoice',
        cleanText: cleaned,
        fields: { ...inv.fields, docType: 'invoice' as const },
        lineItems: inv.lineItems,
        sections: [], // เราสร้าง section ภายนอกอยู่แล้ว
      };
    }

    const memoLike = sp?.fields?.docType === 'thai_memo' || looksLikeThaiMemoClient(cleaned);
    if (memoLike) {
      const memo = parseThaiMemo(cleaned);
      return {
        from: 'client-thai-memo',
        cleanText: cleaned,
        fields: { ...(sp.fields || {}), ...(memo.fields || {}), docType: 'thai_memo' as const },
        lineItems: [],
        sections: memo.sections || [],
      };
    }

    return {
      from: 'client-generic',
      cleanText: cleaned,
      fields: { ...(sp.fields || {}), docType: (sp.fields?.docType as any) || 'generic' },
      lineItems: sp.lineItems || [],
      sections: sp.sections || [],
    };
  }, [tidyText]);

  /* ---------- AI refine (auto/manual) ---------- */
  const aiRefineCall = useCallback(async (inputText: string) => {
    if (!inputText?.trim()) return;

    // absolute URL กัน basePath/proxy
    const endpoint = (typeof window !== 'undefined')
      ? new URL('/api/ai-refine', window.location.origin).toString()
      : '/api/ai-refine';

    try {
      setStatus({ stage: 'ocr', progress: 0.01, message: t('reading') });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ text: inputText }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const raw = await res.text();
      if (!res.ok) throw new Error(raw || `AI refine error: ${res.status}`);
      let json: any; try { json = JSON.parse(raw); } catch { throw new Error(raw || 'bad JSON'); }
      if (!json.ok) throw new Error(json.error || 'AI refine failed');

      setText(json.cleanText ?? inputText);

      if (Array.isArray(json.sections)) setSections(json.sections);
      if (json.fields) setDocFields(prev => ({ ...(prev || { docType: 'generic' }), ...json.fields }));
      if (Array.isArray(json.lineItems)) setLineItems(json.lineItems);

      setStatus({ stage: 'done', progress: 1 });
      setToast({ type: 'success', message: `${t('toastRefined')} (${json.from || 'local'})` });
      setTimeout(() => setToast(null), 2000);
    } catch (e: any) {
      // ⬇️ fallback ในเครื่องทันที (ไม่พึ่ง API)
      const local = clientRefine(inputText);
      setText(local.cleanText);
      setSections(local.sections);
      setDocFields(prev => ({ ...(prev || { docType: 'generic' }), ...local.fields }));
      setLineItems(local.lineItems);
      setStatus({ stage: 'done', progress: 1 });
      setToast({ type: 'info', message: `ใช้โหมดสำรองในเครื่อง (${local.from})` });
      setTimeout(() => setToast(null), 2500);
    }
  }, [clientRefine, t]);

  /* ---------- Build sections for Invoice ---------- */
  const buildInvoiceSections = useCallback((inv: ReturnType<typeof parseInvoice>, lang: Lang) => {
    const L = DICT[lang];
    const s: { heading: string; content: string[] }[] = [];
    const meta: string[] = [];
    if (inv.fields.docNo) meta.push(`${L.docNo}: ${inv.fields.docNo}`);
    if (inv.fields.date)  meta.push(`${L.date}: ${inv.fields.date}`);
    if (inv.fields.dueDate) meta.push(`${L.dueDate}: ${inv.fields.dueDate}`);
    if (meta.length) s.push({ heading: L.invoiceMeta, content: meta });

    if (inv.lineItems?.length) {
      const items = inv.lineItems.map(li =>
        `${li.description || ''} · ${L.subtotal}: ${fmtNum(li.amount ?? li.unitPrice ?? '')}`
      );
      s.push({ heading: L.lineItems, content: items });
    }

    const totals: string[] = [];
    if (inv.fields.subtotal?.text) totals.push(`${L.subtotal}: ${inv.fields.subtotal.text}`);
    if (inv.fields.vat?.text)      totals.push(`${L.vat}: ${inv.fields.vat.text}`);
    if (inv.fields.total?.text)    totals.push(`${L.total}: ${inv.fields.total.text}`);
    if (totals.length) s.push({ heading: L.totals, content: totals });

    return s;
  }, []);

  /* ---------- OCR Pipeline ---------- */
  const runPipeline = useCallback(async () => {
    if (!imageURL || !cvReady) return;
    try {
      setStatus({ stage: 'preprocess', progress: 0.05, message: t('preparing') });

      const img = new Image(); img.src = imageURL;
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load image failed')); });

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error('2D canvas context not available');

      const scale = Math.min(1200 / img.width, 1200 / img.height, 1);
      const w = Math.round(img.width * scale); const h = Math.round(img.height * scale);
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);

      const cv = (window as any).cv;
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

      const gray0 = new cv.Mat(); cv.cvtColor(warped, gray0, cv.COLOR_RGBA2GRAY, 0);
      const up = new cv.Mat(); cv.resize(gray0, up, new cv.Size(0, 0), 2, 2, cv.INTER_CUBIC);
      const den = new cv.Mat(); cv.bilateralFilter(up, den, 9, 75, 75);
      const bin = new cv.Mat(); cv.threshold(den, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.imshow(canvas, bin);

      src.delete(); gray.delete(); blur.delete(); edged.delete();
      contours.delete(); hierarchy.delete(); if (approxCandidate) approxCandidate.delete();
      warped.delete(); gray0.delete(); up.delete(); den.delete(); bin.delete();

      const processed = canvas.toDataURL('image/png');
      setProcessedURL(processed);
      setStatus({ stage: 'ocr', progress: 0.0, message: t('reading') });

      const tesseractLang: 'tha' | 'eng' | 'tha+eng' = ocrLang === 'auto' ? 'tha+eng' : ocrLang;
      const worker = await getWorker(tesseractLang);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN, user_defined_dpi: '300', preserve_interword_spaces: '0' });
      if (tesseractLang === 'eng') {
        await worker.setParameters({ tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-–—.,:;!?()[]{}\'"@/&%+*#_$ ' });
      }
      const { data } = await worker.recognize(processed);
      let out = data.text ?? '';

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
        } catch { /* ignore */ }
      }

      const cleaned = tidyText(out);
      setText(cleaned);

      // local structure ก่อน
      const inv = parseInvoice(cleaned);
      const sp  = smartParse(cleaned, { lang: ocrLang === 'eng' ? 'eng' : ocrLang === 'tha' ? 'tha' : 'auto' });

      const looksLikeInvoiceNow =
        inv.lineItems.length > 0 || !!inv.fields.total?.value || !!inv.fields.docNo || /INVOICE|RECEIPT/i.test(cleaned);
      const looksLikeThaiMemoNow =
        sp?.fields?.docType === 'thai_memo' || looksLikeThaiMemoClient(cleaned);

      let finalFields: SmartFields = sp.fields;
      let finalLineItems: SmartLineItem[] = sp.lineItems ?? [];
      let finalSections: { heading: string; content: string[] }[] = sp.sections ?? [];

      if (looksLikeInvoiceNow) {
        finalFields = { ...inv.fields, docType: 'invoice' as const };
        finalLineItems = inv.lineItems;
        finalSections = buildInvoiceSections(inv, uiLang);
      } else if (looksLikeThaiMemoNow) {
        const memo = parseThaiMemo(cleaned);
        finalFields = { ...(sp.fields || {}), ...(memo.fields || {}), docType: 'thai_memo' as const };
        finalSections = memo.sections || [];
        finalLineItems = [];
      }

      setSections(finalSections);
      setDocFields(finalFields);
      setLineItems(finalLineItems);

      setStatus({ stage: 'done', progress: 1 });
      setToast({ type: 'success', message: t('toastDone') });
      setTimeout(() => setToast(null), 2200);

      // Auto AI refine — ถ้า endpoint ล่ม จะ fallback ใน catch
      if (autoAI) aiRefineCall(cleaned);
    } catch (err: any) {
      setStatus({ stage: 'error', progress: 0, message: String(err?.message || err) });
      setToast({ type: 'error', message: `${t('error')}: ${String(err?.message || err)}` });
      setTimeout(() => setToast(null), 3400);
    }
  }, [imageURL, cvReady, ocrLang, getWorker, cloudOCR, urlToDataURL, tidyText, t, buildInvoiceSections, uiLang, autoAI, aiRefineCall]);

  useEffect(() => { if (imageURL && cvReady) runPipeline(); }, [imageURL, cvReady, runPipeline]);

  /* ---------- Download JSON ---------- */
  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify({ text, fields: docFields, lineItems, sections }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ocr_result.json'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <main className="container">
      {/* Header */}
      <header className="app-header">
        <div className="inner">
          <div className="logo">{APP_NAME}</div>
          <div className="small muted">{t('appTag')}</div>
          <div className="grow" />

          {/* UI language toggle */}
          <label className="flex flex-center small muted" style={{ gap: 8 }}>
            TH / EN
            <span className="switch" data-on="green" title="สลับภาษา UI">
              <input
                type="checkbox"
                checked={uiLang === 'en'}
                onChange={(e) => setUiLang(e.target.checked ? 'en' : 'th')}
              />
              <span className="dot" />
              <span className="track" />
            </span>
          </label>

          <button className="btn btn-outline btn-sm" onClick={downloadJSON} disabled={!text}>
            <Download size={16}/> {t('downloadJSON')}
          </button>
        </div>
      </header>

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type === 'success' ? 'success' : toast.type === 'error' ? 'error' : ''}`}>
          <Wand2 size={16} /> <div>{toast.message}</div>
        </div>
      )}

      {/* Dropzone */}
      <section
        className={`dropzone ${dragOver ? 'is-dragover' : ''} mt-6`}
        onDragOver={onDrag.over} onDragEnter={onDrag.enter} onDragLeave={onDrag.leave} onDrop={onDrag.drop}
      >
        <div className="stack">
          <div className="flex flex-center">
            <div className="badge"><ScanLine size={16}/> {t('uploadBadge')}</div>
          </div>
          <div className="muted">{t('dragHere')}</div>
          <div>
            <button className="btn btn-primary" onClick={onPickFile}>{t('chooseFile')}</button>
            <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hide"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          </div>
          <div className="small muted">{t('formats')}</div>
        </div>
      </section>

      {/* Two-column layout */}
      <section className="layout mt-6">
        {/* Left: Images */}
        <div className="stack">
          <div className="card">
            <div className="card-header"><div className="card-title flex flex-center"><ImageIcon size={18}/> {t('originalImage')}</div></div>
            <div className="card-body">
              <div className="media-box" style={{minHeight: 240}}>
                {imageURL ? <img src={imageURL} alt="original" /> : <div className="small muted p-4">—</div>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">{t('processedImage')}</div></div>
            <div className="card-body">
              <div className="media-box" style={{minHeight: 240}}>
                <canvas ref={canvasRef} style={{width: '100%'}} />
              </div>
              <div className="flex mt-4">
                <button onClick={reset} className="btn btn-outline"> {t('reset')} </button>
                <button onClick={runPipeline} className="btn btn-primary" disabled={!imageURL || !cvReady}>{t('reprocess')}</button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Results */}
        <div className="stack">
          <div className="card">
            {/* Header with controls */}
            <div className="card-header">
              <div className="card-title">{t('resultsTitle')}</div>
              <div className="flex flex-center">
                <span className="small muted">{t('docLang')}</span>
                <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value as any)} className="select" style={{width:160}}>
                  <option value="auto">Auto</option>
                  <option value="tha">ไทย (Thai)</option>
                  <option value="eng">English (Eng)</option>
                  <option value="tha+eng">ไทย+อังกฤษ</option>
                </select>

                {/* Auto AI toggle */}
                <label className="flex flex-center small muted" style={{ gap: 8 }}>
                  {t('autoAI')}
                  <span className="switch" data-on="blue" title="ปรับภาษา/จัดหัวข้ออัตโนมัติหลัง OCR">
                    <input type="checkbox" checked={autoAI} onChange={(e) => setAutoAI(e.target.checked)} />
                    <span className="dot" />
                    <span className="track" />
                  </span>
                </label>

              {!autoAI && (
                <button
                  className="btn btn-primary"
                  onClick={() => aiRefineCall(text)}   
                  disabled={!text}
                  title="Refine with AI"
                >
                  <Wand2 size={16}/> {t('tryAI')}
                </button>
              )}
              </div>
            </div>

            <div className="card-body">
              {/* Status at very top of results */}
              <div className={`status ${status.stage ? `status--${status.stage}` : ''}`} style={{marginTop: 0}}>
                <span className="dot" />
                <span className="label">
                  {t('status')}:&nbsp;
                  {status.stage === 'idle' && t('waiting')}
                  {status.stage === 'preprocess' && t('preparing')}
                  {status.stage === 'ocr' && (status.message || t('reading'))}
                  {status.stage === 'done' && t('done')}
                  {status.stage === 'error' && `${t('error')}: ${status.message}`}
                </span>
                {(status.stage === 'preprocess' || status.stage === 'ocr') && (
                  <>
                    <div className="progress-inline"><span style={{ width: `${Math.round((status.progress || 0) * 100)}%` }} /></div>
                    <span className="pct">{Math.round((status.progress || 0) * 100)}%</span>
                  </>
                )}
              </div>

              {/* Smart summary */}
              {docFields && (
                <div className="alert mt-4">
                  <div className="stack">
                    <div className="title">{t('summary')}</div>

                    {/* Thai memo fields */}
                    {docFields.docType === 'thai_memo' && (
                      <>
                        {docFields.agency   && <div className="small"><b>{t('agency')}:</b> {docFields.agency}</div>}
                        {docFields.refNo    && <div className="small"><b>{t('refNo')}:</b> {docFields.refNo}</div>}
                        {docFields.date     && <div className="small"><b>{t('date')}:</b> {docFields.date}</div>}
                        {docFields.title    && <div className="small"><b>{t('memoTitle')}:</b> {docFields.title}</div>}
                        {docFields.to       && <div className="small"><b>{t('to')}:</b> {docFields.to}</div>}
                        {docFields.signer   && <div className="small"><b>{t('signer')}:</b> {docFields.signer}</div>}
                        {docFields.position && <div className="small"><b>{t('position')}:</b> {docFields.position}</div>}
                      </>
                    )}

                    {/* Generic/Resume fields */}
                    {docFields.docType !== 'thai_memo' && (
                      <>
                        {docFields.name   && <div className="small"><b>{t('name')}:</b> {docFields.name}</div>}
                        {docFields.title  && <div className="small"><b>{t('title')}:</b> {docFields.title}</div>}
                      </>
                    )}

                    {/* Always show docType */}
                    {docFields.docType && <div className="small"><b>{t('docType')}:</b> {docFields.docType}</div>}

                    {/* Invoice-only fields */}
                    {docFields.docType === 'invoice' && (
                      <>
                        {docFields.docNo  && <div className="small"><b>{t('docNo')}:</b> {docFields.docNo}</div>}
                        {docFields.date   && <div className="small"><b>{t('date')}:</b> {docFields.date}</div>}
                        {docFields.dueDate&& <div className="small"><b>{t('dueDate')}:</b> {docFields.dueDate}</div>}
                        {(docFields.seller || docFields.buyer) && (
                          <>
                            {docFields.seller && <div className="small"><b>{t('seller')}:</b> {docFields.seller}</div>}
                            {docFields.buyer && <div className="small"><b>{t('buyer')}:</b> {docFields.buyer}</div>}
                          </>
                        )}
                        {(docFields.subtotal || docFields.vat || docFields.total) && (
                          <>
                            {docFields.subtotal?.text && <div className="small"><b>{t('subtotal')}:</b> {docFields.subtotal.text}</div>}
                            {docFields.vat?.text      && <div className="small"><b>{t('vat')}:</b> {docFields.vat.text}</div>}
                            {docFields.total?.text    && <div className="small"><b>{t('total')}:</b> {docFields.total.text}</div>}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Line items (if any) */}
              {lineItems?.length ? (
                <div className="mt-4">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('lineItems')}</th>
                        <th className="num">{uiLang === 'th' ? 'จำนวน' : 'Qty'}</th>
                        <th className="num">{uiLang === 'th' ? 'ราคาต่อหน่วย' : 'Unit price'}</th>
                        <th className="num">{uiLang === 'th' ? 'เป็นเงิน' : 'Amount'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((it, i) => (
                        <tr key={i}>
                          <td>{it.description}</td>
                          <td className="num">{it.qty ?? ''}</td>
                          <td className="num">{it.unitPrice ?? ''}</td>
                          <td className="num">{it.amount ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* Raw text + sections */}
              <div className="grid-2 mt-6">
                <div>
                  <h3 className="small muted">{t('rawText')}</h3>
                  <div className="json-viewer mt-2"><pre><code>{text || '—'}</code></pre></div>
                </div>
                <div>
                  <h3 className="small muted">{t('sections')}</h3>
                  <div className="stack mt-2">
                    {sections.length ? sections.map((s, i) => (
                      <div key={i} className="card">
                        <div className="card-header"><div className="card-title">{s.heading}</div></div>
                        <div className="card-body">
                          {s.content.length ? (
                            <ul className="stack" style={{paddingLeft: '1rem', listStyle: 'disc'}}>
                              {s.content.map((c, ci) => (<li key={ci} className="small">{c}</li>))}
                            </ul>
                          ) : <div className="small muted">—</div>}
                        </div>
                      </div>
                    )) : <div className="small muted">—</div>}
                  </div>
                </div>
              </div>
            </div>

            <div className="card-footer small muted">
              OpenCV.js + Tesseract.js — runs fully in your browser
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
