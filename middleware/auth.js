const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

// Server-side signing secret. MUST be set in production.
// Falls back to WEBHOOK_VERIFY_TOKEN so existing deploys don't break,
// but logs a warning so it gets fixed.
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.WEBHOOK_VERIFY_TOKEN;
if (!process.env.AUTH_SECRET) {
  console.warn('[auth] AUTH_SECRET not set — falling back to WEBHOOK_VERIFY_TOKEN. Set AUTH_SECRET in production.');
}

// Tokens expire after this many days. Staff re-enter PIN after expiry.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let db;
async function getDb() {
  if (db) return db;
  const client = await MongoClient.connect(MONGODB_URI);
  db = client.db('tablepulse');
  return db;
}

function sign(payload) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
}

// token = base64( pin:issuedAt:signature )
function generateToken(pin) {
  const issuedAt = Date.now();
  const payload = pin + ':' + issuedAt;
  const sig = sign(payload);
  return Buffer.from(payload + ':' + sig).toString('base64');
}

// Returns the restaurant document if the token is valid, signed, and unexpired.
// Returns null otherwise. Never throws.
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [pin, issuedAtStr, sig] = parts;

    // Recompute signature over the payload and compare in constant time.
    const expectedSig = sign(pin + ':' + issuedAtStr);
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    // Expiry check.
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!issuedAt || Date.now() - issuedAt > TOKEN_TTL_MS) return null;

    const database = await getDb();
    return await database.collection('restaurants').findOne({ pin });
  } catch (e) {
    return null;
  }
}

// Express middleware: attaches req.restaurant or returns 401.
async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  req.restaurant = restaurant;
  next();
}

async function findRestaurantByPin(pin) {
  if (!pin || typeof pin !== 'string') return null;
  const database = await getDb();
  return database.collection('restaurants').findOne({ pin: pin.trim() });
}

module.exports = { generateToken, verifyToken, requireAuth, findRestaurantByPin };
