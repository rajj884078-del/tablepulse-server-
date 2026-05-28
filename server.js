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
  if (d.length === 10)                       return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0'))  return '+91' + d.slice(1);
  return '+' + d;
}

async function sendWhatsApp(campaignName, phone, orderName, templateParams) {
  if (!AISENSY_API_KEY) {
    console.error('[aisensy] AISENSY_API_KEY not set');
    return;
  }
  try {
    await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', {
      apiKey:         AISENSY_API_KEY,
      campaignName:   campaignName,
      destination:    formatPhone(phone),
      userName:       orderName,
      source:         'tablepulse-server',
      templateParams: templateParams
    });
    console.log('[aisensy] sent ' + campaignName + ' to ' + formatPhone(phone));
  } catch (err) {
    console.error('[aisensy] failed ' + campaignName + ':', err.response ? err.response.data : err.message);
  }
}

// Template params per stage — verified against actual template variable counts
// order_received:  3 vars — name, restaurant, est. time
// order_preparing: 1 var  — name
// order_arriving:  1 var  — name
// order_delay:     1 var  — name
// review_request:  2 vars — name, review link
function getParams(stage, name, extras) {
  extras = extras || {};
  if (stage === 'order_received')  return [name, extras.restaurant || 'Gravity', extras.time || '20'];
  if (stage === 'order_preparing') return [name];
  if (stage === 'order_arriving')  return [name];
  if (stage === 'order_delay')     return [name];
  if (stage === 'review_request')  return [name, extras.reviewLink || 'https://maps.app.goo.gl/56Aj2XfVbofEtmN47?g_st=ac'];
  return [name];
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ORDER CREATED — Waiter screen
app.post('/order', async function(req, res) {
  var phone = req.body.phone;
  var orderName = req.body.orderName;
  var table = req.body.table;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({ phone: phone, orderName: orderName, table: table, status: 'received', createdAt: new Date() });
  await sendWhatsApp('table_order_received', phone, orderName, getParams('order_received', orderName));
});

// STARTERS READY — Kitchen screen (no WhatsApp, no template for this yet)
app.post('/starters-ready', async function(req, res) {
  var phone = req.body.phone;
  var orderName = req.body.orderName;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone: phone, orderName: orderName }, { $set: { status: 'starters-ready' } });
});

// MAIN COURSE STARTED — Kitchen screen
app.post('/main-started', async function(req, res) {
  var phone = req.body.phone;
  var orderName = req.body.orderName;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone: phone, orderName: orderName }, { $set: { status: 'main-started' } });
  await sendWhatsApp('table_order_preparing', phone, orderName, getParams('order_preparing', orderName));
});

// MAIN COURSE READY — Kitchen screen
app.post('/main-ready', async function(req, res) {
  var phone = req.body.phone;
  var orderName = req.body.orderName;
  var table = req.body.table;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone: phone, orderName: orderName }, { $set: { status: 'main-ready', completedAt: new Date() } });
  await sendWhatsApp('table_order_arriving', phone, orderName, getParams('order_arriving', orderName));
});

// REVIEW REQUEST — Supervisor / Waiter screen
app.post('/review', async function(req, res) {
  var phone = req.body.phone;
  var orderName = req.body.orderName;
  var reviewLink = req.body.reviewLink;
  res.json({ status: 'ok' });
  await sendWhatsApp('table_review_request', phone, orderName, getParams('review_request', orderName, { reviewLink: reviewLink }));
});

// TEST ENDPOINT — browser URL to test each stage without going through the UI
// https://tablepulse-server.onrender.com/test-whatsapp?stage=order_received&phone=918840782539&name=Raj
app.get('/test-whatsapp', async function(req, res) {
  var phone = req.query.phone;
  var name = req.query.name;
  var stage = req.query.stage;
  if (!phone || !name || !stage) {
    return res.status(400).json({ error: 'Required: phone, name, stage' });
  }
  var campaigns = {
    order_received:  'table_order_received',
    order_preparing: 'table_order_preparing',
    order_arriving:  'table_order_arriving',
    order_delay:     'table_order_delay',
    review_request:  'table_review_request'
  };
  var campaignName = campaigns[stage];
  if (!campaignName) {
    return res.status(400).json({ error: 'Unknown stage: ' + stage, valid: Object.keys(campaigns) });
  }
  var params = getParams(stage, name, { reviewLink: 'https://maps.app.goo.gl/56Aj2XfVbofEtmN47?g_st=ac' });
  await sendWhatsApp(campaignName, phone, name, params);
  res.json({ ok: true, campaign: campaignName, destination: formatPhone(phone), params: params });
});

app.get('/orders', async function(req, res) {
  if (!db) return res.json([]);
  var orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders);
});

app.post('/login', async function(req, res) {
  var pin = req.body.pin;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  var restaurant = await findRestaurantByPin(pin);
  if (!restaurant) return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  var token = generateToken(pin);
  res.json({
    token: token,
    restaurantName: restaurant.name,
    googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins,
    avgStarterMins: restaurant.avgStarterMins,
    avgMainMins: restaurant.avgMainMins
  });
});

app.get('/verify', async function(req, res) {
  var token = req.headers['x-auth-token'];
  var restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Session expired' });
  res.json({ restaurantName: restaurant.name });
});

app.get('/register-number', async function(req, res) {
  try {
    var response = await axios.post(
      'https://graph.facebook.com/v18.0/' + PHONE_ID + '/register',
      { messaging_product: 'whatsapp', pin: '123456' },
      { headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.json({ success: false, error: error.response ? error.response.data : error.message });
  }
});

app.listen(3000, function() { console.log('TablePulse running on port 3000'); });
