/** Parse JSON with comments and trailing commas (tsconfig.json style). Returns null if invalid. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
