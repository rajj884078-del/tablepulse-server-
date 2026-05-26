require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

async function sendMessage(to, text) {
  try {
    const response = await axios({
      method: 'POST',
      url: 'https://graph.facebook.com/v18.0/' + PHONE_ID + '/messages',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      }
    });
    console.log('Sent:', response.data);
  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
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
  await sendMessage(phone, 'Namaste ' + orderName + ' ji, your order has been received by the kitchen. Your starters should be at the table in around 10 mins. Thank you for your patience.');
});

app.post('/starters-ready', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  await sendMessage(phone, 'Your starters are on the way to your table. Our kitchen is already working on your main course so you won\'t have to wait long. Hope you enjoy the starters!');
});

app.post('/main-started', async (req, res) => {
  const { phone, orderName } = req.body;
  res.json({ status: 'ok' });
  await sendMessage(phone, orderName + ' ji, your main course is now being freshly prepared. Expected serving time is around 25 mins. Thank you for waiting — we\'ll make sure it\'s worth it.');
});

app.post('/main-ready', async (req, res) => {
  const { phone, orderName, table } = req.body;
  res.json({ status: 'ok' });
  await sendMessage(phone, 'Your main course is on the way to Table ' + table + '. Freshly prepared by our kitchen and ready to be served. Enjoy your meal — TablePulse');
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
