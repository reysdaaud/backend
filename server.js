const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Load environment variables from .env file
dotenv.config();

// Destructure environment variables
const {
  STRIPE_SECRET_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  PORT
} = process.env;

// --- Environment Variable Validation ---
if (!STRIPE_SECRET_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('❌ Missing one or more required environment variables.');
  process.exit(1);
}

// --- Initialize Stripe ---
const stripe = new Stripe(STRIPE_SECRET_KEY);
console.log('✅ Stripe initialized.');

// --- Initialize Firebase Admin SDK ---
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Firebase Admin SDK initialized.');
  }
} catch (error) {
  console.error('❌ Error initializing Firebase Admin SDK:', error.message);
  if (error.message.includes('malformed private key')) {
    console.error('💡 Hint: Check your FIREBASE_PRIVATE_KEY format.');
  }
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const port = PORT || 5000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Routes ---

app.get('/health', (req, res) => {
  res.json({ status: 'Stripe backend server is up and running', timestamp: new Date().toISOString() });
});

app.post('/stripe/create-intent', async (req, res) => {
  const { amount, userId, email, coins, packageName } = req.body;
  try {
    if (!amount || !userId || !email || !coins || !packageName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
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
    if (!userId || !coins) {
      return res.status(400).json({ success: false, message: 'Missing metadata' });
    }
    const coinsToAdd = parseInt(coins, 10);
    if (isNaN(coinsToAdd)) {
      return res.status(400).json({ success: false, message: 'Invalid coin amount' });
    }
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const currentCoins = userSnap.data().coins || 0;
    await userRef.update({ coins: currentCoins + coinsToAdd });
    res.json({ success: true, newBalance: currentCoins + coinsToAdd });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========== WAAFI INITIATE ==========
app.post('/api/waafi/initiate', async (req, res) => {
  try {
    const response = await fetch('https://api.waafipay.net/asm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const result = await response.json();

    if (!response.ok || result.responseCode !== '2001') {
      return res.status(500).json({
        success: false,
        message: result.responseMsg || 'Waafi initiation failed.',
        result,
      });
    }

    res.status(200).json({
      success: true,
      message: result.responseMsg,
      result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Server listening on http://localhost:${port}`);
});

