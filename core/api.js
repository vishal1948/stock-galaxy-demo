// window.api for the browser demo: the same functions the desktop app's screens call, answered by the app's
// own business code (sales.js, products.js, reports.js - copied in unchanged by scripts/build-demo.mjs)
// running on an in-memory database with sample data. Desktop-only things (PDF files, folders, WhatsApp,
// Excel files, licensing) answer with a short explanation instead. Everything resets on reload.
import { makeDb } from './shim.js';
import { MIGRATIONS, APP_VERSION } from './build-info.js';

const DEMO = (what) => new Error(`Demo: ${what}`);
const DATA_DIR = 'D:\\Stock Galaxy';
let core = null;

const ready = (async () => {
  const SQL = await window.initSqlJs({ locateFile: (f) => `sql/${f}` });
  const db = makeDb(new SQL.Database());
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  db.pragma(`user_version = ${MIGRATIONS.length}`);
  window.__demoDb = db;   // core/db.js hands this to the business code
  const [sales, products, reports, seed, returns, udhaar, categories] = await Promise.all([
    import('./sales.js'), import('./products.js'), import('./reports.js'), import('./seed.js'), import('./returns.js'), import('./udhaar.js'), import('./categories.js')]);
  core = { sales, products, reports, returns, udhaar, categories, db };
  seed.seed(core);
})();
ready.catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div class="demo-bar err">The demo could not start: ${e.message}</div>`); });

// every call waits for the database, then behaves like the desktop app's IPC (errors keep their message)
const api = (fn) => async (...a) => { await ready; return fn(...a); };
const backupAt = new Date().toLocaleString('en-IN');

// logins need the desktop app (PINs are checked by its main process); the demo is always the owner
const OWNER = { role: 'owner', name: 'Owner' };
const NO_LOGIN = () => { throw DEMO('owner and salesman logins with PINs work in the desktop app (Settings > Users & PINs).'); };

window.api = {
  userStatus: api(() => ({ loginOn: false, ownerPinSet: false, user: OWNER, choices: [{ who: 'owner', name: 'Owner' }] })),
  login: api(() => OWNER),
  recoverOwner: api(NO_LOGIN),
  logout: api(() => null),
  setOwnerPin: api(NO_LOGIN),
  setLoginOn: api(NO_LOGIN),
  setSalesmanPin: api(NO_LOGIN),
  gstReport: api((r) => core.reports.gstReport(r.from, r.to)),
  // returns and exchanges run on the real business code; credit note PDFs are desktop-only
  returnable: api((n) => core.returns.returnable(n)),
  createReturn: api((n, picks) => core.returns.createReturn(n, picks)),
  getCreditNote: api((no) => core.returns.getCreditNote(no)),
  recentReturns: api(() => core.returns.recentReturns(10)),
  udhaarDue: api((p) => core.udhaar.dueOf(p)),
  udhaarList: api(() => core.udhaar.udhaarList()),
  udhaarAccount: api((p) => core.udhaar.account(p)),
  udhaarReceive: api((p, pay) => core.udhaar.receivePayment(p, pay, { name: 'Owner' },
    core.sales.paymentModes().filter((m) => m.active).map((m) => m.id))),
  udhaarLimit: api((p, l) => core.udhaar.setLimit(p, l)),
  udhaarReceipt: api((n) => core.udhaar.getReceipt(n)),
  saveReceiptPdf: api((n) => 'Receipt-' + n + '.pdf'),
  printStickers: api(() => { window.print(); return { printed: true }; }),
  saveStickerPdf: api(() => { throw DEMO('in the app this saves the sticker sheets as a PDF in the Stock folder.'); }),
  saveCreditPdf: api((no) => `${DATA_DIR}\\Bills\\CreditNote-${no}.pdf`),
  openCreditPdf: api(() => { throw DEMO('in the app this opens the saved credit note PDF. Use Reprint to see it.'); }),
  importPick: api(() => { throw DEMO('in the app you choose an Excel file with your products and see every row before it is imported.'); }),
  importFile: api(() => null),
  importConfirm: api(() => { throw DEMO('no import in the demo.'); }),
  importCancel: api(() => null),
  importTemplate: api(() => { throw DEMO(`in the app this saves Products-import-template.xlsx in ${DATA_DIR}\\Stock and opens it in Excel.`); }),

  listProducts: api((q, c) => core.products.listProducts(q, c)),
  listCategories: api(() => core.categories.listCategories()),
  addCategory: api((c) => core.categories.addCategory(c)),
  updateCategory: api((id, c) => core.categories.updateCategory(id, c)),
  deleteCategory: api((id) => core.categories.deleteCategory(id)),
  setCategoryForItems: api((codes, id) => core.categories.setCategory(codes, id)),
  findProduct: api((s) => core.products.findProduct(s)),
  addStock: api((items) => core.products.addStock(items)),
  adjustStock: api((a) => core.products.adjustStock(a)),
  stockHistory: api((c) => core.products.recentMovements(c)),
  lastStockEntry: api(() => core.products.lastStockEntry()),
  recentAdjustments: api(() => core.products.recentAdjustments(10)),

  createSale: api((s) => core.sales.createSale(s)),
  getSale: api((n) => core.sales.getSale(Number(n))),
  recentBills: api(() => core.sales.recentBills(10)),
  searchCustomers: api((q) => core.sales.searchCustomers(q)),
  listSalesmen: api(() => core.sales.listSalesmen()),
  addSalesman: api((n) => core.sales.addSalesman(n)),
  listAllSalesmen: api(() => core.sales.listAllSalesmen()),
  setSalesmanActive: api((id, on) => core.sales.setSalesmanActive(Number(id), !!on)),
  getSettings: api(() => core.sales.getSettings()),
  saveSettings: api((o) => core.sales.saveSettings(o)),
  completeSetup: api((o) => core.sales.completeSetup(o)),

  salesReport: api((r) => core.reports.salesReport(r.from, r.to, r.filter)),
  stockReport: api((r) => core.reports.stockReport(r.from, r.to)),

  // bills: the desktop app saves PDFs; the demo shows the real bill through the browser's print window
  hasPrinter: api(() => true),
  // the demo prints through the browser's own print window
  printBill: api(() => { window.print(); return { printed: true }; }),
  listPrinters: api(() => [{ name: 'shop', displayName: 'Shop printer (demo)', isDefault: true, virtual: false }]),
  saveBillPdf: api((billNo, kind) => `${DATA_DIR}\\Bills\\Bill-${billNo}${kind === 'duplicate' ? '-DUPLICATE' : ''}.pdf`),
  openBillPdf: api(() => { throw DEMO('in the app this opens the saved bill PDF. Use Reprint to see the bill.'); }),
  openBillsFolder: api(() => ''),
  billsFolder: api(() => `${DATA_DIR}\\Bills`),
  sendWhatsApp: api(() => { throw DEMO('in the app this opens the customer\'s WhatsApp chat with the bill PDF ready to attach.'); }),

  // files and folders
  saveReportXlsx: api((r) => { throw DEMO(`in the app this saves ${r.name} in ${DATA_DIR}\\${r.kind === 'stock' ? 'Stock' : 'Sales'}.`); }),
  saveDataFiles: api(() => { throw DEMO('in the app the Customers, Stock and Sales Excel files update by themselves.'); }),
  dataFilesStatus: api(() => ({ at: backupAt, error: null, saved: [] })),
  listFolders: api(() => ({
    dir: DATA_DIR,
    subs: [['database', 'Database', 'Database'], ['bills', 'Bills (PDF)', 'Bills'], ['backup', 'Backups', 'Backups'],
      ['customers', 'Customers (Excel)', 'Customers'], ['stock_files', 'Stock (Excel and reports)', 'Stock'],
      ['sales_files', 'Sales (Excel and reports)', 'Sales']]
      .map(([name, label, sub]) => ({ name, label, dir: `${DATA_DIR}\\${sub}` })),
  })),
  openFolder: api(() => { throw DEMO('in the app this opens the folder in Windows Explorer.'); }),
  moveDataFolder: api(() => { throw DEMO('in the app this copies all data to another folder.'); }),
  backupStatus: api(() => ({ dir: `${DATA_DIR}\\Backups`, at: backupAt, error: null })),
  cloudStatus: api(() => ({ dir: 'G:\\My Drive\\Stock Galaxy Backup', suggested: null, at: backupAt, copied: 0, error: null })),
  chooseCloudDir: api(() => { throw DEMO('in the app you choose a Google Drive folder and backups, bills and Excel files are copied there.'); }),
  stopCloudCopy: api(() => { throw DEMO('the Google Drive copy keeps running in this demo.'); }),
  copyToCloudNow: api(() => ({ dir: 'G:\\My Drive\\Stock Galaxy Backup', at: new Date().toLocaleString('en-IN'), copied: 0, error: null })),
  pickBackup: api(() => { throw DEMO('in the app this restores a backup from this PC or from the Google Drive copy.'); }),
  restoreBackup: api(() => { throw DEMO('no restore in the demo.'); }),
  runBackup: api(() => ({ dir: `${DATA_DIR}\\Backups`, at: new Date().toLocaleString('en-IN'), error: null })),

  // app, licence and updates
  appInfo: api(() => ({
    name: 'Stock Galaxy App', version: APP_VERSION, installId: 'demo', monitoringConfigured: false, activated: false,
    licence: { status: 'off' }, notice: null, lastSync: { at: null, ok: null, error: null }, locked: false, message: null,
    lockWarning: null, updateRequired: false, heartbeatMinutes: 60, update: { status: 'current' },
  })),
  syncNow: api(() => { throw DEMO('no licence server in the demo.'); }),
  setControlKey: api(() => { throw DEMO('no licence server in the demo.'); }),
  checkUpdate: api(() => ({ status: 'current' })),
  downloadUpdate: api(() => null),
  installUpdate: api(() => ({ ok: false, reason: 'Demo' })),
  onUpdateStatus: () => {},
  onPageAction: () => {},
};
