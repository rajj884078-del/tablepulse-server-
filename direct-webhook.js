// ─────────────────────────────────────────────────────────────────────────────
// TablePulse Direct — Step 2: Inbound webhook + state machine
// Drop this file into your project and require it in server.js like:
//   require('./direct-webhook')(app, db, sendWhatsApp);
//
// Then in AiSensy dashboard → Settings → Webhook → set URL to:
//   https://tablepulse-server.onrender.com/direct/webhook
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function registerDirectWebhook(app, db, sendWhatsApp) {

  // ── HELPERS ─────────────────────────────────────────────────────────────────

  // Send a plain text message via AiSensy Live Chat API (not template — no template needed for session replies)
  async function replyText(phone, text) {
    const axios = require('axios');
    try {
      await axios.post('https://backend.aisensy.com/live-chat/t1/api', {
        apiKey:      process.env.AISENSY_API_KEY,
        destination: phone,          // must include country code e.g. 919876543210
        message:     text
      }, { timeout: 8000 });
    } catch (e) {
      console.error('[direct] replyText failed:', e.response ? e.response.data : e.message);
    }
  }

  // Send an interactive LIST message (WhatsApp interactive/list)
  // sections: [{ title: 'Category', rows: [{ id, title, description }] }]
  async function replyList(phone, bodyText, buttonLabel, sections) {
    const axios = require('axios');
    try {
      await axios.post('https://backend.aisensy.com/live-chat/t1/api', {
        apiKey:      process.env.AISENSY_API_KEY,
        destination: phone,
        messageType: 'list',
        message:     bodyText,
        listOptions: { buttonText: buttonLabel, sections }
      }, { timeout: 8000 });
    } catch (e) {
      console.error('[direct] replyList failed:', e.response ? e.response.data : e.message);
    }
  }

  // Send interactive BUTTON message (max 3 buttons)
  async function replyButtons(phone, bodyText, buttons) {
    // buttons: [{ id: 'btn_1', title: 'Confirm Order' }]
    const axios = require('axios');
    try {
      await axios.post('https://backend.aisensy.com/live-chat/t1/api', {
        apiKey:      process.env.AISENSY_API_KEY,
        destination: phone,
        messageType: 'button',
        message:     bodyText,
        buttons
      }, { timeout: 8000 });
    } catch (e) {
      console.error('[direct] replyButtons failed:', e.response ? e.response.data : e.message);
    }
  }

  // ── SESSION HELPERS ──────────────────────────────────────────────────────────

  async function getSession(phone, restaurantId) {
    const { ObjectId } = require('mongodb');
    let session = await db.collection('direct_sessions').findOne({ phone });
    if (!session) {
      // New customer — create a fresh session
      session = {
        phone,
        restaurantId: new ObjectId(restaurantId),
        step:    'NEW',
        context: { activeCategory: null, activeItemId: null, page: 0 },
        cart:    [],
        updatedAt: new Date()
      };
      await db.collection('direct_sessions').insertOne(session);
    }
    return session;
  }

  async function saveSession(phone, update) {
    // Always refresh updatedAt to prevent TTL expiry mid-order
    await db.collection('direct_sessions').updateOne(
      { phone },
      { $set: { ...update, updatedAt: new Date() } }
    );
  }

  async function clearSession(phone) {
    await db.collection('direct_sessions').deleteOne({ phone });
  }

  // ── MENU HELPERS ─────────────────────────────────────────────────────────────

  async function getCategories(restaurantId) {
    const { ObjectId } = require('mongodb');
    const items = await db.collection('direct_menu').find({
      restaurantId: new ObjectId(restaurantId), available: true
    }).sort({ sortOrder: 1 }).toArray();
    // Deduplicate categories preserving order
    const seen = new Set();
    const cats = [];
    items.forEach(i => { if (!seen.has(i.category)) { seen.add(i.category); cats.push(i.category); } });
    return cats;
  }

  async function getItemsByCategory(restaurantId, category, page = 0) {
    const { ObjectId } = require('mongodb');
    const PAGE_SIZE = 8; // keep under WhatsApp's 10-row limit (leave 2 for nav rows)
    const items = await db.collection('direct_menu').find({
      restaurantId: new ObjectId(restaurantId), category, available: true
    }).sort({ sortOrder: 1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE + 1).toArray();
    const hasMore = items.length > PAGE_SIZE;
    return { items: items.slice(0, PAGE_SIZE), hasMore };
  }

  // ── CART HELPERS ──────────────────────────────────────────────────────────────

  function cartTotal(cart) {
    return cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  function cartSummary(cart) {
    if (!cart.length) return 'Your cart is empty.';
    const lines = cart.map(i => `• ${i.name} x${i.qty} — ₹${i.price * i.qty}`);
    lines.push(`\n*Total: ₹${cartTotal(cart)}*`);
    return lines.join('\n');
  }

  // ── CORE STATE MACHINE ────────────────────────────────────────────────────────
  //
  // Flow:  NEW → MENU → CATEGORY → ITEM → QTY → CART → CHECKOUT → PAYMENT → DONE
  //
  // Each step receives (session, inbound) and returns nothing — it replies directly
  // and saves the next step into the session.

  async function handleNew(session, phone, restaurant) {
    const categories = await getCategories(restaurant._id);
    if (!categories.length) {
      await replyText(phone, `Welcome to *${restaurant.name}*! 🍽️\nOur menu is being set up. Please check back soon.`);
      return;
    }
    // Build category list (max 10 rows — WhatsApp hard limit)
    const rows = categories.slice(0, 10).map(cat => ({
      id:    'cat_' + cat.replace(/\s+/g, '_').toLowerCase(),
      title: cat.slice(0, 24)          // WhatsApp truncates at 24 chars
    }));
    await replyList(
      phone,
      `👋 Welcome to *${restaurant.name}*!\nBrowse our menu below and place your order directly on WhatsApp.`,
      'View Menu',
      [{ title: 'Categories', rows }]
    );
    await saveSession(phone, { step: 'MENU', 'context.activeCategory': null });
  }

  async function handleMenu(session, phone, restaurant, inbound) {
    // Customer tapped a category from the list
    const selected = inbound.listReply || inbound.text || '';
    const categories = await getCategories(restaurant._id);

    // Match tapped ID back to category name
    const matched = categories.find(cat =>
      'cat_' + cat.replace(/\s+/g, '_').toLowerCase() === selected.toLowerCase() ||
      cat.toLowerCase() === selected.toLowerCase()
    );

    if (!matched) {
      // Unrecognised — re-show menu
      await handleNew(session, phone, restaurant);
      return;
    }

    await showCategoryItems(phone, restaurant, matched, 0, session);
  }

  async function showCategoryItems(phone, restaurant, category, page, session) {
    const { items, hasMore } = await getItemsByCategory(restaurant._id, category, page);
    if (!items.length) {
      await replyText(phone, `No items available in ${category} right now. Type *menu* to go back.`);
      return;
    }
    const rows = items.map(item => ({
      id:          'item_' + item._id.toString(),
      title:       item.name.slice(0, 24),
      description: ('₹' + item.price).slice(0, 72)
    }));
    if (hasMore) {
      rows.push({ id: 'next_page_' + (page + 1), title: 'More items ›', description: 'See next page' });
    }
    rows.push({ id: 'back_to_menu', title: '← Back to Menu', description: '' });

    await replyList(
      phone,
      `*${category}*\nSelect an item to add to your cart:`,
      'Pick Item',
      [{ title: category, rows }]
    );
    await saveSession(phone, {
      step: 'CATEGORY',
      'context.activeCategory': category,
      'context.page': page
    });
  }

  async function handleCategory(session, phone, restaurant, inbound) {
    const selected = inbound.listReply || inbound.text || '';

    // Back to main menu
    if (selected === 'back_to_menu' || selected.toLowerCase() === 'menu') {
      await handleNew(session, phone, restaurant);
      return;
    }

    // Pagination
    if (selected.startsWith('next_page_')) {
      const nextPage = parseInt(selected.replace('next_page_', ''), 10) || 0;
      await showCategoryItems(phone, restaurant, session.context.activeCategory, nextPage, session);
      return;
    }

    // Item selected
    if (selected.startsWith('item_')) {
      const { ObjectId } = require('mongodb');
      const itemId = selected.replace('item_', '');
      if (!ObjectId.isValid(itemId)) { await replyText(phone, 'Invalid selection. Type *menu* to browse again.'); return; }
      const item = await db.collection('direct_menu').findOne({ _id: new ObjectId(itemId) });
      if (!item) { await replyText(phone, 'Item not found. Type *menu* to browse again.'); return; }

      await replyButtons(
        phone,
        `*${item.name}*\n₹${item.price}\n\nHow many would you like?`,
        [
          { id: 'qty_1', title: '1' },
          { id: 'qty_2', title: '2' },
          { id: 'qty_3', title: '3' }
        ]
      );
      await saveSession(phone, {
        step: 'ITEM',
        'context.activeItemId': item._id.toString(),
        'context.activeItemName': item.name,
        'context.activeItemPrice': item.price
      });
      return;
    }

    // Anything else — re-show current category
    await showCategoryItems(phone, restaurant, session.context.activeCategory, session.context.page || 0, session);
  }

  async function handleItem(session, phone, restaurant, inbound) {
    const selected = inbound.buttonReply || inbound.text || '';
    let qty = 0;

    if (selected === 'qty_1' || selected === '1') qty = 1;
    else if (selected === 'qty_2' || selected === '2') qty = 2;
    else if (selected === 'qty_3' || selected === '3') qty = 3;
    else {
      // They typed a number
      const parsed = parseInt(selected, 10);
      if (parsed > 0 && parsed <= 20) qty = parsed;
    }

    if (!qty) {
      await replyButtons(phone, 'Please pick a quantity:', [
        { id: 'qty_1', title: '1' },
        { id: 'qty_2', title: '2' },
        { id: 'qty_3', title: '3' }
      ]);
      return;
    }

    // Add to cart (merge if already exists)
    const cart = session.cart || [];
    const existing = cart.find(i => i.itemId === session.context.activeItemId);
    if (existing) {
      existing.qty += qty;
    } else {
      cart.push({
        itemId: session.context.activeItemId,
        name:   session.context.activeItemName,
        price:  session.context.activeItemPrice,
        qty
      });
    }

    await saveSession(phone, { cart, step: 'CART' });
    await showCart(phone, restaurant, cart);
  }

  async function showCart(phone, restaurant, cart) {
    const summary = cartSummary(cart);
    await replyButtons(
      phone,
      `🛒 *Your Cart*\n\n${summary}\n\nWhat would you like to do?`,
      [
        { id: 'checkout',       title: '✅ Checkout' },
        { id: 'add_more',       title: '➕ Add More' },
        { id: 'clear_cart',     title: '🗑️ Clear Cart' }
      ]
    );
  }

  async function handleCart(session, phone, restaurant, inbound) {
    const selected = inbound.buttonReply || inbound.text || '';

    if (selected === 'add_more' || selected.toLowerCase() === 'add') {
      await handleNew(session, phone, restaurant);
      return;
    }

    if (selected === 'clear_cart') {
      await saveSession(phone, { cart: [], step: 'NEW' });
      await replyText(phone, '🗑️ Cart cleared. Type *menu* to start again.');
      return;
    }

    if (selected === 'checkout') {
      await handleCheckout(session, phone, restaurant);
      return;
    }

    // Unrecognised — re-show cart
    await showCart(phone, restaurant, session.cart);
  }

  async function handleCheckout(session, phone, restaurant) {
    const cart     = session.cart || [];
    const subtotal = cartTotal(cart);
    if (!subtotal) {
      await replyText(phone, 'Your cart is empty. Type *menu* to browse.');
      return;
    }

    const threshold    = restaurant.freeDeliveryThreshold || 600;
    const deliveryFee  = subtotal >= threshold ? 0 : 40;  // ₹40 flat placeholder until Porter API gives real quote
    const total        = subtotal + deliveryFee;
    const deliveryNote = deliveryFee === 0
      ? '🎉 Free delivery (order above ₹' + threshold + ')'
      : `🛵 Delivery fee: ₹${deliveryFee}`;

    const summary = cartSummary(cart);
    await replyButtons(
      phone,
      `📋 *Order Summary*\n\n${summary}\n\n${deliveryNote}\n*Total Payable: ₹${total}*\n\nConfirm your order?`,
      [
        { id: 'confirm_order', title: '✅ Confirm & Pay' },
        { id: 'edit_cart',     title: '✏️ Edit Cart' }
      ]
    );
    await saveSession(phone, {
      step: 'CHECKOUT',
      'context.subtotal':    subtotal,
      'context.deliveryFee': deliveryFee,
      'context.total':       total
    });
  }

  async function handleCheckoutReply(session, phone, restaurant, inbound) {
    const selected = inbound.buttonReply || inbound.text || '';

    if (selected === 'edit_cart') {
      await saveSession(phone, { step: 'CART' });
      await showCart(phone, restaurant, session.cart);
      return;
    }

    if (selected === 'confirm_order') {
      // Step 3 (Razorpay) will plug in here — for now ask for location
      await replyText(
        phone,
        '📍 *Share your delivery location*\n\nPlease tap the 📎 attachment icon → Location → Send Your Current Location.\n\nThis is needed to calculate the exact delivery route.'
      );
      await saveSession(phone, { step: 'LOCATION' });
      return;
    }

    await handleCheckout(session, phone, restaurant);
  }

  async function handleLocation(session, phone, restaurant, inbound) {
    // Customer shared their WhatsApp location pin
    if (!inbound.location) {
      await replyText(phone, '📍 Please share your location using the 📎 attachment button → Location.\n\nThis is required for delivery.');
      return;
    }

    const { latitude, longitude, name: locName, address } = inbound.location;
    const displayAddr = address || locName || `${latitude}, ${longitude}`;

    await saveSession(phone, {
      step: 'PAYMENT',
      'context.dropLat':  latitude,
      'context.dropLng':  longitude,
      'context.dropAddr': displayAddr
    });

    // ── STEP 3 WILL GO HERE: generate Razorpay link and send it ──
    // For now confirm and show a placeholder
    await replyButtons(
      phone,
      `✅ *Location received!*\n📍 ${displayAddr}\n\n*Total: ₹${session.context.total}*\n\nProceeding to payment...`,
      [{ id: 'pay_now', title: '💳 Pay Now' }]
    );
  }

  // ── GLOBAL KEYWORD SHORTCUTS ──────────────────────────────────────────────────
  // Customer can type these at any step to reset or get help

  function isKeyword(text, keywords) {
    return keywords.includes((text || '').toLowerCase().trim());
  }

  // ── MAIN INBOUND ROUTER ───────────────────────────────────────────────────────

  async function processInbound(phone, inbound, restaurant) {
    const rawText = (inbound.text || '').toLowerCase().trim();

    // Global keyword shortcuts — work at any step
    if (isKeyword(rawText, ['menu', 'hi', 'hello', 'start', 'hlo', 'hey'])) {
      const session = await getSession(phone, restaurant._id);
      await handleNew(session, phone, restaurant);
      return;
    }
    if (isKeyword(rawText, ['cart', 'my cart', 'bag'])) {
      const session = await getSession(phone, restaurant._id);
      if (!session.cart || !session.cart.length) {
        await replyText(phone, 'Your cart is empty. Type *menu* to browse.');
      } else {
        await showCart(phone, restaurant, session.cart);
      }
      return;
    }

    const session = await getSession(phone, restaurant._id);

    switch (session.step) {
      case 'NEW':      await handleNew(session, phone, restaurant); break;
      case 'MENU':     await handleMenu(session, phone, restaurant, inbound); break;
      case 'CATEGORY': await handleCategory(session, phone, restaurant, inbound); break;
      case 'ITEM':     await handleItem(session, phone, restaurant, inbound); break;
      case 'CART':     await handleCart(session, phone, restaurant, inbound); break;
      case 'CHECKOUT': await handleCheckoutReply(session, phone, restaurant, inbound); break;
      case 'LOCATION': await handleLocation(session, phone, restaurant, inbound); break;
      default:
        await handleNew(session, phone, restaurant);
    }
  }

  // ── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
  // AiSensy sends inbound messages here.
  // Set this URL in AiSensy Dashboard → Settings → Webhook

  app.post('/direct/webhook', async (req, res) => {
    // Acknowledge immediately — AiSensy retries if it doesn't get 200 within 5s
    res.sendStatus(200);

    try {
      const body = req.body;

      // ── Parse AiSensy/Meta inbound payload ──
      // AiSensy uses Meta's standard Cloud API webhook format:
      // body.entry[0].changes[0].value.messages[0]
      const entry    = body?.entry?.[0];
      const change   = entry?.changes?.[0];
      const value    = change?.value;
      const messages = value?.messages;
      if (!messages || !messages.length) return; // delivery receipt or status update — ignore

      const msg     = messages[0];
      const phone   = msg.from;   // e.g. "919876543210" (no + prefix from Meta)
      const msgType = msg.type;   // "text" | "interactive" | "location"

      // Build normalised inbound object
      const inbound = {
        text:        null,
        listReply:   null,  // row ID when customer picks from a list
        buttonReply: null,  // button ID when customer taps a button
        location:    null
      };

      if (msgType === 'text') {
        inbound.text = msg.text?.body || '';
      } else if (msgType === 'interactive') {
        const interactive = msg.interactive;
        if (interactive.type === 'list_reply') {
          inbound.listReply = interactive.list_reply?.id || '';
          inbound.text      = interactive.list_reply?.title || '';
        } else if (interactive.type === 'button_reply') {
          inbound.buttonReply = interactive.button_reply?.id || '';
          inbound.text        = interactive.button_reply?.title || '';
        }
      } else if (msgType === 'location') {
        inbound.location = {
          latitude:  msg.location?.latitude,
          longitude: msg.location?.longitude,
          name:      msg.location?.name,
          address:   msg.location?.address
        };
      } else {
        // Image, audio, etc — not handled yet
        return;
      }

      // ── Find which restaurant this WhatsApp number belongs to ──
      // For now: single-restaurant mode — you pass restaurantId as a query param
      // when setting the webhook URL in AiSensy.
      // e.g. /direct/webhook?restaurantId=64abc123...
      // Later: support multiple restaurants by mapping phone numbers to restaurants.
      const restaurantId = req.query.restaurantId;
      if (!restaurantId) {
        console.error('[direct-webhook] no restaurantId in query — set ?restaurantId=... in AiSensy webhook URL');
        return;
      }

      const { ObjectId } = require('mongodb');
      if (!ObjectId.isValid(restaurantId)) { console.error('[direct-webhook] invalid restaurantId'); return; }
      const restaurant = await db.collection('restaurants').findOne({ _id: new ObjectId(restaurantId) });
      if (!restaurant) { console.error('[direct-webhook] restaurant not found for id=' + restaurantId); return; }

      console.log('[direct-webhook] msg from=' + phone + ' type=' + msgType + ' step=' + 'pending lookup' + ' restaurant=' + restaurant.name);

      await processInbound(phone, inbound, restaurant);

    } catch (e) {
      console.error('[direct-webhook] error:', e.message, e.stack);
    }
  });

  // ── TTL INDEX SETUP ───────────────────────────────────────────────────────────
  // Run once on boot to ensure sessions expire after 2h of inactivity
  db.collection('direct_sessions').createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 7200, background: true }
  ).catch(e => console.error('[direct-sessions] TTL index error:', e.message));

  console.log('[direct] webhook registered at POST /direct/webhook');
};
