require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { generateToken, verifyToken, requireAuth, findRestaurantByPin } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TOKEN        = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI  = process.env.MONGODB_URI;
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'tablepulse-admin-2026';

let db;
MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('tablepulse');
  console.log('MongoDB connected');
  scheduleWeeklyReports();
});

function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10)                       return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0'))  return '+91' + d.slice(1);
  return '+' + d;
}

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) { console.error('[aisensy] AISENSY_API_KEY not set'); return; }
  try {
    await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', {
      apiKey: AISENSY_API_KEY, campaignName, destination: formatPhone(phone),
      userName: orderName, source: 'tablepulse-server', templateParams
    });
    console.log('[aisensy] sent ' + campaignName + ' to ' + formatPhone(phone));
  } catch (err) {
    console.error('[aisensy] failed ' + campaignName + ':', err.response ? err.response.data : err.message);
  }
}

function getParams(stage, name, extras) {
  extras = extras || {};
  if (stage === 'order_received')  return [name, extras.table || '', 'Gravity Family Dine and Bar'];
  if (stage === 'order_preparing') return [name];
  if (stage === 'order_arriving')  return [name];
  if (stage === 'order_delay')     return [name];
  if (stage === 'review_request')  return [name, extras.reviewLink || 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9'];
  return [name];
}

// ── Weekly report builder ─────────────────────────────────────────────────────
async function buildWeeklyReport(restaurant) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const orders = await db.collection('orders').find({
    restaurantPin: restaurant.pin,
    createdAt: { $gte: weekAgo }
  }).toArray();

  const total = orders.length;
  const done  = orders.filter(function(o) { return o.status === 'done'; }).length;

  // Average main course prep time (mainStartedAt → completedAt)
  const mainTimes = orders.filter(function(o) {
    return o.mainStartedAt && o.completedAt;
  }).map(function(o) {
    return (new Date(o.completedAt) - new Date(o.mainStartedAt)) / 60000;
  });
  const avgMain = mainTimes.length
    ? Math.round(mainTimes.reduce(function(a, b) { return a + b; }, 0) / mainTimes.length)
    : 0;

  // Review link taps — count from AiSensy not available via API, so track clicks via our own counter
  const reviewsSent = orders.filter(function(o) { return o.reviewSent; }).length;

  return { total, done, avgMain, reviewsSent };
}

async function sendWeeklyReport(restaurant) {
  if (!restaurant.ownerPhone) {
    console.log('[report] no ownerPhone for ' + restaurant.name + ', skipping');
    return;
  }
  try {
    const stats = await buildWeeklyReport(restaurant);
    const msg = 'Weekly Report — ' + restaurant.name + '\n\n' +
      '📊 Week Summary:\n' +
      '🍽 Orders served: ' + stats.total + '\n' +
      '✅ Completed: ' + stats.done + '\n' +
      '⏱ Avg main course time: ' + (stats.avgMain || 'N/A') + ' mins\n' +
      '⭐ Review requests sent: ' + stats.reviewsSent + '\n\n' +
      'Powered by TablePulse 🚀';

    // Send as plain text via AiSensy session message
    // Uses review_request campaign as a workaround — replace with a dedicated report template later
    await sendWhatsApp('table_review_request_v2', restaurant.ownerPhone, restaurant.name, [restaurant.name, msg]);
    console.log('[report] sent to ' + restaurant.name);
  } catch(e) {
    console.error('[report] failed for ' + restaurant.name + ':', e.message);
  }
}

// ── Monday 9am IST scheduler ──────────────────────────────────────────────────
function scheduleWeeklyReports() {
  function msUntilNextMonday9am() {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun, 1=Mon
    const daysUntilMon = day === 1 ? (ist.getHours() < 9 ? 0 : 7) : (8 - day) % 7 || 7;
    const next = new Date(ist);
    next.setDate(ist.getDate() + daysUntilMon);
    next.setHours(9, 0, 0, 0);
    return next.getTime() - ist.getTime();
  }

  function runReports() {
    console.log('[report] Running Monday weekly reports...');
    db.collection('restaurants').find({}).toArray().then(function(restaurants) {
      restaurants.forEach(sendWeeklyReport);
    });
    // Schedule next week
    setTimeout(runReports, 7 * 24 * 60 * 60 * 1000);
  }

  const ms = msUntilNextMonday9am();
  console.log('[report] Next report in ' + Math.round(ms / 3600000) + ' hours');
  setTimeout(runReports, ms);
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.get('/webhook', function(req, res) {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

// ── ORDER CREATED ─────────────────────────────────────────────────────────────
app.post('/order', async function(req, res) {
  const { phone, orderName, table } = req.body;
  const courses  = req.body.courses  || [];
  const sameTime = req.body.sameTime || false;
  const toK      = req.body.toK !== false;
  const toB      = req.body.toB !== false;
  // Get restaurant from token
  const token = req.headers['x-auth-token'];
  let restaurantPin = '';
  let restaurantName = 'Gravity Family Dine and Bar';
  let reviewLink = 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9';
  if (token && db) {
    try {
      const rest = await verifyToken(token);
      if (rest) { restaurantPin = rest.pin; restaurantName = rest.name; reviewLink = rest.googleReviewLink || reviewLink; }
    } catch(e) {}
  }
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({
    phone, orderName, table, courses, sameTime, toK, toB,
    bNotified: false, status: 'active', restaurantPin, reviewSent: false,
    createdAt: new Date()
  });
  await sendWhatsApp('table_order_received_v2', phone, orderName, [orderName, String(table), restaurantName]);
});

// ── ACTIVE ORDERS ─────────────────────────────────────────────────────────────
app.get('/active-orders', async function(req, res) {
  if (!db) return res.json([]);
  // Filter by restaurant if token provided
  const token = req.headers['x-auth-token'];
  let query = { status: { $ne: 'done' } };
  if (token) {
    try {
      const rest = await verifyToken(token);
      if (rest) query.restaurantPin = rest.pin;
    } catch(e) {}
  }
  const orders = await db.collection('orders').find(query).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders.map(function(o) { return Object.assign({}, o, { _id: o._id.toString() }); }));
});

// ── UPDATE COURSE ─────────────────────────────────────────────────────────────
app.post('/update-course', async function(req, res) {
  const { orderId, courseType, status } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try {
    const upd = { $set: { 'courses.$.status': status } };
    if (courseType === 'main' && status === 'started') upd.$set.mainStartedAt = new Date();
    if (courseType === 'main' && status === 'ready')   upd.$set.mainStartedAt = null;
    await db.collection('orders').updateOne({ _id: new ObjectId(orderId), 'courses.type': courseType }, upd);
    const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
    if (order) {
      if (courseType === 'main' && status === 'started')
        await sendWhatsApp('table_order_preparing_v2', order.phone, order.orderName, getParams('order_preparing', order.orderName));
      if (courseType === 'main' && status === 'ready')
        await sendWhatsApp('table_order_arriving_v2', order.phone, order.orderName, getParams('order_arriving', order.orderName));
    }
  } catch(e) { console.error('update-course error:', e.message); }
});

// ── NOTIFY BAR ────────────────────────────────────────────────────────────────
app.post('/notify-bar', async function(req, res) {
  const { orderId } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try { await db.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { bNotified: true } }); } catch(e) {}
});

// ── ORDER DONE ────────────────────────────────────────────────────────────────
app.post('/order-done', async function(req, res) {
  const { orderId } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try { await db.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { status: 'done', completedAt: new Date() } }); } catch(e) {}
});

// ── REVIEW REQUEST ────────────────────────────────────────────────────────────
app.post('/review', async function(req, res) {
  let { phone, orderName, reviewLink, orderId } = req.body;
  if (orderId && db) {
    try {
      const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
      if (order) {
        phone = order.phone; orderName = order.orderName;
        // Get review link from restaurant
        if (order.restaurantPin) {
          const rest = await db.collection('restaurants').findOne({ pin: order.restaurantPin });
          if (rest && rest.googleReviewLink) reviewLink = rest.googleReviewLink;
        }
        // Mark review sent
        await db.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { reviewSent: true } });
      }
    } catch(e) {}
  }
  res.json({ status: 'ok' });
  await sendWhatsApp('table_review_request_v2', phone, orderName, getParams('review_request', orderName, { reviewLink }));
});

// ── ORDER DELAY ───────────────────────────────────────────────────────────────
app.post('/order-delay', async function(req, res) {
  let { phone, orderName, orderId } = req.body;
  if (orderId && db) {
    try {
      const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
      if (order) { phone = order.phone; orderName = order.orderName; }
    } catch(e) {}
  }
  res.json({ status: 'ok' });
  await sendWhatsApp('table_order_delay_v2', phone, orderName, getParams('order_delay', orderName));
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
// Serve admin page at secret URL
app.get('/admin-' + ADMIN_SECRET, function(req, res) {
  res.sendFile('admin.html', { root: './public' });
});

app.get('/admin/restaurants', async function(req, res) {
  if (!db) return res.json([]);
  const list = await db.collection('restaurants').find({}).toArray();
  res.json(list.map(function(r) { return Object.assign({}, r, { _id: r._id.toString() }); }));
});

app.post('/admin/add-restaurant', async function(req, res) {
  const { name, pin, ownerPhone, googleReviewLink, avgDrinkMins, avgStarterMins, avgMainMins } = req.body;
  if (!name || !pin) return res.status(400).json({ ok: false, error: 'name and pin required' });
  if (!db) return res.status(500).json({ ok: false, error: 'DB not ready' });
  try {
    const existing = await db.collection('restaurants').findOne({ pin: pin.trim() });
    if (existing) return res.status(400).json({ ok: false, error: 'PIN already exists' });
    await db.collection('restaurants').insertOne({
      name: name.trim(), pin: pin.trim(), ownerPhone: ownerPhone || '',
      googleReviewLink: googleReviewLink || '', avgDrinkMins: avgDrinkMins || 8,
      avgStarterMins: avgStarterMins || 18, avgMainMins: avgMainMins || 30,
      createdAt: new Date()
    });
    console.log('[admin] added restaurant: ' + name + ' PIN: ' + pin);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/admin/delete-restaurant', async function(req, res) {
  const { id } = req.body;
  if (!db || !id) return res.status(400).json({ ok: false });
  try {
    await db.collection('restaurants').deleteOne({ _id: new ObjectId(id) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/admin/send-report', async function(req, res) {
  const { pin } = req.body;
  if (!pin || !db) return res.status(400).json({ ok: false, error: 'PIN required' });
  try {
    const restaurant = await db.collection('restaurants').findOne({ pin: pin.trim() });
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found' });
    if (!restaurant.ownerPhone) return res.status(400).json({ ok: false, error: 'No owner phone set for this restaurant' });
    await sendWeeklyReport(restaurant);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── TEST ENDPOINT ─────────────────────────────────────────────────────────────
app.get('/test-whatsapp', async function(req, res) {
  const { phone, name, stage } = req.query;
  if (!phone || !name || !stage) return res.status(400).json({ error: 'Required: phone, name, stage' });
  const campaigns = {
    order_received:  'table_order_received_v2',
    order_preparing: 'table_order_preparing_v2',
    order_arriving:  'table_order_arriving_v2',
    order_delay:     'table_order_delay_v2',
    review_request:  'table_review_request_v2'
  };
  const campaignName = campaigns[stage];
  if (!campaignName) return res.status(400).json({ error: 'Unknown stage: ' + stage });
  const params = getParams(stage, name, { table: '7', reviewLink: 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9' });
  await sendWhatsApp(campaignName, phone, name, params);
  res.json({ ok: true, campaign: campaignName, destination: formatPhone(phone), params });
});

// ── ORDERS LIST ───────────────────────────────────────────────────────────────
app.get('/orders', async function(req, res) {
  if (!db) return res.json([]);
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders);
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/login', async function(req, res) {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const restaurant = await findRestaurantByPin(pin);
  if (!restaurant) return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  const token = generateToken(pin);
  res.json({ token, restaurantName: restaurant.name, googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins, avgStarterMins: restaurant.avgStarterMins, avgMainMins: restaurant.avgMainMins });
});

app.get('/verify', async function(req, res) {
  const token = req.headers['x-auth-token'];
  const restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Session expired' });
  res.json({ restaurantName: restaurant.name });
});

app.get('/register-number', async function(req, res) {
  try {
    const response = await axios.post('https://graph.facebook.com/v18.0/' + PHONE_ID + '/register',
      { messaging_product: 'whatsapp', pin: '123456' },
      { headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.json({ success: false, error: error.response ? error.response.data : error.message });
  }
});

app.listen(3000, function() { console.log('TablePulse running on port 3000'); });
