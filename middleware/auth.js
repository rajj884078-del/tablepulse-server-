const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
let db;

async function getDb() {
  if (db) return db;
  const client = await MongoClient.connect(MONGODB_URI);
  db = client.db('tablepulse');
  return db;
}

function generateToken(pin) {
  const payload = `${pin}:${Date.now()}:${process.env.WEBHOOK_VERIFY_TOKEN}`;
  return Buffer.from(payload).toString('base64');
}

async function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [pin] = decoded.split(':');
    const db = await getDb();
    const restaurant = await db.collection('restaurants').findOne({ pin });
    return restaurant || null;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  const restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Invalid token' });
  req.restaurant = restaurant;
  next();
}

async function findRestaurantByPin(pin) {
  const db = await getDb();
  return db.collection('restaurants').findOne({ pin: pin.trim() });
}

module.exports = { generateToken, verifyToken, requireAuth, findRestaurantByPin };
