require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

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
  const phone = req.body.phone;
  const orderName = req.body.orderName;
  res.json({ status: 'ok' });
  await sendMessage(phone, 'Order received! Shukriya ' + orderName + ' ji!');
  setTimeout(async () => {
    await sendMessage(phone, 'Aapka khana ban raha hai. Thoda wait karein!');
  }, 10 * 60 * 1000);
  setTimeout(async () => {
    await sendMessage(phone, 'Almost ready! Bas 5 minute aur!');
  }, 25 * 60 * 1000);
});

app.listen(3000, () => console.log('TablePulse running on port 3000'));
