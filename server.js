const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_live_900833fc12e3164258ae0ab0e5e3d20b1f26dfda';
const SUPABASE_URL = 'https://qpjnzhmuwklvqmevlxjm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwam56aG11d2tsdnFtZXZseGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNjQ1ODUsImV4cCI6MjA4OTg0MDU4NX0.OlFw50GiD4vNzrLZ2-dFXVdAD8OxG1-g0xP_erR_n98';

// ── INITIALIZE TRANSACTION (called by portal when student clicks Subscribe) ──
app.post('/subscribe', async (req, res) => {
  const { email, name, plan, userId, amount } = req.body;
  if (!email || !userId || !amount) return res.status(400).json({ error: 'Missing fields' });

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amount * 100, // Paystack uses kobo/cents (amount in ZAR * 100)
        currency: 'ZAR',
        metadata: {
          userId,
          name,
          plan,
          custom_fields: [
            { display_name: 'Plan', variable_name: 'plan', value: plan },
            { display_name: 'Portal User ID', variable_name: 'userId', value: userId },
          ],
        },
        callback_url: 'https://tafxportal.com?payment=success',
        plan: process.env.PAYSTACK_PLAN_CODE, // Monthly subscription plan code
      }),
    });

    const data = await response.json();
    if (!data.status) return res.status(400).json({ error: data.message });
    res.json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── WEBHOOK (called by Paystack after payment completes) ──
app.post('/webhook', async (req, res) => {
  // Verify webhook signature
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('Invalid webhook signature');
    return res.sendStatus(400);
  }

  const { event, data } = req.body;
  console.log('Webhook event:', event);

  // Handle successful charge (new subscription or renewal)
  if (event === 'charge.success' || event === 'subscription.create') {
    const userId = data.metadata?.userId;
    const plan = data.metadata?.plan || 'Private Mentorship';

    if (userId) {
      try {
        // Get current user levels
        const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=levels`, {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
        const users = await userRes.json();
        const current = users[0]?.levels || [];

        if (!current.includes(plan)) {
          const updated = [...current, plan];
          await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ levels: updated }),
          });
          console.log(`✅ Activated ${plan} for userId ${userId}`);
        }
      } catch (err) {
        console.error('Supabase update error:', err);
      }
    }
  }

  // Handle subscription cancellation / disabling
  if (event === 'subscription.disable' || event === 'subscription.not_renew') {
    const userId = data.metadata?.userId;
    const plan = data.metadata?.plan || 'Private Mentorship';

    if (userId) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=levels`, {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
        const users = await userRes.json();
        const current = users[0]?.levels || [];
        const updated = current.filter(l => l !== plan);

        await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ levels: updated }),
        });
        console.log(`❌ Deactivated ${plan} for userId ${userId}`);
      } catch (err) {
        console.error('Supabase remove error:', err);
      }
    }
  }

  res.sendStatus(200);
});

// ── VERIFY PAYMENT (called by portal after redirect back) ──
app.get('/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Paystack backend running on port ${PORT}`));
