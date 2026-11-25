// GST on bills (Settings > GST billing). Rates on the products INCLUDE GST, like the MRP on a garment tag:
// the customer pays the rate; the bill shows how much of it is tax.
//
// Garment rule (GST 2.0, from 22 Sep 2025): a piece sold for up to Rs 2,500 (value before GST) is taxed at 5%,
// a piece above that at 18%. Each piece counts on its own, after its share of the bill discount.
// A product can instead have a fixed rate (e.g. 0%, 12%) set in Stock In.
//
// Rates are kept in hundredths of a percent (500 = 5%), money in paise. Pure functions: no database here.

export const GARMENT_LIMIT = 250000;   // Rs 2,500 per piece, before GST
export const GARMENT_LOW = 500;        // 5%
export const GARMENT_HIGH = 1800;      // 18%
export const RATES = [0, 25, 300, 500, 1200, 1800, 2800, 4000];   // rates a product may be fixed at

export const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const HSN = /^\d{4,8}$/;

// GST state codes (first two digits of a GSTIN)
export const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim',
  12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam',
  19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Daman and Diu', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra', 28: 'Andhra Pradesh (old)',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry',
  35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
};
export const stateName = (code) => STATES[String(code ?? '').padStart(2, '0')] ?? '';

export const rateText = (bp) => `${Number(bp) / 100}%`;

/** The rate for one piece: the product's own fixed rate, or the garment rule from the piece's price (incl. GST). */
export function pieceRate(fixed, piecePrice) {
  if (fixed != null && fixed !== '') return Number(fixed);
  const before = (piecePrice * 10000) / (10000 + GARMENT_LOW);
  return before <= GARMENT_LIMIT ? GARMENT_LOW : GARMENT_HIGH;
}

/**
 * Splits a bill into taxable value and tax. lines: [{ amount, qty, fixedRate }] (amount = qty x rate, incl. GST).
 * The bill discount is shared over the lines by amount (the last line takes the rounding).
 * Returns per line { rate, taxable, cgst, sgst, igst } and the totals. Every line's taxable + tax = its amount
 * after discount, so the bill total never changes.
 */
export function splitTax(lines, discount = 0, interstate = false) {
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  let left = discount;
  const out = lines.map((l, i) => {
    const share = i === lines.length - 1 ? left : Math.round((discount * l.amount) / (subtotal || 1));
    left -= share;
    const net = l.amount - share;
    const rate = pieceRate(l.fixedRate, l.qty ? net / l.qty : net);
    const taxable = Math.round((net * 10000) / (10000 + rate));
    const tax = net - taxable;
    const cgst = interstate ? 0 : Math.floor(tax / 2);
    return { rate, taxable, cgst, sgst: interstate ? 0 : tax - cgst, igst: interstate ? tax : 0 };
  });
  const sum = (k) => out.reduce((a, l) => a + l[k], 0);
  return { lines: out, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst') };
}

/** Rate-wise summary of saved bill lines: [{ rate, taxable, cgst, sgst, igst }] (for the bill's tax table). */
export function byRate(items) {
  const m = new Map();
  for (const i of items) {
    const r = m.get(i.gst_rate) ?? { rate: i.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    for (const k of ['taxable', 'cgst', 'sgst', 'igst']) r[k] += i[k];
    m.set(i.gst_rate, r);
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate);
}

// ---- returns: what each bill line really cost the customer, and the share being returned ----

/** Each saved bill line's value after its share of the bill discount (the same sharing as splitTax), and its
 *  tax parts. items: sale_items rows (amount, taxable, cgst, sgst, igst); gstBill: the bill was a tax invoice. */
export function lineNets(items, discount, subtotal, gstBill) {
  let left = discount;
  return items.map((i, n) => {
    if (gstBill) return { net: i.taxable + i.cgst + i.sgst + i.igst, taxable: i.taxable, cgst: i.cgst, sgst: i.sgst, igst: i.igst };
    const share = n === items.length - 1 ? left : Math.round((discount * i.amount) / (subtotal || 1));
    left -= share;
    return { net: i.amount - share, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  });
}

/** Returning q more pieces of a line of `qty` pieces, `done` already returned: the money and tax for them.
 *  Worked out as "all returned so far" minus "before", so returning a line in parts adds up to exactly its value. */
export function returnShare(line, qty, done, q) {
  const part = (v) => Math.round((v * (done + q)) / qty) - Math.round((v * done) / qty);
  const r = { taxable: part(line.taxable), cgst: part(line.cgst), sgst: part(line.sgst), igst: part(line.igst) };
  r.amount = line.taxable || line.cgst || line.sgst || line.igst ? r.taxable + r.cgst + r.sgst + r.igst : part(line.net);
  return r;
}
