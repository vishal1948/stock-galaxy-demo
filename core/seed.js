// Sample shop for the browser demo: made-up shop, products, salesmen, customers and about a month of bills,
// all created through the app's real business code, then dated over the last 30 days.
let state = 20261121;
const rand = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };   // same data every load
const pick = (a) => a[Math.floor(rand() * a.length)];
const pad = (n) => String(n).padStart(2, '0');
const at = (daysAgo, hour, min) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, min, Math.floor(rand() * 60), 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// a garment shop: every size and colour is its own item with its own barcode [barcode, name, size, colour, rate, qty, HSN]
const PRODUCTS = [
  ['8901234500011', 'Cotton Check Shirt', 'M', 'Blue', 799, 14, '6205'], ['8901234500012', 'Cotton Check Shirt', 'L', 'Blue', 799, 14, '6205'],
  ['8901234500013', 'Cotton Check Shirt', 'XL', 'Red', 799, 12, '6205'], ['8901234500021', 'Linen Formal Shirt', '40', 'White', 1299, 15, '6205'],
  ['8901234500022', 'Linen Formal Shirt', '42', 'White', 1299, 15, '6205'], ['8901234500031', 'Round Neck T-Shirt', 'M', 'Black', 449, 30, '6109'],
  ['8901234500032', 'Round Neck T-Shirt', 'L', 'Navy', 449, 30, '6109'], ['8901234500041', 'Polo T-Shirt', 'L', 'Maroon', 699, 25, '6105'],
  ['8901234500051', 'Slim Fit Jeans', '32', 'Indigo', 1499, 18, '6203'], ['8901234500052', 'Slim Fit Jeans', '34', 'Black', 1499, 17, '6203'],
  ['8901234500061', 'Formal Trousers', '32', 'Grey', 1199, 25, '6203'], ['8901234500071', 'Cotton Kurta', 'L', 'Yellow', 999, 30, '6211'],
  ['8901234500072', 'Festive Silk Kurta', 'XL', 'Cream', 2999, 12, '6211'], ['8901234500081', 'Wool Blazer', '40', 'Charcoal', 5499, 8, '6203'],
  ['8901234500091', 'Winter Jacket', 'L', 'Olive', 2999, 10, '6201'], ['8901234500101', 'Cotton Socks (3 pairs)', 'Free', 'Mixed', 299, 80, '6115'],
];
const CUSTOMERS = [['Rahul Sharma', '9876500101'], ['Priya Patil', '9876500102'], ['Amit Deshmukh', '9876500103'],
  ['Sneha Kulkarni', '9876500104'], ['Vikram Joshi', '9876500105'], ['Anjali Mehta', '9876500106'],
  ['Rohan Pawar', '9876500107'], ['Neha Shinde', '9876500108'], ['', ''], ['', '']];

export function seed({ sales: S, products: P, db }) {
  S.completeSetup({ shop_name: 'Galaxy Fashion Hub', shop_tagline: "Men's Wear & Accessories", shop_address: 'MG Road, Camp, Pune 411001',
    shop_phones: '98765 43210', gstin: '27ABCDE1234F1Z5', salesman: 'Amit', first_bill_no: '1001' });
  S.addSalesman('Priya');
  S.addSalesman('Rahul');
  S.saveSettings({ whatsapp_billing: '0', bill_footer: 'Exchange within 7 days with bill. No refund on sale items.',
    gst_billing: '1', gst_default_hsn: '6205' });   // a GST-registered garment shop: bills are tax invoices
  // switch on a few more of the built-in payment modes, as a shop would in Settings
  S.saveSettings({ payment_modes: JSON.stringify(S.paymentModes().map((m) =>
    (['paytm', 'gpay', 'bajaj_finance'].includes(m.id) ? { ...m, active: true } : m))) });

  P.addStock(PRODUCTS.map(([code, name, size, colour, rate, qty, hsn]) => ({ code, name, size, colour, qty, rate: rate * 100, hsn })));
  db.prepare("UPDATE stock_movements SET created_at = ? WHERE type = 'stock_in'").run(at(32, 10, 15));
  const salesmen = S.listSalesmen();
  const methods = ['cash', 'upi', 'upi', 'credit_card', 'paytm'];

  for (let day = 30; day >= 0; day--) {
    const bills = 1 + Math.floor(rand() * 4);
    for (let b = 0; b < bills; b++) {
      const items = [];
      for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
        const [code, name, , , rate] = pick(PRODUCTS);
        if (!items.some((x) => x.code === code)) items.push({ code, description: name, qty: 1 + Math.floor(rand() * 2), price: rate * 100 });
      }
      const subtotal = items.reduce((a, i) => a + i.qty * i.price, 0);
      const discount = rand() < 0.3 ? Math.round(subtotal * 0.05 / 100) * 100 : 0;
      const total = subtotal - discount;
      const split = rand() < 0.15 && total > 100000;
      const payments = split ? [{ method: 'cash', amount: 50000 }, { method: 'upi', amount: total - 50000 }] : [{ method: pick(methods), amount: total }];
      const [customer_name, customer_phone] = pick(CUSTOMERS);
      const billNo = S.createSale({ salesman_id: pick(salesmen).id, customer_name, customer_phone, discount, items, payments });
      const when = at(day, 10 + Math.floor(rand() * 10), Math.floor(rand() * 60));
      const id = db.prepare('SELECT id FROM sales WHERE bill_no = ?').get(billNo).id;
      db.prepare('UPDATE sales SET sold_at = ? WHERE id = ?').run(when, id);
      db.prepare("UPDATE stock_movements SET created_at = ? WHERE type = 'sale' AND ref_id = ?").run(when, id);
    }
  }
  db.prepare("UPDATE customers SET last_seen = (SELECT MAX(sold_at) FROM sales WHERE customer_phone = customers.phone)").run();

  P.adjustStock({ code: '8901234500031', qty: -2, note: 'Damaged in storage' });
  P.adjustStock({ code: '8901234500101', qty: 5, note: 'Found in back store' });
  db.prepare("UPDATE stock_movements SET created_at = ? WHERE type = 'adjustment'").run(at(3, 18, 5));
  P.addStock([{ code: '8901234500011', qty: 12 }, { code: '8901234500051', qty: 8 }, { code: '8901234500081', qty: 4 }]);
}
