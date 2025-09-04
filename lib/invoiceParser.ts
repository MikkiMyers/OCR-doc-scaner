// lib/invoiceParser.ts
import { SmartFields, LineItem, MoneyField as SMoneyField } from '@/lib/smartParser';

export interface InvoiceParseResult {
  text: string;
  fields: SmartFields & { discount?: SMoneyField };
  lineItems: LineItem[];
  validations: ValidationReport;
}
export interface ValidationReport {
  warnings: string[];
  fixes: string[];
  confidence: number;
  computed:{ subtotalFromItems?:number; taxFromCalc?:number; discountFromPct?:number; totalFromCalc?:number; };
}

/* ---------------- helpers ---------------- */
const trim = (s:string)=> (s||'').replace(/[ \t]+/g,' ').trim();
const toThousands=(n?:number)=> typeof n==='number'&&isFinite(n)?n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):undefined;
const cleanText=(t:string)=>trim((t||'').normalize('NFC').replace(/\u00A0/g,' ').replace(/[|\[\]]/g,''));

const normalizeQty=(raw:string)=>{
  let s=String(raw).replace(/[^\d\s.,-]/g,'').replace(/,/g,'');
  s=s.replace(/\b(\d+)\s+(\d{2})\b/g,'$1.$2');
  if(/^\d{3,}$/.test(s)&&!/\./.test(s)) s=s.slice(0,-2)+'.'+s.slice(-2);
  return s;
};

const parseMoneyToken=(raw:string):number|undefined=>{
  if(!raw) return undefined;
  let s=String(raw).replace(/[^\d\s.,-]/g,'').replace(/,/g,'').trim();
  s=s.replace(/\b(\d+)\s+(\d{2})\b/g,'$1.$2'); // "40 00"→"40.00"
  if(/\d\.\d{1,}/.test(s)) { const n=parseFloat(s); return isFinite(n)?n:undefined; }
  if(/^\d{3,}$/.test(s))  { const n=parseFloat(`${s.slice(0,-2)}.${s.slice(-2)}`); return isFinite(n)?n:undefined; }
  if(/^\d+$/.test(s))     { const n=parseFloat(s); return isFinite(n)?n:undefined; }
  return undefined;
};
const moneyField=(raw?:string):SMoneyField|undefined=> raw?{raw:String(raw),value:parseMoneyToken(raw),text:toThousands(parseMoneyToken(raw))}:undefined;
const approxEq=(a?:number,b?:number)=> (a!=null&&b!=null)&&Math.abs(a-b)<=Math.max(0.05,0.02*Math.max(Math.abs(a),Math.abs(b)));
const isAlpha=(t:string)=>/[A-Za-z]/.test(t);

/* ------------- region slicer (ยืดหยุ่น header) ------------- */
const sliceItemsRegion=(clean:string):string|undefined=>{
  const pats = [
    /\b(QTY|QUANTITY)\b[\s\S]{0,40}\bDESCRIPTION\b[\s\S]{0,40}\b(UNIT\s+PRICE|RATE|PRICE)\b[\s\S]{0,40}\b(AMOUNT|TOTAL|COST)\b/i,
    /\b(DESCRIPTION|TASK)\b[\s\S]{0,40}\b(UNIT\s+PRICE|RATE|PRICE)\b[\s\S]{0,40}\b(QTY|QUANTITY|HOURS?|HRS?)\b[\s\S]{0,40}\b(AMOUNT|TOTAL|COST)\b/i,
    // header บางตัวหาย (เช่น QTY เพี้ยนเป็น "ary")
    /\bDESCRIPTION\b[\s\S]{0,40}\b(UNIT\s+PRICE|RATE|PRICE)\b[\s\S]{0,40}\b(AMOUNT|TOTAL|COST)\b/i
  ];
  let h:RegExpExecArray|null=null;
  for(const p of pats){ const m=p.exec(clean); if(m){ h=m; break; } }
  if(!h||h.index==null) return undefined;
  const afterHeaderIdx=h.index+h[0].length;
  const tail=clean.slice(afterHeaderIdx);
  const end=/(\bSUBTOTAL\b|\bTOTAL\s+DUE\b|\bBALANCE\s+DUE\b|\bAMOUNT\s+DUE\b|\bTOTAL\b)/i.exec(tail);
  const endIdx=end?.index!=null?afterHeaderIdx+end.index!:clean.length;
  const seg=clean.slice(afterHeaderIdx,endIdx).trim();
  return seg||undefined;
};

/* ---------------- token readers ---------------- */
const readMoney=(tokens:string[],i:number)=>{
  const cur=tokens[i]||'', nxt=tokens[i+1]||'';
  if(/\d[\d,]*\.\d{1,2}/.test(cur) || /^\$?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cur)){ const v=parseMoneyToken(cur); if(v!=null) return {raw:cur,value:v,next:i+1}; }
  if(/^\d{3,}$/.test(cur)){ if(/^\d{2}$/.test(nxt)&&nxt==='00'){} else { const v=parseMoneyToken(cur); if(v!=null) return {raw:cur,value:v,next:i+1}; } }
  if(/^\d+$/.test(cur)&&/^\d{2}$/.test(nxt)){ const raw=`${cur} ${nxt}`; const v=parseMoneyToken(raw); if(v!=null) return {raw,value:v,next:i+2}; }
  if(/^\$\d[\d,]*(?:\.\d{1,2})?(?:\/[A-Za-z]+)?$/.test(cur)){ const v=parseMoneyToken(cur); if(v!=null) return {raw:cur,value:v,next:i+1}; }
  return null as null|{raw:string;value:number;next:number};
};
const readQty=(tokens:string[],i:number)=>{
  const cur=tokens[i]||'', nxt=tokens[i+1]||'';
  if(/^\d+$/.test(cur)&&/^\d{2}$/.test(nxt)) return {raw:`${cur} ${nxt}`,text:normalizeQty(`${cur} ${nxt}`),next:i+2};
  if(/^\d{1,4}([.,]\d{1,2})?$/.test(cur)||/^\d{3,}$/.test(cur)) return {raw:cur,text:normalizeQty(cur),next:i+1};
  return null as null|{raw:string;text:string;next:number};
};

/* --------- line items: QTY-first & DESC-first --------- */
const parseItems_QtyFirst=(seg:string):LineItem[]=>{
  const t=seg.replace(/\n+/g,' ').split(/\s+/).filter(Boolean);
  const items:LineItem[]=[]; let i=0;
  while(i<t.length){
    const q=readQty(t,i); if(!q){i++; continue;} let j=q.next;
    let uIdx=-1; for(let k=j;k<Math.min(t.length,j+24);k++){ const m=readMoney(t,k); if(m){uIdx=k; break;} }
    if(uIdx===-1){ i=j; continue; }
    const m1=readMoney(t,uIdx)!; const m2=readMoney(t,m1.next||uIdx+1); if(!m2){ i=m1.next; continue; }
    const desc=trim(t.slice(j,uIdx).join(' ')); if(!isAlpha(desc)){ i=m2.next; continue; }
    const unit=m1.value, amt=m2.value, qn=parseFloat(q.text);
    const expect=isFinite(qn)&&unit!=null?+(qn*unit).toFixed(2):undefined;
    const ok=expect==null||amt==null?true:approxEq(amt,expect);
    if(ok){ items.push({description:desc, unitPrice: toThousands(unit) as any, qty:q.text, amount: toThousands(amt) as any } as LineItem); i=m2.next; } else { i=j; }
  }
  return items;
};
const parseItems_DescFirst=(seg:string):LineItem[]=>{
  const t=seg.replace(/\n+/g,' ').split(/\s+/).filter(Boolean);
  const items:LineItem[]=[]; let i=0;
  while(i<t.length){
    const start=i; let found=false;
    for(let k=start+1;k<Math.min(t.length,start+40);k++){
      const unit=readMoney(t,k); if(!unit) continue;
      const qty=readQty(t,unit.next); if(!qty) continue;
      const amt=readMoney(t,qty.next); if(!amt) continue;
      const desc=trim(t.slice(start,k).join(' ')); if(!isAlpha(desc)) break;
      items.push({description:desc, unitPrice: toThousands(unit.value) as any, qty:qty.text, amount: toThousands(amt.value) as any } as LineItem);
      i=amt.next; found=true; break;
    }
    if(!found) i++;
  }
  return items;
};
const parseLineItems=(seg?:string)=> seg? (()=>{
  const a=parseItems_QtyFirst(seg); const b=parseItems_DescFirst(seg);
  return b.length>a.length?b:a;
})():[];

/* --------- validation / fallback --------- */
function validateAndFallback(fields:SmartFields&{discount?:SMoneyField}, items:LineItem[]):ValidationReport{
  const warnings:string[]=[]; const fixes:string[]=[];
  const subtotal=(fields as any).subtotal?.value as number|undefined;
  let tax=(fields as any).vat?.value as number|undefined;
  let total=(fields as any).total?.value as number|undefined;
  let discount=(fields as any).discount?.value as number|undefined;
  const vatRaw=(fields as any).vat?.raw as string|undefined;
  const discountRaw=(fields as any).discount?.raw as string|undefined;

  // tax from %
  if(tax==null && vatRaw && /%/.test(vatRaw) && subtotal!=null){
    const p=parseFloat(vatRaw.replace(/[^\d.]/g,'')); if(isFinite(p)){ const v=+(subtotal*(p/100)).toFixed(2);
      (fields as any).vat={raw:vatRaw,value:v,text:toThousands(v)}; tax=v; fixes.push(`คำนวณ VAT จาก ${p}% ของ Subtotal`); }
  }
  // discount from %
  if(discount==null && discountRaw && /%/.test(discountRaw) && subtotal!=null){
    const p=parseFloat(discountRaw.replace(/[^\d.]/g,'')); if(isFinite(p)){ const v=+(subtotal*(p/100)).toFixed(2);
      (fields as any).discount={raw:discountRaw,value:v,text:toThousands(v)}; discount=v; fixes.push(`คำนวณ Discount จาก ${p}%`); }
  }
  // totals from relations
  if(tax==null && subtotal!=null && total!=null){ const t=+(total-(subtotal-(discount??0))).toFixed(2);
    if(t>=-0.01 && t<=subtotal*0.35){ (fields as any).vat={raw:String(t),value:t,text:toThousands(t)}; tax=t; fixes.push('คำนวณ VAT จากความสัมพันธ์ totals'); } }
  if(total==null && subtotal!=null){ const tt=+(subtotal-(discount??0)+(tax??0)).toFixed(2);
    (fields as any).total={raw:String(tt),value:tt,text:toThousands(tt)}; total=tt; fixes.push('เติม Total จาก Subtotal - Discount + Tax'); }
  // sanity
  if(tax!=null && subtotal!=null && tax>subtotal*0.8){ const fixed=+(tax/100).toFixed(2);
    if(fixed<=subtotal*0.35){ (fields as any).vat={raw:String(vatRaw??tax),value:fixed,text:toThousands(fixed)}; tax=fixed; fixes.push('ปรับ VAT สูงผิดปกติด้วยการหาร 100'); }
    else warnings.push('VAT สูงผิดปกติเมื่อเทียบกับ Subtotal'); }

  // items sum
  let subtotalFromItems:number|undefined;
  if(items.length){ const nums=items.map(li=>parseMoneyToken(String(li.amount??''))).filter((n):n is number=>typeof n==='number'&&isFinite(n));
    if(nums.length) subtotalFromItems=+nums.reduce((a,b)=>a+b,0).toFixed(2); }
  if(subtotalFromItems!=null){
    if(subtotal==null){ (fields as any).subtotal={raw:String(subtotalFromItems),value:subtotalFromItems,text:toThousands(subtotalFromItems)}; fixes.push('ตั้ง Subtotal จากผลรวม line items'); }
    else if(!approxEq(subtotal,subtotalFromItems)){ warnings.push(`Subtotal (${toThousands(subtotal)}) ไม่เท่าผลรวม line items (${toThousands(subtotalFromItems)})`); }
  }

  // final relation
  if(subtotal!=null && total!=null){
    const expect=+(subtotal-(discount??0)+(tax??0)).toFixed(2);
    if(!approxEq(expect,total)) warnings.push(`Subtotal - Discount + Tax (${toThousands(expect)}) ไม่เท่ากับ Total (${toThousands(total)})`);
  }

  let confidence=0.6;
  if((fields as any).docNo) confidence+=0.05;
  if((fields as any).date) confidence+=0.05;
  if((fields as any).subtotal?.value!=null) confidence+=0.1;
  if((fields as any).vat?.value!=null) confidence+=0.05;
  if((fields as any).total?.value!=null) confidence+=0.1;
  confidence=Math.max(0,Math.min(1,confidence-warnings.length*0.05+fixes.length*0.03));

  return {warnings,fixes,confidence,computed:{
    subtotalFromItems,
    taxFromCalc: (subtotal!=null && total!=null)?+(total-(subtotal-(discount??0))).toFixed(2):undefined,
    discountFromPct: (discountRaw && /%/.test(discountRaw) && subtotal!=null)? +(subtotal*(parseFloat(discountRaw)/100)).toFixed(2):undefined,
    totalFromCalc: (subtotal!=null)? +(subtotal-(discount??0)+(tax??0)).toFixed(2):undefined
  }};
}

/* ---------------- main parser ---------------- */
export function parseInvoice(rawText:string):InvoiceParseResult{
  const clean=cleanText(rawText);
  const fields:SmartFields&{discount?:SMoneyField}={docType:'invoice'} as any;

  // เลขที่เอกสาร: เฉพาะกรณีมี NO/NUMBER/#/:
  const docNo=clean.match(/INVOICE\s*(?:NO\.?|NUMBER|#|:)\s*#?\s*([A-Za-z0-9\-\/]+)/i);
  if(docNo) fields.docNo=docNo[1].trim();

  // วันที่: แบบตัวเลขหรือข้อความ (เช่น 2nd May, 2026)
  const date=clean.match(/(?:INVOICE\s*DATE|DATE|วันที่)\s*[:\-]?\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,}\,?\s+\d{4})/i);
  if(date) fields.date=date[1];

  // totals
  const subtotalRaw=clean.match(/\bSUBTOTAL\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)?.[1];

  const afterSub=clean.split(/\bSUBTOTAL\b/i)[1]||'';
  // TAX: อ่านจากโซนหลัง subtotal ก่อน
  let taxAmountRaw=(afterSub.match(/\b(?:SALES\s*TAX|TAX|VAT|GST)\b[^\n$%]*\$?\s*([\d\s,.-]+)/i)||[])[1];
  const taxPercentRaw=(afterSub.match(/\b(?:SALES\s*TAX|TAX|VAT|GST)\b[^\n%]*(\d{1,3}(?:[.,]\d+)?%)/i)||[])[1];
  if(!taxAmountRaw){ // fallback ทั้งเอกสาร
    taxAmountRaw=(clean.match(/\b(?:SALES\s*TAX|TAX|VAT|GST)\b[^\n$%]*\$?\s*([\d\s,.-]+)/i)||[])[1];
  }

  const discountAmountRaw=(afterSub.match(/\b(?:DISCOUNT|PACKAGE\s+DISCOUNT)\b[^\n$%]*\$?\s*([\d\s,.-]+)/i)||[])[1]
                          || (clean.match(/\b(?:DISCOUNT|PACKAGE\s+DISCOUNT)\b[^\n$%]*\$?\s*([\d\s,.-]+)/i)||[])[1];
  const discountPercentRaw=(afterSub.match(/\b(?:DISCOUNT|PACKAGE\s+DISCOUNT)\b[^\n%]*(\d{1,3}(?:[.,]\d+)?%)/i)||[])[1]
                          || (clean.match(/\b(?:DISCOUNT|PACKAGE\s+DISCOUNT)\b[^\n%]*(\d{1,3}(?:[.,]\d+)?%)/i)||[])[1];

  const totalRaw = (clean.match(/\b(TOTAL\s+DUE|BALANCE\s+DUE|AMOUNT\s+DUE)\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)||[])[2]
                || clean.match(/\bTOTAL\b\s*[:\-]?\s*\$?([\d\s,.-]+)/i)?.[1];

  const subtotal=moneyField(subtotalRaw);
  const total=moneyField(totalRaw);

  // tax & discount fields
  let vat:SMoneyField|undefined; let discount:SMoneyField|undefined;
  if(taxAmountRaw){ let v=parseMoneyToken(taxAmountRaw); if(v!=null && subtotal?.value!=null && v>subtotal.value*0.8) v=+(v/100).toFixed(2);
    vat={raw:taxAmountRaw,value:v,text:toThousands(v)}; }
  else if(taxPercentRaw){ vat={raw:taxPercentRaw,text:taxPercentRaw}; }

  if(discountAmountRaw){ const d=parseMoneyToken(discountAmountRaw); discount={raw:discountAmountRaw,value:d,text:toThousands(d)}; }
  else if(discountPercentRaw){ discount={raw:discountPercentRaw,text:discountPercentRaw}; }

  if(subtotal) (fields as any).subtotal=subtotal;
  if(vat) (fields as any).vat=vat;
  if(discount) (fields as any).discount=discount;
  if(total) (fields as any).total=total;

  // items
  const seg=sliceItemsRegion(clean);
  const lineItems=parseLineItems(seg);

  // validation/fallback
  const validations=validateAndFallback(fields,lineItems);

  return { text: clean, fields, lineItems, validations };
}

/* --------- (optional) summarizer --------- */
export function summarizeInvoice(res:InvoiceParseResult):string{
  const f=res.fields as any;
  const top=(res.lineItems||[]).map(li=>({d:li.description,v:parseMoneyToken(String(li.amount??''))||0})).sort((a,b)=>b.v-a.v)[0];
  return [
    `เลขที่ ${f.docNo??'-'}`, `วันที่ ${f.date??'-'}`,
    `Subtotal ${f.subtotal?.text??'-'}`,
    f.discount?.value!=null?`Discount ${f.discount.text}`:(f.discount?.raw?`Discount ${f.discount.raw}`:''),
    `Tax ${f.vat?.text ?? (f.vat?.value!=null?toThousands(f.vat.value):'-')}`,
    `รวม ${f.total?.text??'-'}`,
    top&&top.v>0?`แพงสุด: ${top.d} (${toThousands(top.v)})`:'',
    `ความมั่นใจ ${(res.validations.confidence*100|0)}%`
  ].filter(Boolean).join(' · ');
}

export default parseInvoice;
