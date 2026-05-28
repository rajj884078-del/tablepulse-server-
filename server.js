require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { generateToken, verifyToken, requireAuth, findRestaurantByPin } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Meta vars (kept only for /register-number — remove that route later) ──
const TOKEN        = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI  = process.env.MONGODB_URI;

// ── AiSensy ────────────────────────────────────────────────────────────────
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;

// ── MongoDB ────────────────────────────────────────────────────────────────
let db;
MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('tablepulse');
  console.log('MongoDB connected');
});

// ── Phone formatter ────────────────────────────────────────────────────────
// AiSensy needs full number with country code e.g. "+919876543210"
function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10)                       return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  if (d.length === 11 && d.startsWith('0'))  return `+91${d.slice(1)}`;
  return `+${d}`;
}

// ── AiSensy send ───────────────────────────────────────────────────────────
// campaignName   = must EXACTLY match the API Campaign name in AiSensy dashboard
// phone          = customer number (any Indian format)
// orderName      = customer name
// templateParams = string array — length must equal number of {{vars}} in template
//
// If you get a 400 error → templateParams count doesn't match template variables.
//   Fix: open template in AiSensy, count {{1}} {{2}} etc., adjust array here.
// If you get 404 → campaign name doesn't exist. Create it in AiSensy → Campaigns.
// If you get 401 → wrong AISENSY_API_KEY in Render env.

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) {
    console.error('[aisensy] AISENSY_API_KEY not set in Render env — skipping send');
    return;
  }
  try {
    await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', {
      apiKey:         AISENSY_API_KEY,
      campaignName,
      destination:    formatPhone(phone),
      userName:       orderName,
      source:         'tablepulse-server',
      templateParams,
    });
    console.log(`[aisensy] ✓ "${campaignName}" → ${formatPhone(phone)}`);
  } catch (err) {
    console.error(`[aisensy] ✗ "${campaignName}":`, err.response?.data || err.message);
  }
}

// ── Webhook (Meta verification — kept as-is) ────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ── ORDER CREATED — Waiter screen ──────────────────────────────────────────
// Fires: order_received template
// Trigger: waiter submits customer name + phone + table
app.post('/order', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({
    phone, orderName, table, status: 'received', createdAt: new Date()
  });
  await sendWhatsApp('table_order_received', phone, orderName, [orderName]);
});

// ── STARTERS READY — Kitchen screen ────────────────────────────────────────
// DB update only — no WhatsApp message.
// No matching approved template exists yet.
// TODO later: create 'table_starters_ready' campaign + template, then add:
//   await sendWhatsApp('table_starters_ready', phone, orderName, [orderName]);
app.post('/starters-ready', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'starters-ready' } }
  );
});

// ── MAIN COURSE STARTED — Kitchen screen ───────────────────────────────────
// Fires: order_preparing template
// Trigger: kitchen marks main course as being prepared
app.post('/main-started', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'main-started' } }
  );
  await sendWhatsApp('table_order_preparing', phone, orderName, [orderName]);
});

// ── MAIN COURSE READY — Kitchen screen ─────────────────────────────────────
// Fires: order_arriving template
// Trigger: kitchen marks main course ready / runner picks up
app.post('/main-ready', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'main-ready', completedAt: new Date() } }
  );
  await sendWhatsApp('table_order_arriving', phone, orderName, [orderName]);
});

// ── REVIEW REQUEST — Supervisor / Waiter screen ─────────────────────────────
// Fires: review_request template (manually triggered by staff)
// Note: Google review link is currently hardcoded in the template text.
//       To make it per-restaurant, update template to use {{2}} for the link,
//       then change templateParams to [orderName, restaurant.googleReviewLink]
app.post('/review', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  await sendWhatsApp('table_review_request', phone, orderName, [orderName]);
});

// ── TEST ENDPOINT — dev only ────────────────────────────────────────────────
// Use this to test each WhatsApp trigger without going through the full UI.
// Hit from browser or curl:
//   https://tablepulse-server.onrender.com/test-whatsapp?stage=order_received&phone=91XXXXXXXXXX&name=Raj
//
// Valid stages: order_received, order_preparing, order_arriving, order_delay, review_request
// Remove this route before going live with real customers.

app.get('/test-whatsapp', async (req, res) => {
  const { phone, name, stage } = req.query;
  if (!phone || !name || !stage) {
    return res.status(400).json({ error: 'Required: phone, name, stage' });
  }
  const stageMap = {
    order_received:  'table_order_received',
    order_preparing: 'table_order_preparing',
    order_arriving:  'table_order_arriving',
    order_delay:     'table_order_delay',
    review_request:  'table_review_request',
  };
  const campaignName = stageMap[stage];
  if (!campaignName) {
    return res.status(400).json({
      error: `Unknown stage "${stage}"`,
      valid: Object.keys(stageMap)
    });
  }
  try {
    await sendWhatsApp(campaignName, phone, name, [name]);
    res.json({ ok: true, campaign: campaignName, destination: formatPhone(phone) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ORDERS LIST ─────────────────────────────────────────────────────────────
app.get('/orders', async (req, res) => {
  if (!db) return res.json([]);
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders);
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const restaurant = await findRestaurantByPin(pin);
  if (!restaurant) return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  const token = generateToken(pin);
  res.json({
    token,
    restaurantName:   restaurant.name,
    googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins:     restaurant.avgDrinkMins,
    avgStarterMins:   restaurant.avgStarterMins,
    avgMainMins:      restaurant.avgMainMins,
  });
});

app.get('/verify', async (req, res) => {
  const token = req.headers['x-auth-token'];
  const restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Session expired' });
  res.json({ restaurantName: restaurant.name });
});

// ── META REGISTER (kept for now — remove once fully off Meta) ───────────────
app.get('/register-number', async (req, res) => {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/register`,
      { messaging_product: 'whatsapp', pin: '123456' },
      { headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.json({ success: false, error: error.response?.data || error.message });
  }
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
