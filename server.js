require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const { generateToken, verifyToken, requireAuth, findRestaurantByPin } = require('./middleware/auth');
const path = require('path');
const webpush = require('web-push');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK from env var
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseInitialized = true;
    console.log('[firebase] Admin SDK initialized');
  } else {
    console.warn('[firebase] FIREBASE_SERVICE_ACCOUNT not set — FCM disabled');
  }
} catch (e) {
  console.error('[firebase] init failed:', e.message);
}

const app = express();
// Render runs behind a proxy; needed for correct client IPs in rate limiting.
app.set('trust proxy', 1);
app.use(cors());

// Razorpay webhook needs raw body BEFORE express.json() parses it.
// Send FCM push notification to all registered devices for a restaurant.
async function sendFCMToRestaurant(restaurantPin, title, body, data, targetRole) {
  if (!firebaseInitialized) return;
  try {
    const query = targetRole ? { restaurantPin, role: targetRole } : { restaurantPin };
    const tokens = await db.collection('fcm_tokens').find(query).toArray();
    if (!tokens.length) return;
    console.log('[fcm] sending to ' + tokens.length + ' devices for pin=' + restaurantPin);
    const tokenList = tokens.map(t => t.token);
    const message = {
      notification: { title, body },
      data: { ...(data || {}), title, body },
      android: {
        priority: 'high',
        ttl: 30000,
        notification: {
          sound: 'default',
          priority: 'max',
          channelId: 'tablepulse_v2',
          defaultSound: true,
          vibrateTimingsMillis: [0, 300, 200, 300],
          notificationCount: 1
        }
      },
      tokens: tokenList
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('[fcm] sent ' + response.successCount + '/' + tokens.length + ' messages');
    // Remove invalid tokens
    const dead = [];
    response.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/invalid-registration-token' ||
          r.error?.code === 'messaging/registration-token-not-registered')) {
        dead.push(tokenList[i]);
      }
    });
    if (dead.length) await db.collection('fcm_tokens').deleteMany({ token: { $in: dead } });
  } catch (e) { console.error('[fcm] send error:', e.message); }
}

// ── RAZORPAY WEBHOOK ──────────────────────────────────────────────────────────
// Must use raw body for signature verification — mount before express.json().
// We use a dedicated raw-body parser only on this route.
app.post('/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.sendStatus(500);
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.sendStatus(400);

    // Verify HMAC-SHA256 signature.
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(req.body).digest('hex');
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[razorpay-webhook] invalid signature — rejected');
      return res.sendStatus(400);
    }

    let event;
    try { event = JSON.parse(req.body.toString()); }
    catch (e) { return res.sendStatus(400); }

    if (event.event !== 'payment.captured') return res.sendStatus(200); // ignore other events

    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if (!payment) return res.sendStatus(400);

    const pin  = payment.notes && cleanStr(String(payment.notes.pin || ''), 6);
    const plan = payment.notes && payment.notes.plan;

    if (!pin || !PLAN_DAYS[plan]) {
      console.warn('[razorpay-webhook] missing pin/plan in notes — amount: ' + payment.amount);
      return res.sendStatus(200); // acknowledge but log — manual admin intervention needed
    }

    const restaurant = await db.collection('restaurants').findOne({ pin });
    if (!restaurant) {
      console.warn('[razorpay-webhook] unknown PIN: ' + pin);
      return res.sendStatus(200);
    }

    const { newExpiry } = await renewRestaurant(pin, plan);

    // Send confirmation WhatsApp to owner.
    if (restaurant.ownerPhone) {
      const expiryStr = newExpiry.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      await sendWhatsApp('subscription_confirmed', restaurant.ownerPhone, restaurant.name,
        [restaurant.name, plan === 'yearly' ? 'Yearly' : 'Monthly', expiryStr]);
    }

    res.sendStatus(200);
  }
);

app.use(express.json({ limit: '64kb' }));

const TOKEN         = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID      = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI   = process.env.MONGODB_URI;
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;
const ADMIN_KEY              = process.env.ADMIN_KEY;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const RAZORPAY_KEY_ID         = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET;

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL       = process.env.VAPID_EMAIL || 'mailto:rajj884078@gmail.com';

// Configure web-push VAPID
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[push] VAPID configured');
} else {
  console.warn('[push] VAPID keys not set — push notifications disabled');
}

if (!ADMIN_KEY)               console.warn('[boot] ADMIN_KEY not set — admin API routes will reject all requests.');
if (!RAZORPAY_WEBHOOK_SECRET) console.warn('[boot] RAZORPAY_WEBHOOK_SECRET not set — payment webhooks will be rejected.');

// Razorpay subscription plans
const PLAN_AMOUNT  = { monthly: 210000, yearly: 2100000 }; // paise
const PLAN_DAYS    = { monthly: 30, yearly: 365 };
const WARN_DAYS    = 5; // send reminder this many days before expiry

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
  scheduleWeeklyAnalytics();
  scheduleSubscriptionChecks();
  scheduleAutoArchive();
  scheduleCustomerLogClear();
  scheduleAnalyticsCleanup();
}).catch(err => {
  console.error('[boot] MongoDB connection failed:', err.message);
});

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
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

function isValidPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 || (d.length === 12 && d.startsWith('91')) || (d.length === 11 && d.startsWith('0'));
}

function toObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// Generate a URL-safe slug from restaurant name.
function makeSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

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

// Send push notification to all subscribed devices for a restaurant.
async function sendPushToRestaurant(restaurantPin, title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const subs = await db.collection('subscriptions').find({ restaurantPin }).toArray();
    console.log('[push] looking for pin=' + restaurantPin + ' found=' + subs.length + ' subs');
    const payload = JSON.stringify({ title, body, url, tag: restaurantPin });
    const dead = [];
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub._id);
        else console.error('[push] send failed status=' + e.statusCode + ' body=' + JSON.stringify(e.body) + ' msg=' + e.message);
      }
    }));
    // Remove expired subscriptions
    if (dead.length) await db.collection('subscriptions').deleteMany({ _id: { $in: dead } });
  } catch (e) { console.error('[push] error:', e.message); }
}

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) { console.error('[aisensy] AISENSY_API_KEY not set'); return; }
  try {
    console.log('[aisensy] calling campaign=' + campaignName + ' to=' + formatPhone(phone) + ' params=' + JSON.stringify(templateParams));
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
  if (stage === 'order_received')  return [name, rName, String(extras.table || '')];
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

// ── Landing page (for Razorpay and any direct visitors) ───────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TablePulse — Restaurant Automation</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;}
    .card{text-align:center;max-width:480px;}
    h1{font-size:2rem;font-weight:800;margin-bottom:.5rem;}
    h1 span{color:#3fb950;}
    p{color:#7d8590;font-size:1rem;line-height:1.6;margin-bottom:2rem;}
    .badge{display:inline-block;background:#13261a;color:#3fb950;border:1px solid #238636;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:600;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Table<span>Pulse</span></h1>
    <p>WhatsApp automation for dine-in restaurants.<br>Keep customers informed. Get more Google reviews.</p>
    <span class="badge">🟢 System operational</span>
  </div>
</body>
</html>`);
});

// ── Webhook (Meta verification) ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

// ── ORDER CREATED ─────────────────────────────────────────────────────────────
app.post('/order', writeLimiter, requireAuth, async (req, res) => {
  const orderName = cleanStr(req.body.orderName, 60);
  const phone     = req.body.phone;
  const table     = cleanStr(String(req.body.table || ''), 10);
  if (!orderName) return res.status(400).json({ error: 'Customer name required' });
  if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Valid WhatsApp number required' });
  if (!table) return res.status(400).json({ error: 'Table required' });

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
  db.collection('customer_log').insertOne({
    restaurantPin: rest.pin,
    name: orderName,
    phone: String(phone || '').replace(/\D/g, ''),
    table,
    timestamp: new Date()
  }).catch(e => console.error('[customer-log] insert failed:', e.message));
  res.json({ status: 'ok' });
  // Push notification to kitchen + bar devices
  sendPushToRestaurant(rest.pin,
    'New Order — Table ' + table,
    orderName + ' · ' + courses.map(c=>c.type).join(', '),
    '/r/' + (rest.slug || '') + '/kitchen'
  );
  sendFCMToRestaurant(rest.pin,
    'New Order — Table ' + table,
    orderName + ' · ' + courses.map(c=>c.type).join(', '),
    { table: String(table), type: 'new_order', role: 'kitchen' },
    'kitchen'
  );
  sendFCMToRestaurant(rest.pin,
    'New Order — Table ' + table,
    orderName + ' · drinks',
    { table: String(table), type: 'new_order', role: 'bar' },
    'bar'
  );
  if (phone && phone.length >= 10) {
    console.log('[order] sending order_received to phone=' + phone + ' name=' + orderName + ' table=' + table + ' courses=' + JSON.stringify(courses.map(c=>c.type)));
    await sendWhatsApp('table_order_received_v3', phone, orderName,
      getParams('order_received', orderName, { table, restaurantName }));
  } else {
    console.log('[order] no phone — skipping WhatsApp for table=' + table);
  }
});

// ── ACTIVE ORDERS ──────────────────────────────────────────────────────────────
// ── TABLE STATUS ─────────────────────────────────────────────────────────────
// Manager screen — aggregated table status from active orders
app.get('/table-status', requireAuth, async (req, res) => {
  try {
    const orders = await db.collection('orders')
      .find({ status: { $ne: 'done' }, restaurantPin: req.restaurant.pin })
      .sort({ createdAt: 1 }).toArray();
    const tables = {};
    orders.forEach(o => {
      const t = String(o.table);
      const courses = o.courses || [];
      const allReady = courses.length > 0 && courses.every(c => c.status === 'ready' || c.status === 'served');
      const anyPending = courses.some(c => c.status === 'waiting' || c.status === 'started');
      const minutesElapsed = Math.round((new Date() - new Date(o.createdAt)) / 60000);
      const urgent = minutesElapsed > 20 && anyPending;
      let tableStatus = 'ordered';
      if (allReady) tableStatus = 'eating';
      if (urgent) tableStatus = 'urgent';
      tables[t] = {
        table: t,
        status: tableStatus,
        name: o.orderName || '',
        minutesElapsed,
        courses: courses.map(c => c.type),
        orderId: o._id.toString(),
        createdAt: o.createdAt,
      };
    });
    res.json({ tables: Object.values(tables), totalTables: req.restaurant.totalTables || 20 });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/active-orders', requireAuth, async (req, res) => {
  try {
    const orders = await db.collection('orders')
      .find({ status: { $ne: 'done' }, restaurantPin: req.restaurant.pin })
      .sort({ createdAt: 1 }).limit(ACTIVE_ORDERS_LIMIT).toArray();
    res.json(orders.map(o => Object.assign({}, o, { _id: o._id.toString() })));
  } catch (e) {
    console.error('[active-orders]', e.message);
    res.status(500).json({ error: 'Could not load orders' });
  }
});

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
    if (courseType === 'main'     && status === 'started') upd.$set.mainStartedAt  = new Date();
    if (courseType === 'main'     && status === 'ready')   { upd.$set.mainStartedAt = null; upd.$set.mainReadyAt = new Date(); }
    if (courseType === 'starters' && status === 'ready')   upd.$set.startersReadyAt = new Date();
    if (courseType === 'drinks'   && status === 'ready')   upd.$set.drinksReadyAt   = new Date();
    await db.collection('orders').updateOne({ _id: order._id, 'courses.type': courseType }, upd);
    res.json({ status: 'ok' });
    const pin = req.restaurant.pin;
    const slug = req.restaurant.slug || '';
    const t = order.table;
    // Push to waiter when food/drinks are ready
    if (courseType === 'starters' && status === 'ready') {
      sendPushToRestaurant(pin, 'Starters Ready — Table ' + t, order.orderName + ' · send to table', '/r/' + slug + '/waiter');
      sendFCMToRestaurant(pin, 'Table ' + t + ', starters ready', 'Send to table now', { table: String(t), type: 'starters_ready', role: 'waiter' }, 'waiter');
    }
    if (courseType === 'drinks' && status === 'ready') {
      sendPushToRestaurant(pin, 'Drinks Ready — Table ' + t, order.orderName + ' · send to table', '/r/' + slug + '/waiter');
      sendFCMToRestaurant(pin, 'Table ' + t + ', drinks ready', 'Send to table now', { table: String(t), type: 'drinks_ready', role: 'waiter' }, 'waiter');
    }
    if (courseType === 'main' && status === 'ready') {
      sendPushToRestaurant(pin, 'Main Course Ready — Table ' + t, order.orderName + ' · send to table', '/r/' + slug + '/waiter');
      sendFCMToRestaurant(pin, 'Table ' + t + ', main course ready', 'Send to table now', { table: String(t), type: 'main_ready', role: 'waiter' }, 'waiter');
    }
    // Push to kitchen when waiter starts main
    if (courseType === 'main' && status === 'started') {
      sendPushToRestaurant(pin, 'Start Main Course — Table ' + t, order.orderName + ' · begin cooking', '/r/' + slug + '/kitchen');
      sendFCMToRestaurant(pin, 'Table ' + t + ', start main course', 'Begin cooking now', { table: String(t), type: 'main_started', role: 'kitchen' }, 'kitchen');
    }
    if (courseType === 'main' && status === 'started')
      if (order.phone && order.phone.length >= 10) await sendWhatsApp('table_order_preparing_v2', order.phone, order.orderName, getParams('order_preparing', order.orderName));
    if (courseType === 'main' && status === 'ready')
      if (order.phone && order.phone.length >= 10) await sendWhatsApp('table_order_arriving_v2', order.phone, order.orderName, getParams('order_arriving', order.orderName));
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
    setTimeout(() => db.collection('orders').updateOne({ _id: order._id }, { $set: { bNotified: false } }).catch(() => {}), 3000);
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const pin = req.restaurant.pin;
      const subs = await db.collection('subscriptions').find({ restaurantPin: pin, role: 'bar' }).toArray();
      const payload = JSON.stringify({ title: 'Coordinate Now', body: 'Table ' + order.table + ' — serve drinks with kitchen, starters almost ready', tag: 'bar-coord' });
      const dead = [];
      await Promise.all(subs.map(async sub => {
        try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload); }
        catch (e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub._id); }
      }));
      if (dead.length) await db.collection('subscriptions').deleteMany({ _id: { $in: dead } });
    }
    sendFCMToRestaurant(req.restaurant.pin,
      'Coordinate Now',
      'Table ' + order.table + ' — serve drinks with kitchen, starters almost ready',
      { table: String(order.table), type: 'bar_coord', role: 'bar' },
      'bar'
    );
    console.log('[notify-bar-fcm] sent to bar devices');
  } catch (e) { console.error('[notify-bar]', e.message); res.status(500).json({ error: 'Failed' }); }
});

// ── NOTIFY WAITER ───────────────────────────────────────────────────────────────
// Kitchen/bar taps bell → sets waiterAlert on order → waiter screen polls + speaks it.
app.post('/notify-waiter', writeLimiter, requireAuth, async (req, res) => {
  const order = await loadOwnedOrder(req, res);
  if (!order) return;
  const message = cleanStr(String(req.body.message || ''), 100);
  if (!message) return res.status(400).json({ error: 'Message required' });
  try {
    await db.collection('orders').updateOne(
      { _id: order._id },
      { $set: { waiterAlert: { message, at: new Date() } } }
    );
    res.json({ status: 'ok' });
    console.log('[notify-waiter] table=' + order.table + ' msg=' + message);
    sendFCMToRestaurant(req.restaurant.pin,
      message,
      'Tap to view table ' + order.table,
      { table: String(order.table), type: 'bell_alert', role: 'waiter', orderId: String(order._id) },
      'waiter'
    );
  } catch (e) { console.error('[notify-waiter]', e.message); res.status(500).json({ error: 'Failed' }); }
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
    const reviewParams = getParams('review_request', order.orderName, { reviewLink });
    console.log('[review] sending to phone=' + order.phone + ' name=' + order.orderName + ' link=' + reviewLink + ' params=' + JSON.stringify(reviewParams));
    await sendWhatsApp('table_review_request_v2', order.phone, order.orderName, reviewParams);
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
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: './public' }));
app.get('/manager', (req, res) => res.sendFile('manager.html', { root: './public' }));

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
  const numTables = (v) => Math.min(Math.max(parseInt(v, 10) || 20, 1), 100);
  try {
    if (await db.collection('restaurants').findOne({ pin })) {
      return res.status(409).json({ ok: false, error: 'PIN already exists' });
    }
    let slug = makeSlug(name);
    const slugExists = await db.collection('restaurants').findOne({ slug });
    if (slugExists) slug = slug + '-' + pin;
    await db.collection('restaurants').insertOne({
      name, pin, slug, ownerPhone, googleReviewLink,
      avgDrinkMins: num(req.body.avgDrinkMins, 8),
      avgStarterMins: num(req.body.avgStarterMins, 18),
      avgMainMins: num(req.body.avgMainMins, 30),
      totalTables: numTables(req.body.totalTables),
      createdAt: new Date()
    });
    console.log('[admin] added restaurant: ' + name + ' slug=' + slug);
    const base = process.env.BASE_URL || 'https://tablepulse-server.onrender.com';
    res.json({
      ok: true, slug,
      links: {
        waiter:  base + '/r/' + slug + '/waiter',
        kitchen: base + '/r/' + slug + '/kitchen',
        bar:     base + '/r/' + slug + '/bar'
      }
    });
  } catch (e) { console.error('[admin/add]', e.message); res.status(500).json({ ok: false, error: 'Failed' }); }
});

app.post('/admin/update-restaurant', adminLimiter, requireAdmin, async (req, res) => {
  const { pin, newPin, name, googleReviewLink, avgDrinkMins, avgStarterMins, avgMainMins, totalTables } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  try {
    const update = {};
    if (newPin && newPin !== pin) {
      const existing = await db.collection('restaurants').findOne({ pin: newPin });
      if (existing) return res.status(400).json({ error: 'PIN already in use' });
      update.pin = newPin;
    }
    if (name) update.name = name;
    if (googleReviewLink) update.googleReviewLink = googleReviewLink;
    if (avgDrinkMins) update.avgDrinkMins = Number(avgDrinkMins);
    if (avgStarterMins) update.avgStarterMins = Number(avgStarterMins);
    if (avgMainMins) update.avgMainMins = Number(avgMainMins);
    if (totalTables != null) update.totalTables = Math.min(Math.max(parseInt(totalTables, 10) || 20, 1), 100);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    await db.collection('restaurants').updateOne({ pin }, { $set: update });
    console.log('[admin] updated restaurant pin=' + pin + ' changes=' + JSON.stringify(update));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ── TEST ENDPOINT (admin-only) ─────────────────────────────────────────────────
app.get('/test-whatsapp', adminLimiter, requireAdmin, async (req, res) => {
  const { stage } = req.query;
  const name = cleanStr(String(req.query.name || ''), 60);
  if (!isValidPhone(req.query.phone) || !name || !stage) {
    return res.status(400).json({ error: 'Required: valid phone, name, stage' });
  }
  const campaigns = {
    order_received: 'table_order_received_v3', order_preparing: 'table_order_preparing_v2',
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
    token,
    restaurantName: restaurant.name,
    googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins,
    avgStarterMins: restaurant.avgStarterMins,
    avgMainMins: restaurant.avgMainMins,
    totalTables: restaurant.totalTables || 20,
    subscriptionStatus: restaurant.subscriptionStatus || 'active',
    subscriptionExpiry: restaurant.subscriptionExpiry || null
  });
});

// ── ROLE PASSCODE ROUTES ─────────────────────────────────────────────────────
// Check if a role passcode has been set for this restaurant
app.get('/role-passcode/:role', requireAuth, async (req, res) => {
  const role = req.params.role;
  if (!['waiter','kitchen','bar'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const pin = req.restaurant.pin;
  const doc = await db.collection('role_passcodes').findOne({ pin, role });
  res.json({ exists: !!doc });
});

// Set role passcode (first time setup or reset by owner)
app.post('/role-passcode/:role', requireAuth, async (req, res) => {
  const role = req.params.role;
  if (!['waiter','kitchen','bar'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const passcode = cleanStr(String(req.body.passcode || ''), 6);
  if (!passcode || passcode.length < 4) return res.status(400).json({ error: 'Passcode must be 4-6 digits' });
  const pin = req.restaurant.pin;
  await db.collection('role_passcodes').updateOne(
    { pin, role },
    { $set: { pin, role, passcode, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  console.log('[role-passcode] set for pin=' + pin + ' role=' + role);
  res.json({ ok: true });
});

// Verify role passcode login
app.post('/role-login', requireAuth, async (req, res) => {
  const { role, passcode } = req.body;
  if (!['waiter','kitchen','bar'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!passcode) return res.status(400).json({ error: 'Passcode required' });
  const pin = req.restaurant.pin;
  const doc = await db.collection('role_passcodes').findOne({ pin, role });
  if (!doc) return res.status(404).json({ error: 'Passcode not set', notSet: true });
  if (doc.passcode !== String(passcode)) return res.status(401).json({ error: 'Wrong passcode' });
  console.log('[role-login] success pin=' + pin + ' role=' + role);
  res.json({ ok: true, role });
});

app.get('/verify', requireAuth, (req, res) => {
  const r = req.restaurant;
  res.json({
    restaurantName: r.name,
    totalTables: r.totalTables || 20,
    subscriptionStatus: r.subscriptionStatus || 'active',
    subscriptionExpiry: r.subscriptionExpiry || null
  });
});

// ── SUBSCRIPTION HELPERS ─────────────────────────────────────────────────────
// Creates a Razorpay Payment Link with amount + notes embedded.
// Returns the short URL string, or null on failure.
async function createPaymentLink(pin, plan, restaurantName) {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    console.error('[razorpay] KEY_ID or KEY_SECRET not set');
    return null;
  }
  try {
    const amount = PLAN_AMOUNT[plan];
    const desc   = 'TablePulse ' + (plan === 'yearly' ? 'Yearly' : 'Monthly') + ' subscription';
    const resp = await axios.post(
      'https://api.razorpay.com/v1/payment_links',
      {
        amount,
        currency: 'INR',
        description: desc,
        notes: { pin, plan },
        reminder_enable: false,
        notify: { sms: false, email: false }
      },
      {
        auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET },
        timeout: 10000
      }
    );
    console.log('[razorpay] created payment link for ' + restaurantName + ' plan=' + plan);
    return resp.data.short_url;
  } catch (e) {
    console.error('[razorpay] payment link creation failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

async function renewRestaurant(pin, plan) {
  const days = PLAN_DAYS[plan] || 30;
  const now  = new Date();
  // If already has a future expiry, extend from there; else extend from now.
  const restaurant = await db.collection('restaurants').findOne({ pin });
  const base = (restaurant && restaurant.subscriptionExpiry && new Date(restaurant.subscriptionExpiry) > now)
    ? new Date(restaurant.subscriptionExpiry) : now;
  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  await db.collection('restaurants').updateOne({ pin }, {
    $set: { subscriptionExpiry: newExpiry, subscriptionStatus: 'active', subscriptionPlan: plan }
  });
  console.log('[subscription] renewed ' + pin + ' plan=' + plan + ' until ' + newExpiry.toISOString());
  return { restaurant, newExpiry };
}

// Recompute and persist subscriptionStatus for all restaurants daily.
async function syncSubscriptionStatuses() {
  const now = new Date();
  const warnThreshold = new Date(now.getTime() + WARN_DAYS * 24 * 60 * 60 * 1000);
  const restaurants = await db.collection('restaurants').find({}).toArray();
  for (const r of restaurants) {
    if (!r.subscriptionExpiry) continue; // no expiry set = legacy, skip
    const expiry = new Date(r.subscriptionExpiry);
    let status;
    if (expiry <= now)             status = 'expired';
    else if (expiry <= warnThreshold) status = 'warning';
    else                           status = 'active';
    if (status !== r.subscriptionStatus) {
      await db.collection('restaurants').updateOne({ _id: r._id }, { $set: { subscriptionStatus: status } });
      console.log('[subscription] ' + r.name + ' status -> ' + status);
    }
  }
}

async function sendSubscriptionReminders() {
  const now = new Date();
  const warnThreshold = new Date(now.getTime() + WARN_DAYS * 24 * 60 * 60 * 1000);
  const restaurants = await db.collection('restaurants').find({
    subscriptionExpiry: { $gt: now, $lte: warnThreshold }
  }).toArray();
  for (const r of restaurants) {
    if (!r.ownerPhone) continue;
    const expiryStr = new Date(r.subscriptionExpiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const [monthlyLink, yearlyLink] = await Promise.all([
      createPaymentLink(r.pin, 'monthly', r.name),
      createPaymentLink(r.pin, 'yearly', r.name)
    ]);
    if (!monthlyLink || !yearlyLink) { console.error('[subscription] skipping reminder for ' + r.name + ' — link creation failed'); continue; }
    await sendWhatsApp('subscription_reminder', r.ownerPhone, r.name,
      [r.name, expiryStr, monthlyLink, yearlyLink]);
    console.log('[subscription] reminder sent to ' + r.name);
  }
}

function scheduleSubscriptionChecks() {
  async function run() {
    try {
      await syncSubscriptionStatuses();
      await sendSubscriptionReminders();
    } catch (e) { console.error('[subscription] scheduler error:', e.message); }
    // Run again in 24 hours.
    setTimeout(run, 24 * 60 * 60 * 1000);
  }
  // First run: wait until 9am IST today/tomorrow (reuse same IST helper logic).
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const msUntil9am = (() => {
    const target = new Date(ist);
    target.setHours(9, 0, 0, 0);
    if (target <= ist) target.setDate(target.getDate() + 1);
    return target.getTime() - ist.getTime();
  })();
  setTimeout(run, msUntil9am);
  console.log('[subscription] checker scheduled in ' + Math.round(msUntil9am / 60000) + ' min');
}



// ── ADMIN SUBSCRIPTION ROUTES ─────────────────────────────────────────────────
app.post('/admin/renew-subscription', adminLimiter, requireAdmin, async (req, res) => {
  const pin  = cleanStr(String(req.body.pin || ''), 6);
  const plan = req.body.plan;
  if (!pin || !PLAN_DAYS[plan]) return res.status(400).json({ ok: false, error: 'PIN and plan (monthly/yearly) required' });
  try {
    const { restaurant, newExpiry } = await renewRestaurant(pin, plan);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found' });
    res.json({ ok: true, newExpiry });
  } catch (e) { console.error('[admin/renew]', e.message); res.status(500).json({ ok: false, error: 'Failed' }); }
});

app.get('/admin/subscription-links/:pin', adminLimiter, requireAdmin, async (req, res) => {
  const pin = cleanStr(req.params.pin, 6);
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN required' });
  const restaurant = await db.collection('restaurants').findOne({ pin });
  if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found' });
  const [monthly, yearly] = await Promise.all([
    createPaymentLink(pin, 'monthly', restaurant.name),
    createPaymentLink(pin, 'yearly', restaurant.name)
  ]);
  if (!monthly || !yearly) return res.status(500).json({ ok: false, error: 'Failed to create payment links' });
  res.json({ ok: true, monthly, yearly });
});

// ── AUTO-ARCHIVE STALE ORDERS ────────────────────────────────────────────────
// Orders not marked done after 6 hours are auto-archived.
// Prevents forgotten tables from polluting staff screens indefinitely.
const AUTO_ARCHIVE_AFTER_MS = 6 * 60 * 60 * 1000;

async function runAutoArchive() {
  try {
    const cutoff = new Date(Date.now() - AUTO_ARCHIVE_AFTER_MS);
    const result = await db.collection('orders').updateMany(
      { status: 'active', createdAt: { $lt: cutoff } },
      { $set: { status: 'auto-archived', completedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log('[auto-archive] archived ' + result.modifiedCount + ' stale orders');
    }
  } catch (e) {
    console.error('[auto-archive] error:', e.message);
  }
}

function scheduleAutoArchive() {
  // Run once on boot, then every hour.
  runAutoArchive();
  setInterval(runAutoArchive, 60 * 60 * 1000);
  console.log('[auto-archive] scheduler started — archiving orders older than 6h');
}

// ── CUSTOMER LOG ─────────────────────────────────────────────────────────────
app.get('/customer-log', requireAuth, async (req, res) => {
  try {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const todayMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - istOffset);
    const entries = await db.collection('customer_log')
      .find({ restaurantPin: req.restaurant.pin, timestamp: { $gte: todayMidnight } })
      .sort({ timestamp: -1 })
      .toArray();
    res.json(entries.map(e => ({ name: e.name, phone: e.phone, table: e.table, timestamp: e.timestamp })));
  } catch (e) {
    console.error('[customer-log] fetch failed:', e.message);
    res.status(500).json({ error: 'Failed' });
  }
});

function scheduleCustomerLogClear() {
  function msUntilNext2am() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const target = new Date(ist);
    target.setHours(2, 0, 0, 0);
    if (target <= ist) target.setDate(target.getDate() + 1);
    return target.getTime() - ist.getTime();
  }
  async function run() {
    try {
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(Date.now() + istOffset);
      const todayMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - istOffset);
      const result = await db.collection('customer_log').deleteMany({ timestamp: { $lt: todayMidnight } });
      console.log('[customer-log] cleared ' + result.deletedCount + ' old entries at 2am');
    } catch (e) { console.error('[customer-log] clear failed:', e.message); }
    setTimeout(run, 24 * 60 * 60 * 1000);
  }
  setTimeout(run, msUntilNext2am());
  console.log('[customer-log] clear scheduled for 2am IST');
}

// ── WEEKLY ANALYTICS REPORT ───────────────────────────────────────────────────
async function buildWeeklyAnalytics(restaurant) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const orders = await db.collection('orders')
    .find({ restaurantPin: restaurant.pin, createdAt: { $gte: weekAgo } })
    .toArray();
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  return {
    total:      orders.length,
    avgStarter: avg(orders.filter(o => o.startersReadyAt).map(o => (new Date(o.startersReadyAt) - new Date(o.createdAt)) / 60000)),
    avgMain:    avg(orders.filter(o => o.mainReadyAt).map(o => (new Date(o.mainReadyAt) - new Date(o.createdAt)) / 60000)),
    avgDrinks:  avg(orders.filter(o => o.drinksReadyAt).map(o => (new Date(o.drinksReadyAt) - new Date(o.createdAt)) / 60000))
  };
}

function scheduleWeeklyAnalytics() {
  function msUntilNextMonday10am() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    const daysUntilMon = day === 1 ? (ist.getHours() < 10 ? 0 : 7) : (8 - day) % 7 || 7;
    const next = new Date(ist);
    next.setDate(ist.getDate() + daysUntilMon);
    next.setHours(10, 0, 0, 0);
    return next.getTime() - ist.getTime();
  }
  async function run() {
    console.log('[analytics] Sending Monday weekly analytics reports...');
    try {
      const restaurants = await db.collection('restaurants').find({}).toArray();
      for (const r of restaurants) {
        if (!r.ownerPhone) { console.log('[analytics] no ownerPhone for ' + r.name + ', skipping'); continue; }
        try {
          const s = await buildWeeklyAnalytics(r);
          await sendWhatsApp('weekly_analytics_v1', r.ownerPhone, r.name,
            [r.name, String(s.total), String(s.avgStarter), String(s.avgMain), String(s.avgDrinks)]);
          console.log('[analytics] report sent to ' + r.name);
        } catch (e) { console.error('[analytics] report failed for ' + r.name + ':', e.message); }
      }
    } catch (e) { console.error('[analytics] weekly scheduler error:', e.message); }
    setTimeout(run, 7 * 24 * 60 * 60 * 1000);
  }
  setTimeout(run, msUntilNextMonday10am());
  console.log('[analytics] weekly report scheduled for Monday 10am IST');
}

// ── ANALYTICS ────────────────────────────────────────────────────────────────
app.get('/admin/analytics/:pin', adminLimiter, requireAdmin, async (req, res) => {
  const pin = cleanStr(req.params.pin, 6);
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN required' });
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const orders = await db.collection('orders')
      .find({ restaurantPin: pin, createdAt: { $gte: thirtyDaysAgo } })
      .toArray();

    const avg = arr => arr.length
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
      : null;

    const starterTimes = orders.filter(o => o.startersReadyAt)
      .map(o => (new Date(o.startersReadyAt) - new Date(o.createdAt)) / 60000);
    const mainTimes = orders.filter(o => o.mainReadyAt)
      .map(o => (new Date(o.mainReadyAt) - new Date(o.createdAt)) / 60000);
    const drinksTimes = orders.filter(o => o.drinksReadyAt)
      .map(o => (new Date(o.drinksReadyAt) - new Date(o.createdAt)) / 60000);

    // Build daily counts with all 30 slots pre-filled as 0
    const dailyCounts = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      dailyCounts[d.toISOString().slice(0, 10)] = 0;
    }
    orders.forEach(o => {
      const key = new Date(o.createdAt).toISOString().slice(0, 10);
      if (key in dailyCounts) dailyCounts[key]++;
    });

    res.json({
      ok: true,
      totalOrders: orders.length,
      avgStarterMins:  avg(starterTimes),
      avgMainMins:     avg(mainTimes),
      avgDrinksMins:   avg(drinksTimes),
      starterSamples:  starterTimes.length,
      mainSamples:     mainTimes.length,
      drinksSamples:   drinksTimes.length,
      dailyCounts
    });
  } catch (e) {
    console.error('[analytics]', e.message);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
});

function scheduleAnalyticsCleanup() {
  async function run() {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await db.collection('orders').deleteMany({ createdAt: { $lt: cutoff } });
      if (result.deletedCount > 0)
        console.log('[analytics] purged ' + result.deletedCount + ' orders older than 30 days');
    } catch (e) { console.error('[analytics] cleanup failed:', e.message); }
    setTimeout(run, 24 * 60 * 60 * 1000);
  }
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const target = new Date(ist);
  target.setHours(3, 0, 0, 0);
  if (target <= ist) target.setDate(target.getDate() + 1);
  setTimeout(run, target.getTime() - ist.getTime());
  console.log('[analytics] order cleanup scheduled for 3am IST');
}

// ── FCM TOKEN ROUTES ─────────────────────────────────────────────────────────
// React Native app sends FCM token after login.
app.post('/fcm-token', writeLimiter, requireAuth, async (req, res) => {
  const { token, role } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    await db.collection('fcm_tokens').updateOne(
      { token },
      { $set: { token, role: role||'waiter', restaurantPin: req.restaurant.pin, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    console.log('[fcm] token registered for pin=' + req.restaurant.pin + ' role=' + (role||'waiter'));
    res.json({ ok: true });
  } catch (e) { console.error('[fcm]', e.message); res.status(500).json({ error: 'Failed' }); }
});

app.delete('/fcm-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  await db.collection('fcm_tokens').deleteOne({ token });
  res.json({ ok: true });
});

// ── PUSH SUBSCRIPTION ROUTES ─────────────────────────────────────────────────
// Staff devices subscribe to push on login. Subscriptions stored per restaurant.

app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

app.post('/subscribe', writeLimiter, requireAuth, async (req, res) => {
  const { endpoint, keys, role } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    // Upsert by endpoint — avoid duplicate subs for same device
    const setFields = { endpoint, keys, restaurantPin: req.restaurant.pin, updatedAt: new Date() };
    if (role) setFields.role = role;
    await db.collection('subscriptions').updateOne(
      { endpoint },
      { $set: setFields, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { console.error('[subscribe]', e.message); res.status(500).json({ error: 'Failed' }); }
});

app.delete('/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
  await db.collection('subscriptions').deleteOne({ endpoint, restaurantPin: req.restaurant.pin });
  res.json({ ok: true });
});

// ── RESTAURANT SLUG ROUTES ────────────────────────────────────────────────────
const readFileSafe = require('fs').readFileSync;

function serveStaffScreen(screen) {
  return async (req, res) => {
    const slug = cleanStr(req.params.slug, 80);
    if (!slug) return res.sendStatus(400);
    try {
      const restaurant = await db.collection('restaurants').findOne({ slug });
      if (!restaurant) return res.status(404).send('Restaurant not found');
      const filePath = path.join(__dirname, 'public', screen + '.html');
      let html = readFileSafe(filePath, 'utf8');
      html = html.replace('</head>', '<script>window.__SLUG__="' + slug + '";</script></head>');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error('[serveStaffScreen] error:', e.message);
      res.status(500).send('Server error');
    }
  };
}

app.get('/r/:slug/waiter',  serveStaffScreen('waiter'));
app.get('/r/:slug/kitchen', serveStaffScreen('kitchen'));
app.get('/r/:slug/bar',     serveStaffScreen('barman'));

// Slug-based login: validates PIN against this specific restaurant only.
app.post('/r/:slug/login', loginLimiter, async (req, res) => {
  const slug = cleanStr(req.params.slug, 80);
  const pin  = cleanStr(String(req.body.pin || ''), 6);
  if (!slug || !pin) return res.status(400).json({ error: 'Invalid request' });
  const restaurant = await db.collection('restaurants').findOne({ slug });
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (restaurant.pin !== pin) return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  const token = generateToken(pin);
  res.json({
    token,
    restaurantName: restaurant.name,
    googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins,
    avgStarterMins: restaurant.avgStarterMins,
    avgMainMins: restaurant.avgMainMins,
    totalTables: restaurant.totalTables || 20,
    subscriptionStatus: restaurant.subscriptionStatus || 'active',
    subscriptionExpiry: restaurant.subscriptionExpiry || null
  });
});

// Get links for existing restaurant by pin (for admin panel).
app.get('/admin/restaurant-links/:pin', adminLimiter, requireAdmin, async (req, res) => {
  const pin = cleanStr(req.params.pin, 6);
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN required' });
  const restaurant = await db.collection('restaurants').findOne({ pin });
  if (!restaurant) return res.status(404).json({ ok: false, error: 'Not found' });
  if (!restaurant.slug) return res.status(400).json({ ok: false, error: 'No slug — re-add this restaurant' });
  const base = process.env.BASE_URL || 'https://tablepulse-server.onrender.com';
  res.json({
    ok: true, slug: restaurant.slug,
    links: {
      waiter:  base + '/r/' + restaurant.slug + '/waiter',
      kitchen: base + '/r/' + restaurant.slug + '/kitchen',
      bar:     base + '/r/' + restaurant.slug + '/bar'
    }
  });
});

// Serve static files last — after all routes are registered.
// Must be last so slug routes (/r/:slug/*) take priority over static files.
app.use(express.static(path.join(__dirname, 'public')));

// Acknowledge alert — called by React Native app when staff taps Acknowledge
app.post('/acknowledge-alert', async (req, res) => {
  const { alertId, orderId } = req.body;
  try {
    // If orderId provided, block the bell on that order for 2 minutes
    if (orderId) {
      const blockUntil = new Date(Date.now() + 2 * 60 * 1000);
      await db.collection('orders').updateOne(
        { _id: toObjectId(orderId) },
        { $set: { bellBlockedUntil: blockUntil, waiterAlert: null } }
      );
      console.log('[acknowledge] bell blocked for orderId=' + orderId + ' until ' + blockUntil.toISOString());
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Bell status — kitchen polls to check if bell is blocked after waiter acknowledges
app.get('/bell-status/:orderId', requireAuth, async (req, res) => {
  try {
    const order = await db.collection('orders').findOne({ _id: toObjectId(req.params.orderId) });
    if (!order) return res.status(404).json({ error: 'Not found' });
    const blocked = order.bellBlockedUntil && new Date(order.bellBlockedUntil) > new Date();
    const remaining = blocked ? Math.ceil((new Date(order.bellBlockedUntil) - new Date()) / 1000) : 0;
    res.json({ blocked: !!blocked, remainingSeconds: remaining });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
