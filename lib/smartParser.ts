// lib/smartParser.ts
// Backward compatible. Adds Thai memo detection. Exports MoneyField (named).

import { parseHeadings, detectThaiMemo, parseThaiMemo, ParsedSection, ThaiMemoFields } from './headingParser';
import { cleanOCRText } from './textCleanup';

export type MoneyField = { text?: string; value?: number; raw?: string };

export interface LineItem {
  description: string;
  qty?: string;
  unitPrice?: string;
  amount?: string;
}

export interface SmartFields extends ThaiMemoFields {
  // doc types
  docType: 'thai_memo' | 'generic' | 'invoice' | 'receipt' | 'resume';

  // generic contacts
  email?: string;
  phone?: string;
  address?: string;
  name?: string;

  // invoice-ish fields (optional; for UI compatibility)
  docNo?: string;
  dueDate?: string;
  seller?: string;
  buyer?: string;
  subtotal?: MoneyField;
  vat?: MoneyField;
  total?: MoneyField;
  discount?: MoneyField;
}

export interface SmartParseResult {
  text: string;
  fields: SmartFields;
  sections: ParsedSection[];
  lineItems: LineItem[];
}

// _opts kept for backward-compat; currently unused.
export function smartParse(rawText: string, _opts?: unknown): SmartParseResult {
  const cleaned = cleanOCRText(rawText || '');

  if (detectThaiMemo(cleaned)) {
    const { sections, fields } = parseThaiMemo(cleaned);
    const sf: SmartFields = { docType: 'thai_memo', ...fields };
    return { text: cleaned, fields: sf, sections, lineItems: [] };
  }

  const sections = parseHeadings(cleaned);
  const allLines = sections.flatMap(s => s.content);

  const reEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const rePhone = /(\+?\d{1,4}[\s-])?(0|\+66)\d([\s-]?\d){7,8}/;

  const emailLine = allLines.find(l => reEmail.test(l));
  const phoneLine = allLines.find(l => rePhone.test(l));

  const fields: SmartFields = { docType: 'generic' };
  if (emailLine) fields.email = (emailLine.match(reEmail) || [])[0];
  if (phoneLine) fields.phone = (phoneLine.match(rePhone) || [])[0];

  return { text: cleaned, fields, sections, lineItems: [] };
}

export default smartParse;
