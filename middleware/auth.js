const mongoose = require('mongoose');

const restaurantSchema = new mongoose.Schema({
  name: String,
  pin: { type: String, unique: true },
  googleReviewLink: String,
  avgDrinkMins: { type: Number, default: 10 },
  avgStarterMins: { type: Number, default: 20 },
  avgMainMins: { type: Number, default: 35 }
});

const Restaurant = mongoose.models.Restaurant || mongoose.model('Restaurant', restaurantSchema);

function generateToken(pin) {
  const payload = `${pin}:${Date.now()}:${process.env.WEBHOOK_VERIFY_TOKEN}`;
  return Buffer.from(payload).toString('base64');
}

async function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [pin] = decoded.split(':');
    const restaurant = await Restaurant.findOne({ pin });
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

module.exports = { Restaurant, generateToken, verifyToken, requireAuth };
