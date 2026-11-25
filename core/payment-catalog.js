// Payment modes Indian shops take, built into the app (Settings > Payment modes switches each on or off).
// A shop can still add its own. Ids never change once released: they are stored on every bill.
// Sources: UPI is ~90% of retail payments by count; cards and card EMI for bigger bills; wallets and
// pay-later apps; in-store consumer-durable EMI (Bajaj Finance has ~half that market) - see the 1.4.3 notes.
export const PAYMENT_GROUPS = [
  ['cash_upi', 'Cash & UPI'], ['cards', 'Cards'], ['bank', 'Bank'], ['wallets', 'Wallets'],
  ['finance', 'EMI & finance'], ['other', 'Other'], ['own', 'Added by you'],
];

// [id, label, group, on for a brand-new shop]
export const PAYMENT_CATALOG = [
  ['cash', 'Cash', 'cash_upi', true],
  ['upi', 'UPI', 'cash_upi', true],
  ['gpay', 'Google Pay', 'cash_upi', false],
  ['phonepe', 'PhonePe', 'cash_upi', false],
  ['paytm', 'Paytm', 'cash_upi', false],
  ['bhim', 'BHIM UPI', 'cash_upi', false],
  ['amazon_pay', 'Amazon Pay', 'cash_upi', false],
  ['cred', 'CRED Pay', 'cash_upi', false],

  ['debit_card', 'Debit Card', 'cards', true],
  ['credit_card', 'Credit Card', 'cards', true],
  ['card_emi', 'Credit Card EMI', 'cards', false],
  ['forex_card', 'Foreign Card', 'cards', false],

  ['bank_transfer', 'Bank Transfer (NEFT/IMPS)', 'bank', false],
  ['cheque', 'Cheque', 'bank', false],
  ['demand_draft', 'Demand Draft', 'bank', false],

  ['paytm_wallet', 'Paytm Wallet', 'wallets', false],
  ['mobikwik', 'MobiKwik', 'wallets', false],
  ['phonepe_wallet', 'PhonePe Wallet', 'wallets', false],
  ['airtel_money', 'Airtel Payments Bank', 'wallets', false],

  ['bajaj_finance', 'Bajaj Finserv EMI', 'finance', false],
  ['poonawalla', 'Poonawalla Fincorp EMI', 'finance', false],
  ['tvs_credit', 'TVS Credit', 'finance', false],
  ['hdb_finance', 'HDB Financial', 'finance', false],
  ['home_credit', 'Home Credit', 'finance', false],
  ['idfc_first', 'IDFC FIRST Consumer Loan', 'finance', false],
  ['snapmint', 'Snapmint', 'finance', false],
  ['simpl', 'Simpl', 'finance', false],
  ['lazypay', 'LazyPay', 'finance', false],

  ['gift_voucher', 'Gift Voucher', 'other', false],
  ['loyalty_points', 'Loyalty Points', 'other', false],
  ['udhaar', 'Pay Later (Udhaar)', 'other', false],
].map(([id, label, group, on]) => ({ id, label, group, on }));

export const CATALOG_BY_ID = Object.fromEntries(PAYMENT_CATALOG.map((m) => [m.id, m]));
