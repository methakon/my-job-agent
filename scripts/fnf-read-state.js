const { DataSource } = require('typeorm');

async function main() {
  let ds;
  try {
    const m = require('./dist/main');
    ds = m.dataSource || (m.app && typeof m.app.getDataSource === 'function' ? m.app.getDataSource() : null);
  } catch (e) {}
  if (!ds) {
    try {
      const m = require('./dist/app');
      ds = m.dataSource || (m.app && typeof m.app.getDataSource === 'function' ? m.app.getDataSource() : null);
    } catch (e) {}
  }
  if (!ds) {
    console.log('NO_DS');
    process.exit(1);
  }
  const snapRepo = ds.getRepository('FnfMarketSnapshot');
  const instruments = await snapRepo.createQueryBuilder('s').select('DISTINCT s.instrument', 'i').getRawMany();
  const out = [];
  for (const { i: instrument } of instruments) {
    const rows = await snapRepo.find({ where: { instrument }, order: { ts: 'DESC' }, take: 3 });
    if (!rows.length) continue;
    const latest = rows[0];
    const prev = rows[1];
    out.push({
      instrument,
      latest: { price: latest.price, ts: latest.ts, volume: latest.volume },
      prev: prev ? { price: prev.price, ts: prev.ts } : null,
      changePct: prev && prev.price ? ((latest.price - prev.price) / prev.price * 100) : null,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
