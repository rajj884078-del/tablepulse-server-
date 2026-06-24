require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const fs   = require('fs');
const path = require('path');

const MONGODB_URI   = process.env.MONGODB_URI;
const DB_NAME       = 'tablepulse_staging';
const COLLECTION    = 'category_suggestions';

async function seed() {
  if (!MONGODB_URI) { console.error('MONGODB_URI not set'); process.exit(1); }

  const client = await MongoClient.connect(MONGODB_URI);
  const db     = client.db(DB_NAME);
  const col    = db.collection(COLLECTION);

  await col.drop().catch(() => {});
  console.log(`Dropped existing ${COLLECTION} collection`);

  // ── 1. Category reviews (salon / cafe / tattoo / clinic / gym) ──────────────
  const catFile = path.join(__dirname, '..', 'category_review_suggestions.json');
  const catDocs = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  console.log(`Loaded ${catDocs.length} category docs from ${path.basename(catFile)}`);

  // ── 2. Wine N Dine reviews → category "restaurant" ──────────────────────────
  const wndFile = path.join(__dirname, '..', 'winendine_reviews_mongo.json');
  const wndRaw  = JSON.parse(fs.readFileSync(wndFile, 'utf8'));
  const seen    = new Set();
  const wndDocs = [];
  for (const r of wndRaw) {
    if (seen.has(r.text)) continue;
    seen.add(r.text);
    wndDocs.push({ category: 'restaurant', stars: r.stars, text: r.text });
  }
  console.log(`Loaded ${wndDocs.length} unique restaurant docs from ${path.basename(wndFile)}`);

  // ── 3. Insert all ────────────────────────────────────────────────────────────
  const all = [...catDocs, ...wndDocs];
  await col.insertMany(all);
  console.log(`Inserted ${all.length} total documents`);

  // ── 4. Index ─────────────────────────────────────────────────────────────────
  await col.createIndex({ category: 1, stars: 1 });
  console.log('Created compound index {category, stars}');

  // ── 5. Summary ───────────────────────────────────────────────────────────────
  const counts = await col.aggregate([
    { $group: { _id: { category: '$category', stars: '$stars' }, n: { $sum: 1 } } },
    { $sort:  { '_id.category': 1, '_id.stars': 1 } }
  ]).toArray();
  console.log('\nCollection summary:');
  counts.forEach(c => console.log(`  category=${c._id.category}  stars=${c._id.stars}  count=${c.n}`));

  await client.close();
  console.log('\nDone.');
}

seed().catch(e => { console.error(e); process.exit(1); });
