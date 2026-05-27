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

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

let db;
MongoClient.connect(MONGODB_URI).then(client => {
  db = client.db('tablepulse');
  console.log('MongoDB connected');
});

async function sendMessage(to, text) {
  try {
    await axios({
      method: 'POST',
      url: 'https://graph.facebook.com/v18.0/' + PHONE_ID + '/messages',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      data: { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
    });
  } catch (err) {
    console.error('WhatsApp error:', err.response ? err.response.data : err.message);
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/order', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').insertOne({ phone, orderName, table, status: 'received', createdAt: new Date() });
  await sendMessage(phone, 'Namaste ' + orderName + ' ji, your order has been received by the kitchen. Your starters should be at the table in around 10 mins. Thank you for your patience. 😊');
});

app.post('/starters-ready', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone, orderName }, { $set: { status: 'starters-ready' } });
  await sendMessage(phone, 'Your starters are on the way to your table. 🍢 Our kitchen is already working on your main course so you won\'t have to wait long. Hope you enjoy the starters! 😊');
});

app.post('/main-started', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone, orderName }, { $set: { status: 'main-started' } });
  await sendMessage(phone, orderName + ' ji, your main course is now being freshly prepared. 🔥 Expected serving time is around 25 mins. Thank you for waiting — we\'ll make sure it\'s worth it. 🍛');
});

app.post('/main-ready', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  if (db) await db.collection('orders').updateOne({ phone, orderName }, { $set: { status: 'main-ready', completedAt: new Date() } });
  await sendMessage(phone, 'Your main course is on the way to Table ' + table + '. 🍽️ Freshly prepared by our kitchen and ready to be served. Enjoy your meal ❤️ — TablePulse');
});

app.post('/review', async (req, res) => {
  const { phone, orderName, reviewLink } = req.body;
  const link = reviewLink || process.env.DEFAULT_REVIEW_LINK || 'https://maps.app.goo.gl/QarAVmX5x1hiJ4DM9';
  res.json({ status: 'ok' });
  await sendMessage(phone, 'Thank you for dining with us ' + orderName + ' ji! 😊\nWe hope you enjoyed your meal.\nIf you did, please leave us a review: ' + link);
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
    restaurantName: restaurant.name,
    googleReviewLink: restaurant.googleReviewLink,
    avgDrinkMins: restaurant.avgDrinkMins,
    avgStarterMins: restaurant.avgStarterMins,
    avgMainMins: restaurant.avgMainMins
  });
});

app.get('/verify', async (req, res) => {
  const token = req.headers['x-auth-token'];
  const restaurant = await verifyToken(token);
  if (!restaurant) return res.status(401).json({ error: 'Session expired' });
  res.json({ restaurantName: restaurant.name });
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
