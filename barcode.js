// Code 128 barcodes drawn as SVG, for barcode stickers (renderer/stickers.js). Every scanner reads Code 128.
// Set B covers letters, digits and normal symbols; a run of digits uses set C (two digits per symbol), which
// makes numeric barcodes such as 8901234567890 about 40% shorter - easier to fit and to scan on small stickers.

// Bar/space widths for symbol values 0-106 (each adds up to 11 modules). STOP is separate.
export const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232').split(' ');   // ends with Start A 103, Start B 104, Start C 105
export const STOP = '2331112';
const START_B = 104, START_C = 105, TO_B = 100, TO_C = 99;

/** Text -> symbol values, with start and check symbol. Throws for characters a barcode cannot hold. */
export function code128Values(text) {
  const s = String(text ?? '');
  if (!s || !/^[\x20-\x7e]+$/.test(s)) throw new Error(`"${s}" cannot be printed as a barcode (use letters, digits and - / . only)`);
  const values = [];
  let set = null, i = 0;
  const digitsAt = (k) => { let n = 0; while (k + n < s.length && /\d/.test(s[k + n])) n++; return n; };
  while (i < s.length) {
    const run = digitsAt(i);
    // 4 or more digits (or the whole rest being an even run of 2+) are worth set C; an odd run leaves its first digit in B
    const useC = run >= 4 || (run >= 2 && run === s.length - i && run % 2 === 0);
    if (useC) {
      if (run % 2 === 1) {   // odd run: one digit in set B first
        if (set !== 'B') { values.push(set ? TO_B : START_B); set = 'B'; }
        values.push(s.charCodeAt(i) - 32); i++;
      }
      if (set !== 'C') { values.push(set ? TO_C : START_C); set = 'C'; }
      const end = i + (run % 2 === 1 ? run - 1 : run);
      for (; i < end; i += 2) values.push(Number(s.slice(i, i + 2)));
    } else {
      if (set !== 'B') { values.push(set ? TO_B : START_B); set = 'B'; }
      values.push(s.charCodeAt(i) - 32); i++;
    }
  }
  const check = values.reduce((sum, v, k) => sum + v * (k || 1), 0) % 103;
  return [...values, check];
}

/** Widths of every bar and space in order, starting with a bar. */
export const code128Widths = (text) =>
  [...code128Values(text).map((v) => PATTERNS[v]), STOP].join('').split('').map(Number);

/** SVG that stretches to its box; the quiet zone (blank margin scanners need) is added on both sides. */
export function code128Svg(text) {
  const QUIET = 10;
  let x = QUIET, d = '';
  code128Widths(text).forEach((w, i) => {
    if (i % 2 === 0) d += `M${x} 0h${w}v1h-${w}z`;
    x += w;
  });
  return `<svg class="bc" viewBox="0 0 ${x + QUIET} 1" preserveAspectRatio="none" shape-rendering="crispEdges"
    xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#000"/></svg>`;
}
