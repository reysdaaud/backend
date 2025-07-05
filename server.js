const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');
const fetch = require('node-fetch');
const Stripe = require('stripe');

// Load environment variables
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
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-08-16' });

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

// Middleware
app.use(cors({
  origin: ['https://www.icasti.com', 'https://checkout.paystack.com'],
  credentials: true,
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const allowedOrigins = ['https://www.icasti.com', 'https://checkout.paystack.com'];
  if (allowedOrigins.includes(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

// ========== STRIPE ========== //
app.post('/stripe/create-intent', async (req, res) => {
  try {
    const { amount, userId, coins, packageName, email, phoneNumber } = req.body;

    if (!amount || !userId || !coins || !email) {
      return res.status(400).json({ error: 'Missing required fields: amount, userId, coins, email.' });
    }

    const finalAmount = Math.round(Number(amount) * 100);
    if (isNaN(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: finalAmount,
      currency: 'usd',
      receipt_email: email,
      metadata: {
        userId,
        coins: coins.toString(),
        packageName: packageName || 'Default Package',
        phone: phoneNumber || 'n/a',
      },
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('❌ Stripe PaymentIntent Error:', error.message);
    res.status(500).json({ error: 'Failed to create payment intent.', detail: error.message });
  }
});

app.post('/stripe/verify/:intentId', async (req, res) => {
  const { intentId } = req.params;

  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    const metadata = intent.metadata || {};
    const userId = metadata.userId;
    const coinsToAdd = parseInt(metadata.coins || '0');
    const packageName = metadata.packageName || 'N/A';

    if (!userId || isNaN(coinsToAdd) || coinsToAdd <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid or missing metadata.' });
    }

    const userRef = db.collection('users').doc(userId);
    const txRef = db.collection('transactions').doc(intentId);

    await db.runTransaction(async (transaction) => {
      const txDoc = await transaction.get(txRef);
      if (txDoc.exists) return;

      const userDoc = await transaction.get(userRef);
      const currentCoins = userDoc.exists ? (userDoc.data().coins || 0) : 0;
      const updatedCoins = currentCoins + coinsToAdd;

      const paymentData = {
        amount: intent.amount / 100,
        coins: coinsToAdd,
        timestamp: new Date(),
        reference: intentId,
        gateway: 'stripe',
        status: 'success',
        packageName,
        receiptUrl: intent.charges?.data?.[0]?.receipt_url || null,
        cardBrand: intent.charges?.data?.[0]?.payment_method_details?.card?.brand || null,
      };

      if (!userDoc.exists) {
        transaction.set(userRef, {
          uid: userId,
          coins: updatedCoins,
          paymentHistory: [paymentData],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(userRef, {
          coins: updatedCoins,
          paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      transaction.set(txRef, {
        userId,
        coinsAdded: coinsToAdd,
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true, message: 'Coins added successfully.', coins: coinsToAdd });
  } catch (err) {
    console.error('❌ Stripe verification error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed', error: err.message });
  }
});

// ========== WAAFI ========== //
app.post('/api/waafi/initiate', async (req, res) => {
  try {
    const response = await fetch('https://api.waafipay.net/asm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const result = await response.json();
    if (!response.ok || result.responseCode !== "2001") {
      return res.status(500).json({ success: false, message: result.responseMsg || 'Waafi initiation failed.', result });
    }
    res.status(200).json({ success: true, message: result.responseMsg, result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/waafi/callback', async (req, res) => {
  try {
    const { waafiResult } = req.body;
    const params = waafiResult?.params;
    if (!params || params.state !== 'APPROVED') return res.status(400).json({ success: false, message: 'Not approved' });

    const { invoiceId: userId, transactionId, referenceId, txAmount } = params;
    const coins = parseInt(txAmount);
    if (!userId || isNaN(coins)) return res.status(400).json({ success: false, message: 'Invalid data' });

    const userRef = db.collection('users').doc(userId);
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const payment = {
        amount: coins,
        coins,
        transactionId,
        reference: referenceId,
        status: 'success',
        gateway: 'waafi',
        timestamp: new Date(),
      };
      if (!snap.exists) {
        t.set(userRef, {
          uid: userId,
          coins,
          paymentHistory: [payment],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        t.update(userRef, {
          coins: (snap.data().coins || 0) + coins,
          paymentHistory: admin.firestore.FieldValue.arrayUnion(payment),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
    res.json({ success: true, message: 'Coins credited' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Callback error' });
  }
});

// ========== PAYSTACK ========== //
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

app.get('/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const verifyRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const tx = verifyRes.data;
    if (!tx.status || tx.data.status !== 'success') return res.status(400).json({ status: false, message: 'Transaction not successful' });

    const { email, metadata, amount } = tx.data;
    if (!metadata?.userId || !metadata.coins) return res.status(200).json({ ...tx, internal_message: 'Missing metadata' });

    const userRef = db.collection('users').doc(metadata.userId);
    const coins = parseInt(metadata.coins);

    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const paymentData = {
        amount: amount / 100,
        coins,
        timestamp: new Date(),
        reference,
        gateway: 'paystack',
        status: 'success',
        packageName: metadata.packageName || 'N/A',
      };

      if (!userSnap.exists) {
        t.set(userRef, {
          uid: metadata.userId,
          email: email || metadata.userEmail,
          name: metadata.userName || 'New User',
          coins,
          paymentHistory: [paymentData],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const currentCoins = userSnap.data().coins || 0;
        t.update(userRef, {
          coins: currentCoins + coins,
          paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    res.json({ ...tx, internal_message: 'Coins credited' });
  } catch (e) {
    res.status(500).json({ status: false, message: 'Verification failed', error: e.response?.data || e.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
