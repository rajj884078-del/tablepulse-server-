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

// v2 templates — variable order:
// order_received:  {{1}}=name, {{2}}=table, {{3}}=restaurant name
// order_preparing: {{1}}=name
// order_arriving:  {{1}}=name
// order_delay:     {{1}}=name
// review_request:  {{1}}=name, {{2}}=review link
function getParams(stage, name, extras) {
  extras = extras || {};
  if (stage === 'order_received')  return [name, extras.table || '', 'Gravity Family Dine and Bar'];
  if (stage === 'order_preparing') return [name];
  if (stage === 'order_arriving')  return [name];
  if (stage === 'order_delay')     return [name];
  if (stage === 'review_request')  return [name, extras.reviewLink || 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9'];
  return [name];
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/order', async function(req, res) {
  const { phone, orderName, table } = req.body;
  const courses  = req.body.courses  || [];
  const sameTime = req.body.sameTime || false;
  const toK      = req.body.toK !== false;
  const toB      = req.body.toB !== false;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({
    phone, orderName, table, courses, sameTime, toK, toB,
    bNotified: false, status: 'active', createdAt: new Date()
  });
  await sendWhatsApp('table_order_received_v2', phone, orderName, getParams('order_received', orderName, { table: table }));
});

app.get('/active-orders', async function(req, res) {
  if (!db) return res.json([]);
  const orders = await db.collection('orders')
    .find({ status: { $ne: 'done' } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  res.json(orders.map(function(o) {
    return Object.assign({}, o, { _id: o._id.toString() });
  }));
});

app.post('/update-course', async function(req, res) {
  const { orderId, courseType, status } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try {
    const upd = { $set: { 'courses.$.status': status } };
    if (courseType === 'main' && status === 'started') upd.$set.mainStartedAt = new Date();
    if (courseType === 'main' && status === 'ready')   upd.$set.mainStartedAt = null;
    await db.collection('orders').updateOne(
      { _id: new ObjectId(orderId), 'courses.type': courseType }, upd);
    const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
    if (order) {
      if (courseType === 'main' && status === 'started')
        await sendWhatsApp('table_order_preparing_v2', order.phone, order.orderName, getParams('order_preparing', order.orderName));
      if (courseType === 'main' && status === 'ready')
        await sendWhatsApp('table_order_arriving_v2', order.phone, order.orderName, getParams('order_arriving', order.orderName));
    }
  } catch(e) { console.error('update-course error:', e.message); }
});

app.post('/notify-bar', async function(req, res) {
  const { orderId } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try { await db.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { bNotified: true } }); } catch(e) {}
});

app.post('/order-done', async function(req, res) {
  const { orderId } = req.body;
  res.json({ status: 'ok' });
  if (!db || !orderId) return;
  try { await db.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { status: 'done', completedAt: new Date() } }); } catch(e) {}
});

app.post('/review', async function(req, res) {
  let { phone, orderName, reviewLink, orderId } = req.body;
  if (orderId && db) {
    try {
      const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
      if (order) { phone = order.phone; orderName = order.orderName; }
    } catch(e) {}
  }
  res.json({ status: 'ok' });
  await sendWhatsApp('table_review_request_v2', phone, orderName, getParams('review_request', orderName, { reviewLink }));
});

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

app.get('/orders', async function(req, res) {
  if (!db) return res.json([]);
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(orders);
});

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
