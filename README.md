# DocScan OCR (tha+eng)
แอปสแกนเอกสารเล็กๆ ที่ทำสองอย่างให้ครบจบในหน้าเดียว: **จัดระนาบภาพด้วย OpenCV.js** แล้ว **อ่านตัวอักษรด้วย Tesseract.js** (ไทย/อังกฤษ) พร้อมตัวช่วยแยกหัวข้อ/สรุปข้อความแบบ heuristic สำหรับเอกสารทั่วไป ใส่ใจเรื่อง privacy (ทำงานฝั่ง client เป็นหลัก)

> Live demo: https://ocr-doc-scaner-qntt.vercel.app/

---

## ไฮไลต์
- **สแกนเอกสารอัตโนมัติ**: หาขอบ + perspective transform ให้ภาพตรง
- **ปรับภาพก่อน OCR**: adaptive threshold, ลด noise เพื่อความแม่นยำ
- **OCR ภาษาไทย + อังกฤษ**: ใช้ **Tesseract.js v5** (PSM `SINGLE_COLUMN`)
- **สำรองทางเลือก**: มี API `/api/ocrspace` ต่อกับ OCR.Space (เผื่อเคสที่ Tesseract ลำบาก)
- **Smart Parser (ไม่พึ่งโมเดลนอก)**: แยกหัวข้อ, สกัดฟิลด์พื้นฐาน (เลขที่เอกสาร/วันที่/ยอดเงิน ฯลฯ),
  รองรับเอกสารราชการแบบ **บันทึกข้อความ** และใบแจ้งหนี้เบื้องต้น
- **ทั้งหมดทำงานบนเบราว์เซอร์**: ปลอดภัยระดับหนึ่งสำหรับงานเดโม/ทดสอบ (ไม่มีการส่งไฟล์ออก เว้นแต่เรียก OCR.Space เอง)

---

## Tech Stack
- **Next.js 14 (App Router)**, **React 18**, **TypeScript**, **Tailwind CSS**
- **OpenCV.js** (โหลดจาก CDN) สำหรับ crop/warp/threshold
- **Tesseract.js v5** สำหรับ OCR ไทย/อังกฤษ
- **lucide-react** ไอคอน

---

## สถาปัตยกรรมไฟล์ (ย่อ)
```
app/
  layout.tsx           # โหลด OpenCV.js จาก CDN และตั้งค่า <html lang="th">
  page.tsx             # UI หลัก + ควบคุม pipeline preprocess → OCR → parse
  api/
    ocrspace/route.ts  # proxy ไป OCR.Space (ตัวเลือกสำรอง)
    ai-refine/route.ts # clean + heuristic parse ฝั่ง server (ไม่มี external call)
lib/
  headingParser.ts     # แยกหัวข้อ + ตรวจรูปแบบบันทึกข้อความ
  smartParser.ts       # รวมฟิลด์พื้นฐาน, แปลงผล OCR เป็นโครงสร้างข้อมูล
  invoiceParser.ts     # ดึงรายการ/ยอดเงินแบบง่ายๆ
  textCleanup.ts       # ทำความสะอาดข้อความไทย/อังกฤษจาก OCR
```

---

## การทำงานโดยสรุป
1) **นำเข้าไฟล์** (รูป/เอกสาร) → แปลงเป็น canvas
2) **OpenCV.js**: หาเส้นขอบ, ทำ **perspective transform**, ทำ **adaptive threshold**
3) **OCR**: ใช้ **Tesseract.js** (ภาษา `tha+eng`, PSM `SINGLE_COLUMN`)
4) **Smart Parser**: ทำความสะอาดข้อความ, แยกหัวข้อ, เดาดึงฟิลด์ เช่น ประเภทเอกสาร/วันที่/ยอด
5) **ออกรูปแบบ**: แสดงข้อความดิบ, หัวข้อ, ตารางรายการ (สำหรับเอกสารที่มี items) และดาวน์โหลดผลลัพธ์เป็น JSON ได้

> ถ้าเจอเคสที่ Tesseract อ่านยาก สามารถสลับไปเรียก **/api/ocrspace** ได้ (ต้องมี API key)

---

## เริ่มต้นใช้งาน (Local)
ต้องมี **Node.js ≥ 18**

```bash
# ติดตั้งแพ็กเกจ
npm install

# รัน dev server
npm run dev
# เปิด http://localhost:3000
```

ตั้งค่าไฟล์ `.env.local` (ตัวอย่าง):
```env
NEXT_PUBLIC_APP_NAME="DocScan OCR"
# ใช้สำหรับสำรอง OCR.Space (ไม่บังคับ)
OCRSPACE_API_KEY="helloworld"  # อย่าใส่ key จริงลง repo สาธารณะ
```

---

## การดีพลอย
แนะนำ **Vercel** (รองรับ Next.js App Router ดีมาก)
1. สร้างโปรเจกต์ใหม่จาก repo
2. ตั้งค่า Environment Variables ตาม `.env.local`
3. Deploy ได้เลย

> โปรเจกต์นี้โหลด **OpenCV.js จาก CDN** ใน `app/layout.tsx` ถ้าใช้ในองค์กรปิด อาจเลือกโฮสต์ไฟล์เอง

---

## ทิปคุณภาพ OCR
- ถ่าย/สแกนให้สว่างสม่ำเสมอ ตัวหนังสือคมชัด
- วางกระดาษให้ **ตัดกับฉากหลัง** (เช่น กระดาษขาวบนโต๊ะสีเข้ม)
- เอกสารหลายคอลัมน์หรือมีตารางแน่นๆ ควรครอปให้เหลือคอลัมน์เดียว
- ภาษาไทยปนเลขไทย → แปลงเป็นเลขอารบิกให้อัตโนมัติแล้ว แต่รูปเบลอจะพลาดง่าย

---

## ความเป็นส่วนตัว
- โหมดปกติทำงาน **ฝั่ง client** ทั้งหมด: รูปอยู่ในเบราว์เซอร์ ไม่ส่งออก
- ถ้าเปิดใช้ **OCR.Space** จะมีการส่งภาพ (base64) ไปยัง API นั้น โปรดใช้อย่างระมัดระวังกับข้อมูลจริง

---

## ข้อจำกัด/ทางพัฒนา
- Heuristic แยกหัวข้อและใบแจ้งหนี้ยังเป็นแบบทั่วไป อาจไม่ครอบคลุมทุกฟอร์แมต
- เอกสาร scan คุณภาพต่ำ/เอียงมากอาจต้องครอปเองก่อน
- อยากต่อยอดเป็น:
  - history/session (เก็บหลายหน้า)
  - batch OCR และ export CSV/Excel
  - ปรับ UI รองรับ mobile กล้องสแกนแบบ real-time มากขึ้น

---

## สคริปต์ที่มี
```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint"
}
```

---

## License
MIT — ใช้/ปรับแต่งได้อิสระสำหรับงานเรียนรู้/เดโม

---

## เครดิต
- OpenCV.js — image processing
- Tesseract.js — OCR (tha+eng)
- ไอคอนจาก lucide-react

> เนื่องจากเป็นการศึกษาครั้งแรกถ้ามีไอเดีย/บั๊กที่อยากแจ้ง เปิด issue ได้ ยินดีรับฟังค่ะ 

