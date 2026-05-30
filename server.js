require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const { generateToken, verifyToken, requireAuth, findRestaurantByPin } = require('./middleware/auth');

const app = express();
// Render runs behind a proxy; needed for correct client IPs in rate limiting.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

const TOKEN         = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID      = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI   = process.env.MONGODB_URI;
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;
const ADMIN_KEY     = process.env.ADMIN_KEY; // required header for /admin/* API calls

if (!ADMIN_KEY) console.warn('[boot] ADMIN_KEY not set — admin API routes will reject all requests.');

const DEFAULT_REVIEW_LINK = 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9';
const DEFAULT_RESTAURANT  = 'Gravity Family Dine and Bar';
const ACTIVE_ORDERS_LIMIT = 50;
const COURSE_TYPES = ['drinks', 'starters', 'main'];
const COURSE_STATUSES = ['waiting', 'started', 'ready'];

let db;
MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('tablepulse');
  console.log('MongoDB connected');
  scheduleWeeklyReports();
}).catch(err => {
  console.error('[boot] MongoDB connection failed:', err.message);
});

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,            // 10 PIN attempts per IP / 15 min
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,                 // 60 writes per IP / min (busy floor headroom)
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many admin requests.' }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10)                       return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0'))  return '+91' + d.slice(1);
  return '+' + d;
}

// Validate an Indian mobile (10 digits, or with 91/0 prefix). Returns true/false.
function isValidPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 || (d.length === 12 && d.startsWith('91')) || (d.length === 11 && d.startsWith('0'));
}

// Safe ObjectId construction. Returns null on invalid input instead of throwing.
function toObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

// Trim + length-cap a string field. Returns null if missing/invalid.
function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// Admin API guard: constant-time compare of x-admin-key header.
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || typeof key !== 'string') return res.status(403).json({ ok: false, error: 'Forbidden' });
  const a = Buffer.from(key), b = Buffer.from(ADMIN_KEY);
  const crypto = require('crypto');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  next();
}

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) { console.error('[aisensy] AISENSY_API_KEY not set'); return; }
  try {
    await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', {
      apiKey: AISENSY_API_KEY, campaignName, destination: formatPhone(phone),
      userName: orderName, source: 'tablepulse-server', templateParams
    }, { timeout: 10000 });
    console.log('[aisensy] sent ' + campaignName + ' to ' + formatPhone(phone));
  } catch (err) {
    console.error('[aisensy] failed ' + campaignName + ':', err.response ? err.response.data : err.message);
  }
}

function getParams(stage, name, extras) {
  extras = extras || {};
  const rName = extras.restaurantName || DEFAULT_RESTAURANT;
  const rLink = extras.reviewLink     || DEFAULT_REVIEW_LINK;
  if (stage === 'order_received')  return [name, String(extras.table || ''), rName];
  if (stage === 'order_preparing') return [name];
  if (stage === 'order_arriving')  return [name];
  if (stage === 'order_delay')     return [name];
  if (stage === 'review_request')  return [name, rLink];
  return [name];
}

// ── Weekly report ─────────────────────────────────────────────────────────────
async function buildWeeklyReport(restaurant) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const orders = await db.collection('orders').find({
    restaurantPin: restaurant.pin, createdAt: { $gte: weekAgo }
  }).toArray();
  const total = orders.length;
  const done  = orders.filter(o => o.status === 'done').length;
  const mainTimes = orders.filter(o => o.mainStartedAt && o.completedAt)
    .map(o => (new Date(o.completedAt) - new Date(o.mainStartedAt)) / 60000);
  const avgMain = mainTimes.length ? Math.round(mainTimes.reduce((a, b) => a + b, 0) / mainTimes.length) : 0;
  const reviewsSent = orders.filter(o => o.reviewSent).length;
  return { total, done, avgMain, reviewsSent };
}

async function sendWeeklyReport(restaurant) {
  if (!restaurant.ownerPhone) { console.log('[report] no ownerPhone for ' + restaurant.name + ', skipping'); return; }
  try {
    const s = await buildWeeklyReport(restaurant);
    await sendWhatsApp('weekly_report', restaurant.ownerPhone, restaurant.name,
      [restaurant.name, String(s.total), String(s.done), String(s.avgMain || 0), String(s.reviewsSent)]);
    console.log('[report] sent to ' + restaurant.name);
  } catch (e) { console.error('[report] failed for ' + restaurant.name + ':', e.message); }
}

function scheduleWeeklyReports() {
  function msUntilNextMonday9am() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    const daysUntilMon = day === 1 ? (ist.getHours() < 9 ? 0 : 7) : (8 - day) % 7 || 7;
    const next = new Date(ist);
    next.setDate(ist.getDate() + daysUntilMon);
    next.setHours(9, 0, 0, 0);
    return next.getTime() - ist.getTime();
  }
  function runReports() {
    console.log('[report] Running Monday weekly reports...');
    db.collection('restaurants').find({}).toArray()
      .then(restaurants => restaurants.forEach(sendWeeklyReport))
      .catch(e => console.error('[report] scheduler error:', e.message));
    setTimeout(runReports, 7 * 24 * 60 * 60 * 1000);
  }
  setTimeout(runReports, msUntilNextMonday9am());
}

// ── Webhook (Meta verification) ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

// ── ORDER CREATED ─────────────────────────────────────────────────────────────
// Auth required: order is bound to the caller's restaurant, not client-supplied data.
app.post('/order', writeLimiter, requireAuth, async (req, res) => {
  const orderName = cleanStr(req.body.orderName, 60);
  const phone     = req.body.phone;
  const table     = cleanStr(String(req.body.table || ''), 10);
  if (!orderName) return res.status(400).json({ error: 'Customer name required' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Valid WhatsApp number required' });
  if (!table) return res.status(400).json({ error: 'Table required' });

  // Sanitize courses against an allow-list; never trust shape from client.
  const rawCourses = Array.isArray(req.body.courses) ? req.body.courses : [];
  const courses = rawCourses
    .filter(c => c && COURSE_TYPES.includes(c.type))
    .map(c => ({
      type: c.type,
      qty: Math.min(Math.max(parseInt(c.qty, 10) || 1, 1), 99),
      status: 'waiting'
    }));
  if (!courses.length) return res.status(400).json({ error: 'At least one course required' });

  const sameTime = req.body.sameTime === true;
  const toK = req.body.toK !== false;
  const toB = req.body.toB !== false;

  const rest = req.restaurant;
  const restaurantName = rest.name || DEFAULT_RESTAURANT;
  const reviewLink = rest.googleReviewLink || DEFAULT_REVIEW_LINK;

  try {
    await db.collection('orders').insertOne({
      phone: String(phone).replace(/\D/g, ''), orderName, table, courses, sameTime, toK, toB,
      bNotified: false, status: 'active',
      restaurantPin: rest.pin, restaurantName, reviewLink,
      reviewSent: false, createdAt: new Date()
    });
  } catch (e) {
    console.error('[order] insert failed:', e.message);
    return res.status(500).json({ error: 'Could not save order' });
  }
  res.json({ status: 'ok' });
  await sendWhatsApp('table_order_received_v2', phone, orderName,
    getParams('order_received', orderName, { table, restaurantName }));
});

// ── ACTIVE ORDERS (scoped to caller's restaurant) ──────────────────────────────
app.get('/active-orders', requireAuth, async (req, res) => {
  try {
    const orders = await db.collection('orders')
      .find({ status: { $ne: 'done' }, restaurantPin: req.restaurant.pin })
      .sort({ createdAt: -1 }).limit(ACTIVE_ORDERS_LIMIT).toArray();
    res.json(orders.map(o => Object.assign({}, o, { _id: o._id.toString() })));
  } catch (e) {
    console.error('[active-orders]', e.message);
    res.status(500).json({ error: 'Could not load orders' });
  }
});

// Load an order and assert it belongs to the authenticated restaurant.
// Returns the order doc, or sends the appropriate error response and returns null.
async function loadOwnedOrder(req, res) {
  const oid = toObjectId(req.body.orderId);
  if (!oid) { res.status(400).json({ error: 'Invalid order id' }); return null; }
  const order = await db.collection('orders').findOne({ _id: oid });
  if (!order) { res.status(404).json({ error: 'Order not found' }); return null; }
  if (order.restaurantPin !== req.restaurant.pin) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return order;
}

// ── UPDATE COURSE ─────────────────────────────────────────────────────────────
app.post('/update-course', writeLimiter, requireAuth, async (req, res) => {
  const { courseType, status } = req.body;
  if (!COURSE_TYPES.includes(courseType) || !COURSE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid course or status' });
  }
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  try {
    const upd = { $set: { 'courses.$.status': status } };
    if (courseType === 'main' && status === 'started') upd.$set.mainStartedAt = new Date();
    if (courseType === 'main' && status === 'ready')   upd.$set.mainStartedAt = null;
    await db.collection('orders').updateOne({ _id: order._id, 'courses.type': courseType }, upd);
    res.json({ status: 'ok' });
    if (courseType === 'main' && status === 'started')
      await sendWhatsApp('table_order_preparing_v2', order.phone, order.orderName, getParams('order_preparing', order.orderName));
    if (courseType === 'main' && status === 'ready')
      await sendWhatsApp('table_order_arriving_v2', order.phone, order.orderName, getParams('order_arriving', order.orderName));
  } catch (e) {
    console.error('[update-course]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Update failed' });
  }
});

// ── NOTIFY BAR ────────────────────────────────────────────────────────────────
app.post('/notify-bar', writeLimiter, requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  try {
    await db.collection('orders').updateOne({ _id: order._id }, { $set: { bNotified: true } });
    res.json({ status: 'ok' });
  } catch (e) { console.error('[notify-bar]', e.message); res.status(500).json({ error: 'Failed' }); }
});

// ── ORDER DONE ────────────────────────────────────────────────────────────────
app.post('/order-done', writeLimiter, requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  try {
    await db.collection('orders').updateOne({ _id: order._id }, { $set: { status: 'done', completedAt: new Date() } });
    res.json({ status: 'ok' });
  } catch (e) { console.error('[order-done]', e.message); res.status(500).json({ error: 'Failed' }); }
});

// ── REVIEW REQUEST ────────────────────────────────────────────────────────────
app.post('/review', writeLimiter, requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  try {
    await db.collection('orders').updateOne({ _id: order._id }, { $set: { reviewSent: true } });
    res.json({ status: 'ok' });
    const reviewLink = order.reviewLink || req.restaurant.googleReviewLink || DEFAULT_REVIEW_LINK;
    await sendWhatsApp('table_review_request_v2', order.phone, order.orderName,
      getParams('review_request', order.orderName, { reviewLink }));
  } catch (e) { console.error('[review]', e.message); if (!res.headersSent) res.status(500).json({ error: 'Failed' }); }
});

// ── ORDER DELAY ───────────────────────────────────────────────────────────────
app.post('/order-delay', writeLimiter, requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  res.json({ status: 'ok' });
  await sendWhatsApp('table_order_delay_v2', order.phone, order.orderName, getParams('order_delay', order.orderName));
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
// The page itself holds no data — it prompts for the admin key, and every
// /admin/* API call below is gated by requireAdmin (x-admin-key). Real security
// is the key, not the URL, so the page lives at a fixed path.
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: './public' }));

app.get('/admin/restaurants', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const list = await db.collection('restaurants').find({}).toArray();
    res.json(list.map(r => Object.assign({}, r, { _id: r._id.toString() })));
  } catch (e) { console.error('[admin/restaurants]', e.message); res.status(500).json({ error: 'Failed' }); }
});

app.post('/admin/add-restaurant', adminLimiter, requireAdmin, async (req, res) => {
  const name = cleanStr(req.body.name, 80);
  const pin  = cleanStr(String(req.body.pin || ''), 6);
  if (!name || !pin || !/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: 'Name and 4-6 digit PIN required' });
  }
  const ownerPhone = isValidPhone(req.body.ownerPhone) ? String(req.body.ownerPhone).replace(/\D/g, '') : '';
  const googleReviewLink = cleanStr(req.body.googleReviewLink, 300) || '';
  const num = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), 240);
  try {
    if (await db.collection('restaurants').findOne({ pin })) {
      return res.status(409).json({ ok: false, error: 'PIN already exists' });
    }
    await db.collection('restaurants').insertOne({
      name, pin, ownerPhone, googleReviewLink,
      avgDrinkMins: num(req.body.avgDrinkMins, 8),
      avgStarterMins: num(req.body.avgStarterMins, 18),
      avgMainMins: num(req.body.avgMainMins, 30),
      createdAt: new Date()
    });
    console.log('[admin] added restaurant: ' + name);
    res.json({ ok: true });
  } catch (e) { console.error('[admin/add]', e.message); res.status(500).json({ ok: false, error: 'Failed' }); }
});

app.post('/admin/delete-restaurant', adminLimiter, requireAdmin, async (req, res) => {
  const oid = toObjectId(req.body.id);
  if (!oid) return res.status(400).json({ ok: false, error: 'Invalid id' });
  try {
    await db.collection('restaurants').deleteOne({ _id: oid });
    res.json({ ok: true });
  } catch (e) { console.error('[admin/delete]', e.message); res.status(500).json({ ok: false, error: 'Failed' }); }
});

app.post('/admin/send-report', adminLimiter, requireAdmin, async (req, res) => {
  const pin = cleanStr(String(req.body.pin || ''), 6);
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN required' });
  try {
    const restaurant = await db.collection('restaurants').findOne({ pin });
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found' });
    if (!restaurant.ownerPhone) return res.status(400).json({ ok: false, error: 'No owner phone set' });
    await sendWeeklyReport(restaurant);
    res.json({ ok: true });
  } catch (e) { console.error('[admin/send-report]', e.message); res.status(500).json({ ok: false, error: 'Failed' }); }
});

// ── TEST ENDPOINT (admin-only; kept for debugging) ──────────────────────────────
app.get('/test-whatsapp', adminLimiter, requireAdmin, async (req, res) => {
  const { stage } = req.query;
  const name = cleanStr(String(req.query.name || ''), 60);
  if (!isValidPhone(req.query.phone) || !name || !stage) {
    return res.status(400).json({ error: 'Required: valid phone, name, stage' });
  }
  const campaigns = {
    order_received: 'table_order_received_v2', order_preparing: 'table_order_preparing_v2',
    order_arriving: 'table_order_arriving_v2', order_delay: 'table_order_delay_v2',
    review_request: 'table_review_request_v2'
  };
  const campaignName = campaigns[stage];
  if (!campaignName) return res.status(400).json({ error: 'Unknown stage' });
  const params = getParams(stage, name, { table: '7', restaurantName: DEFAULT_RESTAURANT, reviewLink: DEFAULT_REVIEW_LINK });
  await sendWhatsApp(campaignName, req.query.phone, name, params);
  res.json({ ok: true, campaign: campaignName });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/login', loginLimiter, async (req, res) => {
  const pin = cleanStr(String(req.body.pin || ''), 6);
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const restaurant = await findRestaurantByPin(pin);
  if (!restaurant) return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  const token = generateToken(pin);
  res.json({
    token, restaurantName: restaurant.name, googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins, avgStarterMins: restaurant.avgStarterMins, avgMainMins: restaurant.avgMainMins
  });
});

app.get('/verify', requireAuth, (req, res) => {
  res.json({ restaurantName: req.restaurant.name });
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
