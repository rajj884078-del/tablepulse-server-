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

const TOKEN        = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI  = process.env.MONGODB_URI;
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;

let db;
MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('tablepulse');
  console.log('MongoDB connected');
});

function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10)                       return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  if (d.length === 11 && d.startsWith('0'))  return `+91${d.slice(1)}`;
  return `+${d}`;
}

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) {
    console.error('[aisensy] AISENSY_API_KEY not set');
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

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE PARAMS — update these as you confirm each template's variable count.
// Open each template in AiSensy, count {{1}} {{2}} etc., add matching values here.
//
// order_received  → 3 vars confirmed: name, restaurant, est. time
// others          → 1 var assumed (name only) — will update after testing
// ─────────────────────────────────────────────────────────────────────────────
const RESTAURANT_NAME = 'Gravity';

function paramsFor(stage, name, table) {
  switch (stage) {
    case 'order_received':  return [name, RESTAURANT_NAME, '20'];  // {{1}} {{2}} {{3}}
    case 'order_preparing': return [name];                          // update after testing
    case 'order_arriving':  return [name];                          // update after testing
    case 'order_delay':     return [name];                          // update after testing
    case 'review_request':  return [name];                          // update after testing
    default:                return [name];
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ORDER CREATED — Waiter screen
app.post('/order', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({
    phone, orderName, table, status: 'received', createdAt: new Date()
  });
  await sendWhatsApp('table_order_received', phone, orderName, paramsFor('order_received', orderName, table));
});

// STARTERS READY — Kitchen screen (DB only, no WhatsApp — no template for this yet)
app.post('/starters-ready', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'starters-ready' } }
  );
});

// MAIN COURSE STARTED — Kitchen screen
app.post('/main-started', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'main-started' } }
  );
  await sendWhatsApp('table_order_preparing', phone, orderName, paramsFor('order_preparing', orderName));
});

// MAIN COURSE READY — Kitchen screen
app.post('/main-ready', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne(
    { phone, orderName },
    { $set: { status: 'main-ready', completedAt: new Date() } }
  );
  await sendWhatsApp('table_order_arriving', phone, orderName, paramsFor('order_arriving', orderName, table));
});

// REVIEW REQUEST — Supervisor / Waiter screen
app.post('/review', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  await sendWhatsApp('table_review_request', phone, orderName, paramsFor('review_request', orderName));
});

// TEST ENDPOINT — hit from browser to test any stage without going through the UI
// https://tablepulse-server.onrender.com/test-whatsapp?stage=order_received&phone=918840782539&name=Raj
app.get('/test-whatsapp', async (req, res) => {
  const { phone, name, stage } = req.query;
  if (!phone || !name || !stage) {
    return res.status(400).json({ error: 'Required: phone, name, stage' });
  }
  const campaigns = {
    order_received:  'table_order_received',
    order_preparing: 'table_order_preparing',
    order_arriving:  'table_order_arriving',
    order_delay:     'table_order_delay',
    review_request:  'table_review_request',
  };
  const campaignName = campaigns[stage];
  if (!campaignName) {
    return res.status(400).json({ error: `Unknown stage "${stage}"`, valid: Object.keys(campaigns) });
  }
  try {
    const params = paramsFor(stage, name);
    await sendWhatsApp(campaignName, phone, name, [name, 'Gravity', '20']);
    res.json({ ok: true, campaign: campaignName, destination: formatPhone(phone), params });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/orders', async (req, res) => {
  if (!db) return res.json([]);
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders);
});

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
