# DocScan OCR (ไทย/อังกฤษ) — Next.js Starter

แอปตัวอย่างสำหรับ **ตัด/ปรับมุมเอกสาร (OpenCV.js) + OCR (Tesseract.js) + แยกหัวข้อแบบง่าย** ทั้งหมดทำงานบนเบราว์เซอร์ (client-side) จึงเหมาะสำหรับเดโม/ส่งงานสัมภาษณ์และ **deploy บน Vercel/Netlify** ได้ทันที

## ฟีเจอร์
- อัปโหลด/ถ่ายรูปเอกสาร (มือถือใช้กล้องได้) แล้วระบบจะ
  1) ค้นหาเอกสารในภาพและ **perspective transform** ให้อยู่ตรง
  2) ปรับภาพ (แปลงเป็นขาวดำแบบ adaptive threshold) เพื่อช่วยให้ OCR แม่นขึ้น
  3) ใช้ Tesseract.js ทำ OCR ภาษา **ไทย+อังกฤษ**
  4) แยกข้อความเป็น **หัวข้อ** ด้วยกติกาเบื้องต้น (จบบรรทัดด้วย `:`, bullet/หมายเลข, บรรทัดสั้น ฯลฯ)
  5) ดาวน์โหลดผลลัพธ์เป็น **JSON**

## เทคโนโลยี
- **Next.js 14 (App Router)**, **React 18**, **Tailwind CSS**
- **OpenCV.js** (โหลดจาก CDN)
- **Tesseract.js v5** (โหลด worker/core/lang จาก CDN; ภาษา `tha+eng`)

## เริ่มต้น (มือใหม่ทำตามได้ทีละขั้น)
> ต้องมี **Node.js LTS 20+** แนะนำเช็คด้วย `node -v`

1. แตกไฟล์โปรเจกต์นี้ แล้วเปิดโฟลเดอร์ใน Terminal:
   ```bash
   cd ocr-doc-scanner-next-starter
   ```
2. ติดตั้ง dependencies (เลือกอย่างหนึ่ง):
   ```bash
   npm install
   # หรือ
   pnpm install
   ```
3. รันโหมดพัฒนา:
   ```bash
   npm run dev
   ```
   แล้วเปิดเบราว์เซอร์ไปที่ **http://localhost:3000**
4. ทดสอบด้วยการอัปโหลดรูปเอกสาร ถ้าเป็นมือถือให้อนุญาตเข้าถึงกล้อง

## Deploy อย่างไว (Vercel)
1. สร้าง repo บน GitHub แล้ว push โค้ดขึ้นไป
2. เข้า https://vercel.com > New Project > Import repo
3. Framework Preset: **Next.js**, กด Deploy ได้เลย (ไม่ต้องตั้งค่า env)
4. ได้ URL พร้อมเดโมทันที

## โครงสร้างไฟล์สำคัญ
```
app/
  layout.tsx         # ใส่ <Script> โหลด OpenCV จาก CDN
  page.tsx           # UI หลัก + pipeline CV -> OCR -> Parser
  globals.css        # Tailwind
components/
  Spinner.tsx
lib/
  headingParser.ts   # แยกหัวข้อแบบ heuristic
public/
  (ถ้าต้องการ asset เพิ่มเติมให้วางที่นี่)
tailwind.config.ts
next.config.mjs
package.json
tsconfig.json
```

## เคล็ดลับความแม่นยำ OCR
- ถ่ายให้แสงสม่ำเสมอ ตัวหนังสือชัด
- ใช้กระดาษตัดกับพื้นหลัง (เช่น กระดาษขาววางบนโต๊ะสีเข้ม)
- ถ้าตรวจเอกสารไม่เจอ ระบบจะใช้ภาพเดิมแต่ปรับขาวดำแทน

## หมายเหตุ/ข้อจำกัด
- การโหลดไฟล์ภาษา (tha+eng) อาจใช้เวลาในครั้งแรก (จาก CDN)
- Heuristic แยกหัวข้อเป็นแบบง่าย ถ้าต้องการแม่นยำขึ้น แนะนำต่อยอดด้วย **layout detection** (เช่น [LayoutLM], [doc-layout model]), หรือใช้ ML จัดหัวข้อ
- ทั้งหมดทำงานฝั่ง client จึงเหมาะกับเอกสารที่ไม่เป็นความลับสูง หากต้องการ privacy สูงสุดให้รันบนอุปกรณ์ภายใน

## ไลเซนส์
MIT — ใช้/ปรับได้อิสระเพื่อการเรียนรู้และเดโม
