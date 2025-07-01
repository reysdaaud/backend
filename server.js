// Updated backend with proper Paystack callback_url and unified structure
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

// Load environment variables
dotenv.config();

// Firebase Admin SDK Init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log('Firebase Admin initialized');
}
const db = admin.firestore();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://www.icasti.com', 'https://checkout.paystack.com'],
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
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
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
  console.error('Missing PAYSTACK_SECRET_KEY');
  process.exit(1);
}

app.post('/paystack/initialize', async (req, res) => {
  try {
    const { email, amount, metadata } = req.body;
    if (!email || !amount) return res.status(400).json({ status: false, message: 'Email and amount required' });

    const payload = {
      email,
      amount: Number(amount) * 100,
      currency: 'KES',
      callback_url: `https://www.icasti.com/payment-success?type=paystack`,
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
  console.log(`Server live at http://localhost:${port}`);
  console.log(`Live domain: https://www.icasti.com`);
});
