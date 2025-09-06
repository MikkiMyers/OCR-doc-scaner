'use client';
import './styles/app.minimal.pro.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image as ImageIcon, ScanLine, Wand2 } from 'lucide-react';
import { createWorker, PSM } from 'tesseract.js';

import Spinner from '@/components/Spinner';
import { smartParse, SmartFields, LineItem as SmartLineItem } from '@/lib/smartParser';
import { parseInvoice } from '@/lib/invoiceParser';

declare global { interface Window { cv: any } }

type OCRState = 'idle' | 'preprocess' | 'ocr' | 'done' | 'error';
type OCRProgress = { stage: OCRState; progress: number; message?: string };

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'DocScan OCR';
const PROVIDER = (process.env.NEXT_PUBLIC_AI_PROVIDER || 'local').toLowerCase(); // 'local' | 'cloud' | 'off'
const DEFAULT_AUTO_AI = PROVIDER !== 'off';

/* ---------------- utilities ---------------- */
const dataURLBytes = (d: string) => {
  const i = d.indexOf(','); const b64 = i >= 0 ? d.slice(i + 1) : d;
  return Math.ceil((b64.length * 3) / 4);
};
const loadImageFromDataURL = (d: string) =>
  new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = d; });

/* --- looksLikeInvoice + sectionizer (fallback เมื่อไม่กด AI) --- */
const looksLikeInvoice = (text: string) => {
  const t = text || '';
  const must = /INVOICE\b/i.test(t);
  const cols = /(DESCRIPTION).*(UNIT PRICE).*(QTY|QUANTITY).*(TOTAL|AMOUNT)/i.test(t);
  const money = /\bSUBTOTAL\b|\bTOTAL\b|\bTAX\b|\bVAT\b/i.test(t);
  const meta = /(INVOICE\s*(NO|#)|DUE\s*DATE|INVOICE\s*DATE|P\.?O\.?#?)/i.test(t);
  return must && (cols || money || meta);
};
const sectionizeInvoice = (text: string) => {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim());
  const out: { heading: string; content: string[] }[] = [];
  const idx = (re: RegExp) => lines.findIndex(l => re.test(l));
  const iIssued = idx(/\b(ISSUED TO|BILL TO)\b/i);
  const iPay    = idx(/\b(PAY TO|SHIP TO)\b/i);
  const iMeta   = idx(/\b(INVOICE\s*(NO|#)|INVOICE\s*DATE|DUE\s*DATE|P\.?O\.?#?)\b/i);
  const iTable  = idx(/(DESCRIPTION).*(UNIT PRICE).*(QTY|QUANTITY).*(TOTAL|AMOUNT)/i);
  const iSub    = idx(/\bSUBTOTAL\b/i);
  const iTotal  = idx(/^\s*(TOTAL|Grand Total)\b/i);

  const take = (from: number, until: number) =>
    (from >= 0 ? lines.slice(from + 1, (until >= 0 ? until : lines.length)).filter(Boolean) : []);

  if (iMeta >= 0) out.push({ heading: 'Invoice Meta', content: [lines[iMeta]] });
  if (iIssued >= 0) {
    const until = Math.min(...[iPay, iTable, iSub, iTotal].map(x => (x >= 0 ? x : 1e9)));
    out.push({ heading: lines[iIssued], content: take(iIssued, until) });
  }
  if (iPay >= 0) {
    const until = Math.min(...[iTable, iSub, iTotal].map(x => (x >= 0 ? x : 1e9)));
    out.push({ heading: lines[iPay], content: take(iPay, until) });
  }
  if (iTable >= 0) {
    const until = Math.min(...[iSub, iTotal].map(x => (x >= 0 ? x : 1e9)));
    out.push({ heading: 'Line Items', content: [lines[iTable], ...lines.slice(iTable + 1, until).filter(Boolean)] });
  }
  if (iSub >= 0 || iTotal >= 0) {
    const start = (iSub >= 0 ? iSub : iTotal);
    out.push({ heading: 'Totals', content: lines.slice(start).filter(l => /\b(SUBTOTAL|TOTAL|TAX|VAT)\b/i.test(l)) });
  }
  if (!out.length) out.push({ heading: 'Invoice', content: lines.filter(Boolean) });
  return out;
};

export default function Page() {
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [processedURL, setProcessedURL] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const [status, setStatus] = useState<OCRProgress>({ stage: 'idle', progress: 0 });
  const [cvReady, setCvReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<{ type: 'success'|'error'|'info', message: string }|null>(null);

  const [ocrLang, setOcrLang] = useState<'auto' | 'tha' | 'eng' | 'tha+eng'>('auto');
  const [autoAI, setAutoAI] = useState<boolean>(DEFAULT_AUTO_AI);

  const [sections, setSections] = useState<{ heading: string; content: string[] }[]>([]);
  const [docFields, setDocFields] = useState<SmartFields | null>(null);
  const [lineItems, setLineItems] = useState<SmartLineItem[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // เพื่อกัน refine ซ้ำ ๆ บนข้อความเดียว
  const lastRefinedSigRef = useRef<string>('');

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
  const workersRef = useRef<Record<string, Promise<any>>>({});
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

  /* ---------- Helpers ---------- */
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
      const isHeading = /^(เกี่ยวกับฉัน|ติดต่อ|ประสบการณ์|ประสบการณ์การทำงาน|ประวัติการศึกษา|ทักษะ|ภาษา|รางวัล|SUMMARY|EXPERIENCE|EDUCATION|SKILLS|AWARDS|CONTACT|PROFILE|INVOICE|RECEIPT|BILL)\b/i.test(l);
      if (!l) { merged.push(''); continue; }
      if (isBullet || isHeading) { merged.push(l); continue; }
      if (!merged.length || merged[merged.length - 1] === '') merged.push(l);
      else merged[merged.length - 1] += ' ' + l;
    }
    s = merged.join('\n');
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

  /* ---------- Cloud OCR (OCR.space) ---------- */
  const toOcrSpaceLang = (l: 'auto' | 'tha' | 'eng' | 'tha+eng') => (l === 'auto' ? 'tha,eng' : l.replace('+', ','));
  const cloudOCR = useCallback(async (processedDataURL: string) => {
    setStatus({ stage: 'ocr', progress: 0.01, message: 'กำลังส่งให้โมเดล AI...' });
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
  }, [compressDataURL, imageURL, urlToDataURL, ocrLang]);

  /* ---------- AI refine (ปรับภาษา/จัดหัวข้อ) ---------- */
  const aiRefineCall = useCallback(async (srcText: string, showToast = true) => {
    if (!srcText?.trim()) return false;
    try {
      const sig = srcText.slice(0, 200) + '|' + srcText.length;
      if (lastRefinedSigRef.current === sig) return true;

      setStatus({ stage: 'ocr', progress: 0.02, message: 'กำลังปรับปรุงข้อความ…' });
      const res = await fetch('/api/ai-refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: srcText }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || `AI refine error: ${res.status}`);
      let json: any; try { json = JSON.parse(raw); } catch { throw new Error(raw || 'bad JSON'); }
      if (!json.ok) throw new Error(json.error || 'AI refine failed');

      setText(json.cleanText ?? srcText);
      if (Array.isArray(json.sections)) setSections(json.sections);
      if (json.fields) setDocFields(prev => ({ ...(prev || { docType: 'generic' }), ...json.fields }));
      if (Array.isArray(json.lineItems)) setLineItems(json.lineItems);

      setStatus({ stage: 'done', progress: 1 });
      if (showToast) { setToast({ type: 'success', message: `ปรับภาษา/จัดหัวข้อสำเร็จ (${json.from || 'local'})` }); setTimeout(() => setToast(null), 2000); }
      lastRefinedSigRef.current = sig;
      return true;
    } catch (e: any) {
      if (showToast) { setToast({ type: 'error', message: `AI refine ล้มเหลว: ${String(e?.message || e)}` }); setTimeout(() => setToast(null), 3200); }
      setStatus({ stage: 'error', progress: 0, message: String(e?.message || e) });
      return false;
    }
  }, []);

  /* ---------- OCR Pipeline ---------- */
  const runPipeline = useCallback(async () => {
    if (!imageURL || !cvReady) return;
    try {
      setStatus({ stage: 'preprocess', progress: 0.05, message: 'กำลังเตรียมภาพ...' });

      const img = new Image(); img.src = imageURL;
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('โหลดรูปไม่สำเร็จ')); });

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
      setStatus({ stage: 'ocr', progress: 0.0, message: 'กำลังอ่านตัวอักษร...' });

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
        } catch (e) { console.warn('Cloud OCR fallback failed:', e); }
      }

      const cleaned = tidyText(out);
      setText(cleaned);

      // ----- Non-AI structuring (ดีขึ้นกว่าเดิม)
      const inv = parseInvoice(cleaned);
      const langForSmart: 'auto' | 'tha' | 'eng' = ocrLang === 'eng' ? 'eng' : ocrLang === 'tha' ? 'tha' : 'auto';
      const sp = smartParse(cleaned, { lang: langForSmart });

      const isInvoice = looksLikeInvoice(cleaned) || inv.lineItems.length > 0 || !!inv.fields.total?.value || /INVOICE|RECEIPT/i.test(cleaned);
      const finalFields: SmartFields = isInvoice ? inv.fields : sp.fields;
      const finalLineItems: SmartLineItem[] = isInvoice ? inv.lineItems : (sp.lineItems ?? []);
      setDocFields(finalFields);
      setLineItems(finalLineItems);
      setSections(isInvoice ? sectionizeInvoice(cleaned) : (sp.sections ?? []));

      setStatus({ stage: 'done', progress: 1 });
      setToast({ type: 'success', message: 'ประมวลผลเสร็จแล้ว' });
      setTimeout(() => setToast(null), 2200);

      // ----- Auto AI refine (ถ้าเปิด)
      if (autoAI) { await aiRefineCall(cleaned, false); }
    } catch (err: any) {
      console.error(err);
      setStatus({ stage: 'error', progress: 0, message: (err as Error).message });
      setToast({ type: 'error', message: `ผิดพลาด: ${String(err?.message || err)}` });
      setTimeout(() => setToast(null), 3200);
    }
  }, [imageURL, cvReady, ocrLang, getWorker, cloudOCR, urlToDataURL, tidyText, autoAI, aiRefineCall]);

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
          <div className="small muted">ไทย/อังกฤษ · OpenCV + Tesseract · Smart Parser</div>
          <div className="grow" />
          <div className="small muted" title={`AI provider: ${PROVIDER}`}>AI: <b>{PROVIDER}</b></div>
          <button className="btn btn-outline btn-sm" onClick={downloadJSON} disabled={!text}>
            <Download size={16}/> ดาวน์โหลด JSON
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
            <div className="badge"><ScanLine size={16}/> อัปโหลดเอกสาร</div>
          </div>
          <div className="muted">ลากไฟล์มาวางที่นี่ หรือ</div>
          <div>
            <button className="btn btn-primary" onClick={onPickFile}>เลือกไฟล์</button>
            <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hide"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          </div>
          <div className="small muted">รองรับ .jpg / .png ขนาดไม่เกิน ~10MB</div>
        </div>
      </section>

      {/* Two-column layout */}
      <section className="layout mt-6">
        {/* Left: Images */}
        <div className="stack">
          <div className="card">
            <div className="card-header"><div className="card-title flex flex-center"><ImageIcon size={18}/> ภาพต้นฉบับ</div></div>
            <div className="card-body">
              <div className="media-box" style={{minHeight: 240}}>
                {imageURL ? <img src={imageURL} alt="original" /> : <div className="small muted p-4">ยังไม่เลือกรูป</div>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">ภาพหลังปรับ (สำหรับ OCR)</div></div>
            <div className="card-body">
              <div className="media-box" style={{minHeight: 240}}>
                <canvas ref={canvasRef} style={{width: '100%'}} />
              </div>
              <div className="flex mt-4">
                <button onClick={reset} className="btn btn-outline">ล้างค่า</button>
                <button onClick={runPipeline} className="btn btn-primary" disabled={!imageURL || !cvReady}>ประมวลผลอีกครั้ง</button>
              </div>
              {/* Status */}
              <div className={`status mt-3 status--${status.stage}`}>
                <span className="dot" />
                <span className="label">
                  {status.stage === 'idle' && 'รออัปโหลด'}
                  {status.stage === 'preprocess' && 'กำลังเตรียมภาพ'}
                  {status.stage === 'ocr' && (status.message || 'กำลังอ่านตัวอักษร…')}
                  {status.stage === 'done' && 'เสร็จสมบูรณ์'}
                  {status.stage === 'error' && `ผิดพลาด: ${status.message}`}
                </span>
                {(status.stage === 'preprocess' || status.stage === 'ocr') && (
                  <>
                    <div className="progress-inline"><span style={{ width: `${Math.round((status.progress || 0) * 100)}%` }} /></div>
                    <span className="pct">{Math.round((status.progress || 0) * 100)}%</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Results */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <div className="card-title">ผลลัพธ์ OCR</div>
              <div className="flex flex-center">
                <span className="small muted">ภาษาเอกสาร</span>
                <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value as any)} className="select" style={{width:160}}>
                  <option value="auto">Auto</option>
                  <option value="tha">ไทย (tha)</option>
                  <option value="eng">อังกฤษ (eng)</option>
                  <option value="tha+eng">ไทย+อังกฤษ</option>
                </select>

                {/* Auto AI toggle */}
                <label className="flex flex-center small muted" style={{gap:8}}>
                  Auto AI
                  <span className="switch">
                    <input type="checkbox" checked={autoAI} onChange={(e) => setAutoAI(e.target.checked)} />
                    <span className="dot" /><span className="track" />
                  </span>
                </label>

                {/* ปุ่ม ลอง AI */}
                <button className="btn btn-primary" onClick={() => aiRefineCall(text, true)} disabled={!text} title="ปรับภาษา/จัดหัวข้อจากผล OCR">
                  <Wand2 size={16}/> ลอง AI
                </button>
              </div>
            </div>

            <div className="card-body">
              {/* Smart summary */}
              {docFields && (
                <div className="alert">
                  <div className="stack">
                    <div className="title">สรุปเอกสาร (Smart Parser / AI)</div>
                    {docFields.name && <div className="small"><b>ชื่อ:</b> {docFields.name}</div>}
                    {docFields.title && <div className="small"><b>ตำแหน่ง:</b> {docFields.title}</div>}
                    {docFields.docType && <div className="small"><b>ชนิดเอกสาร:</b> {docFields.docType}</div>}
                    {docFields.docNo && <div className="small"><b>เลขที่:</b> {docFields.docNo}</div>}
                    {docFields.date && <div className="small"><b>วันที่:</b> {docFields.date}</div>}
                    {docFields.dueDate && <div className="small"><b>กำหนดชำระ:</b> {docFields.dueDate}</div>}
                    {(docFields.seller || docFields.buyer) && (
                      <>
                        {docFields.seller && <div className="small"><b>ผู้ขาย/ผู้ให้บริการ:</b> {docFields.seller}</div>}
                        {docFields.buyer && <div className="small"><b>ผู้ซื้อ/ลูกค้า:</b> {docFields.buyer}</div>}
                      </>
                    )}
                    {(docFields.subtotal || docFields.vat || docFields.total) && (
                      <>
                        {docFields.subtotal?.text && <div className="small"><b>Subtotal:</b> {docFields.subtotal.text}</div>}
                        {docFields.vat?.text && <div className="small"><b>VAT/Tax:</b> {docFields.vat.text}</div>}
                        {docFields.total?.text && <div className="small"><b>Total:</b> {docFields.total.text}</div>}
                      </>
                    )}
                  </div>
                </div>
              )}

              {lineItems?.length ? (
                <div className="mt-4">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>รายการ</th>
                        <th className="num">จำนวน</th>
                        <th className="num">ราคาต่อหน่วย</th>
                        <th className="num">เป็นเงิน</th>
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
                  <h3 className="small muted">ข้อความดิบ</h3>
                  <div className="json-viewer mt-2"><pre><code>{text || '—'}</code></pre></div>
                </div>
                <div>
                  <h3 className="small muted">แยกเป็นหัวข้อ (heuristic/AI)</h3>
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
              ใช้ OpenCV.js + Tesseract.js — ประมวลผลบนเบราว์เซอร์ทั้งหมด
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
