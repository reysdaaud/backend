const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const Stripe = require('stripe');

// Load environment variables
dotenv.config();

const {
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  PAYSTACK_SECRET_KEY,
  STRIPE_SECRET_KEY,
  PORT
} = process.env;

// --- Env Validation ---
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !PAYSTACK_SECRET_KEY || !STRIPE_SECRET_KEY) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

// --- Firebase Admin Init ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log('✅ Firebase Admin initialized');
}
const db = admin.firestore();

// --- Stripe Init ---
const stripe = new Stripe(STRIPE_SECRET_KEY);
console.log('✅ Stripe initialized');

const app = express();
const port = PORT || 5000;

// --- Middleware ---
app.use(express.json());
app.use(cors({
  origin: '*', // Allow all origins during local test
  credentials: true
}));

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ========== Stripe ==========
app.post('/stripe/create-intent', async (req, res) => {
  const { amount, userId, email, coins, packageName } = req.body;
  try {
    if (!amount || !userId || !email || !coins || !packageName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // expects cents already from frontend
      currency: 'usd',
      metadata: { userId, coins: coins.toString(), packageName, email },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/stripe/verify/:intentId', async (req, res) => {
  const { intentId } = req.params;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: `Payment not completed. Status: ${intent.status}` });
    }

    const { userId, coins, email, packageName } = intent.metadata;
    if (!userId || !coins) return res.status(400).json({ success: false, message: 'Missing metadata' });

    const coinsToAdd = parseInt(coins, 10);
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const currentCoins = userSnap.data().coins || 0;

    await userRef.update({
      coins: currentCoins + coinsToAdd,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentHistory: admin.firestore.FieldValue.arrayUnion({
        amount: intent.amount / 100,
        coins: coinsToAdd,
        status: 'success',
        reference: intent.id,
        packageName,
        gateway: 'stripe',
        timestamp: new Date()
      })
    });

    res.json({ success: true, newBalance: currentCoins + coinsToAdd });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========== Paystack ==========
app.post('/paystack/initialize', async (req, res) => {
  try {
    const { email, amount, metadata } = req.body;
    if (!email || !amount) return res.status(400).json({ status: false, message: 'Email and amount required' });

    const payload = {
      email,
      amount: Number(amount) * 100,
      currency: 'KES',
      callback_url: `https://www.icasti.com/payment-success?type=paystack&uid=${metadata.userId}&coins=${metadata.coins}`,
      metadata
    };

    const paystackRes = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    res.json(paystackRes.data);
  } catch (e) {
    res.status(500).json({ status: false, message: 'Initialization failed', error: e.response?.data || e.message });
  }
});

// ========== Waafi ==========
app.post('/api/waafi/initiate', async (req, res) => {
  try {
    const response = await fetch('https://api.waafipay.net/asm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const result = await response.json();
    if (!response.ok || result.responseCode !== '2001') {
      return res.status(500).json({ success: false, message: result.responseMsg || 'Waafi initiation failed.', result });
    }
    res.status(200).json({ success: true, message: result.responseMsg, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
