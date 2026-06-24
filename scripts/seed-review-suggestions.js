require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'tablepulse_staging';
const COLLECTION = 'review_suggestions';
const JSON_FILE = path.join(__dirname, '..', 'winendine_reviews_mongo.json');
const TEST_PIN = '1111';

async function seed() {
  if (!MONGODB_URI) { console.error('MONGODB_URI not set'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  console.log(`Loaded ${raw.length} reviews from JSON`);

  const client = await MongoClient.connect(MONGODB_URI);
  const db = client.db(DB_NAME);
  const col = db.collection(COLLECTION);

  await col.drop().catch(() => {});
  console.log(`Dropped existing ${COLLECTION} collection`);

  const docs = [
    ...raw,
    ...raw.map(r => ({ ...r, restaurantPin: TEST_PIN })),
  ];

  await col.insertMany(docs);
  console.log(`Inserted ${docs.length} documents (${raw.length} for pin ${raw[0].restaurantPin}, ${raw.length} for pin ${TEST_PIN})`);

  await col.createIndex({ restaurantPin: 1, stars: 1 });
  console.log('Created compound index {restaurantPin, stars}');

  const counts = await col.aggregate([
    { $group: { _id: { pin: '$restaurantPin', stars: '$stars' }, n: { $sum: 1 } } },
    { $sort: { '_id.pin': 1, '_id.stars': 1 } }
  ]).toArray();
  console.log('\nCollection summary:');
  counts.forEach(c => console.log(`  pin=${c._id.pin}  stars=${c._id.stars}  count=${c.n}`));

  await client.close();
  console.log('\nDone.');
}

seed().catch(e => { console.error(e); process.exit(1); });
