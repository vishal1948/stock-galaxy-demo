// The app's business code (sales.js, products.js, reports.js) talks to better-sqlite3. In the browser demo
// the same SQL runs on sql.js (SQLite compiled to WebAssembly); this wraps it in the small part of the
// better-sqlite3 API the app uses: prepare().get/all/run, transaction(), exec(), pragma().
export function makeDb(sqlDb) {
  // better-sqlite3 takes named values as { name } for "@name"; sql.js wants the prefix in the key
  const params = (args) => {
    if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]))
      return Object.fromEntries(Object.entries(args[0]).map(([k, v]) => [`@${k}`, v === undefined ? null : v]));
    return args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  };
  const withStmt = (sql, args, fn) => {
    const st = sqlDb.prepare(sql);
    try { st.bind(params(args)); return fn(st); } finally { st.free(); }
  };
  let depth = 0;

  return {
    prepare(sql) {
      return {
        get: (...a) => withStmt(sql, a, (st) => (st.step() ? st.getAsObject() : undefined)),
        all: (...a) => withStmt(sql, a, (st) => { const out = []; while (st.step()) out.push(st.getAsObject()); return out; }),
        run: (...a) => {
          withStmt(sql, a, (st) => { st.step(); });
          return { changes: sqlDb.getRowsModified(), lastInsertRowid: sqlDb.exec('SELECT last_insert_rowid()')[0].values[0][0] };
        },
      };
    },
    // nested transactions (setup saves settings inside its own transaction) use savepoints
    transaction(fn) {
      return (...a) => {
        const name = `t${++depth}`;
        sqlDb.run(`SAVEPOINT ${name}`);
        try { const r = fn(...a); sqlDb.run(`RELEASE ${name}`); return r; }
        catch (e) { sqlDb.run(`ROLLBACK TO ${name}`); sqlDb.run(`RELEASE ${name}`); throw e; }
        finally { depth--; }
      };
    },
    exec: (sql) => sqlDb.exec(sql),
    pragma(text, opts = {}) {
      const r = sqlDb.exec(`PRAGMA ${text}`);
      if (opts.simple) return r[0]?.values[0]?.[0];
      return r[0] ? r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]]))) : [];
    },
    raw: sqlDb,
  };
}
