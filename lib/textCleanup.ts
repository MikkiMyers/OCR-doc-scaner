// lib/textCleanup.ts
// Strong cleanup for mixed Thai/English OCR text

const THAI_DIGIT_MAP: Record<string, string> = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9'
};

const RE_THAI_DIGIT = /[๐-๙]/g;
const RE_ZERO_WIDTH = /[\u200B\u200C\u200D\u2060]/g;
const RE_MULTI_SPACE = /[ \t]{2,}/g;
const RE_EOL_HYPHEN = /([A-Za-zก-ฮ0-9])[‐-]\s*\n\s*([A-Za-zก-ฮ0-9])/g;
const RE_NOISY_BORDER = /^[^A-Za-zก-ฮ0-9]{3,}$/;

export function toArabicDigits(s: string): string {
  return (s || '').replace(RE_THAI_DIGIT, (m) => THAI_DIGIT_MAP[m] || m);
}

export function basicClean(raw: string): string {
  return (raw || '')
    .replace(RE_ZERO_WIDTH, '')
    .replace(RE_EOL_HYPHEN, (_m, a, b) => a + b)
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(RE_MULTI_SPACE, ' ')
    .trim();
}

export function cleanOCRText(raw: string): string {
  const normalized = basicClean(toArabicDigits(raw || ''));
  // Drop fully noisy lines
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter(l => {
    const s = l.trim();
    if (!s) return true;
    if (RE_NOISY_BORDER.test(s)) return false;
    // require some letters/digits
    const letters = (s.match(/[A-Za-zก-ฮ0-9]/g) || []).length;
    return letters / Math.max(1, s.length) >= 0.25;
  });
  return filtered.join('\n');
}

export default cleanOCRText;
