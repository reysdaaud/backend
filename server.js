// Final unified server.js with Stripe, Waafi, and Paystack integration

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const axios = require('axios');
const fetch = require('node-fetch');

// Load environment variables from .env
dotenv.config();

const {
  STRIPE_SECRET_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  PAYSTACK_SECRET_KEY,
  PORT
} = process.env;

if (!STRIPE_SECRET_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !PAYSTACK_SECRET_KEY) {
  console.error('❌ Missing one or more required environment variables.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  console.log('✅ Firebase Admin initialized');
}

const db = admin.firestore();
const app = express();
const port = PORT || 5000;

app.use(cors());
app.use(express.json());

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'Server is healthy', time: new Date().toISOString() });
});

// STRIPE CREATE INTENT
app.post('/stripe/create-intent', async (req, res) => {
  const { amount, userId, email, coins, packageName } = req.body;
  if (!amount || !userId || !email || !coins || !packageName) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { userId, coins: coins.toString(), email, packageName },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STRIPE VERIFY
app.post('/stripe/verify/:intentId', async (req, res) => {
  const { intentId } = req.params;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status !== 'succeeded') return res.status(400).json({ success: false, message: 'Payment not completed' });

    const { userId, coins } = intent.metadata;
    const coinsToAdd = parseInt(coins);
    const userRef = db.collection('users').doc(userId);

    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const prev = snap.exists ? snap.data().coins || 0 : 0;
      const newBalance = prev + coinsToAdd;
      const paymentData = {
        amount: intent.amount / 100,
        coins: coinsToAdd,
        reference: intentId,
        gateway: 'stripe',
        status: 'success',
        timestamp: new Date(),
      };
      if (!snap.exists) {
        t.set(userRef, { uid: userId, coins: newBalance, paymentHistory: [paymentData] });
      } else {
        t.update(userRef, {
          coins: newBalance,
          paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
        });
      }
    });

    res.json({ success: true, message: 'Coins added', coins: coinsToAdd });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PAYSTACK INITIALIZE
app.post('/paystack/initialize', async (req, res) => {
  const { email, amount, metadata } = req.body;
  if (!email || !amount || !metadata?.userId || !metadata.coins) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const payload = {
      email,
      amount: amount * 100,
      currency: 'KES',
      callback_url: `https://www.icasti.com/payment-success?type=paystack&uid=${metadata.userId}&coins=${metadata.coins}`,
      metadata
    };
    const response = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PAYSTACK VERIFY
app.get('/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const tx = response.data;
    if (tx.data.status !== 'success') return res.status(400).json({ success: false });

    const { metadata, amount } = tx.data;
    const coins = parseInt(metadata.coins);
    const userRef = db.collection('users').doc(metadata.userId);

    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const prev = snap.exists ? snap.data().coins || 0 : 0;
      const paymentData = {
        amount: amount / 100,
        coins,
        gateway: 'paystack',
        status: 'success',
        reference,
        timestamp: new Date()
      };
      if (!snap.exists) {
        t.set(userRef, { uid: metadata.userId, coins, paymentHistory: [paymentData] });
      } else {
        t.update(userRef, {
          coins: prev + coins,
          paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
        });
      }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WAAFI CALLBACK
app.post('/api/waafi/callback', async (req, res) => {
  const { waafiResult } = req.body;
  const params = waafiResult?.params;
  if (!params || params.state !== 'APPROVED') return res.status(400).json({ success: false });

  const { invoiceId: userId, transactionId, referenceId, txAmount } = params;
  const coins = parseInt(txAmount);
  if (!userId || isNaN(coins)) return res.status(400).json({ success: false });

  const userRef = db.collection('users').doc(userId);
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    const prev = snap.exists ? snap.data().coins || 0 : 0;
    const payment = {
      coins,
      amount: coins,
      transactionId,
      reference: referenceId,
      status: 'success',
      gateway: 'waafi',
      timestamp: new Date(),
    };
    if (!snap.exists) {
      t.set(userRef, { uid: userId, coins, paymentHistory: [payment] });
    } else {
      t.update(userRef, {
        coins: prev + coins,
        paymentHistory: admin.firestore.FieldValue.arrayUnion(payment),
      });
    }
  });
  res.json({ success: true });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server listening at http://localhost:${port}`);
});
