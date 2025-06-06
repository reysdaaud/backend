const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // For Waafi endpoint

// Load environment variables
dotenv.config();

// Initialize Firebase Admin
try {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      })
    });
    console.log('Firebase Admin initialized successfully');
  }
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:9002',
    'http://localhost:9002/',
    'https://checkout.paystack.com'
  ],
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const allowedOrigins = ['https://dhuux.vercel.app', 'https://checkout.paystack.com'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

// Paystack configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
  console.error('Missing Paystack secret key in environment variables.');
  process.exit(1);
}

// Paystack initialization endpoint
app.post('/paystack/initialize', async (req, res) => {
  try {
    const { email, amount, metadata } = req.body;
    if (!email || !amount) {
      return res.status(400).json({
        status: false,
        message: 'Email and amount are required'
      });
    }
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ status: false, message: 'Invalid amount specified.' });
    }
    const paystackPayload = {
      email,
      amount: numericAmount * 100, // Convert KES to cents
      currency: 'KES',
      callback_url: `https://dhuux.vercel.app/`,
      metadata: { ...metadata }
    };
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      paystackPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      status: false,
      message: 'Could not initialize payment',
      error: error.response?.data || error.message
    });
  }
});

// Paystack verify endpoint
app.get('/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    if (response.data.status && response.data.data.status === 'success') {
      const transactionData = response.data.data;
      const { email, metadata, amount: paystackAmount } = transactionData;
      if (!metadata || !metadata.userId || metadata.coins == null) {
        return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but metadata issue prevented crediting coins. Contact support.' });
      }
      const userId = metadata.userId;
      const coinsToAdd = Number(metadata.coins);
      if (isNaN(coinsToAdd) || coinsToAdd <= 0) {
        return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but coin metadata invalid. Contact support.' });
      }
      const userRef = db.collection('users').doc(userId);
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const paymentData = {
          amount: paystackAmount / 100,
          coins: coinsToAdd,
          timestamp: new Date(),
          reference: reference,
          gateway: 'paystack',
          status: 'success',
          packageName: metadata.packageName || 'N/A',
          gatewayResponseSummary: {
            ip_address: transactionData.ip_address,
            currency: transactionData.currency,
            channel: transactionData.channel,
            card_type: transactionData.authorization?.card_type,
            bank: transactionData.authorization?.bank,
          }
        };
        if (!userDoc.exists) {
          transaction.set(userRef, {
            uid: userId,
            email: email || metadata.userEmail || 'N/A',
            name: metadata.userName || 'New User',
            photoURL: metadata.userPhotoURL || null,
            coins: coinsToAdd,
            paymentHistory: [paymentData],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLogin: admin.firestore.FieldValue.serverTimestamp(),
            profileComplete: false,
            isAdmin: false,
            freeContentConsumedCount: 0,
            consumedContentIds: [],
            likedContentIds: [],
            savedContentIds: [],
            preferredCategories: [],
          });
        } else {
          const currentCoins = userDoc.data().coins || 0;
          transaction.update(userRef, {
            coins: currentCoins + coinsToAdd,
            paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
      return res.json({ ...response.data, internal_message: 'Payment verified and coins credited.' });
    } else {
      return res.json(response.data);
    }
  } catch (error) {
    res.status(500).json({
      status: false,
      message: 'Could not verify payment',
      error: error.response?.data || error.message
    });
  }
});

// Waafi payment initiation endpoint (at /api/waafi/initiate)
app.post('/api/waafi/initiate', async (req, res) => {
  try {
    const waafiPayload = req.body;
    const response = await fetch('https://api.waafipay.net/asm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(waafiPayload),
    });
    const waafiResult = await response.json();
    if (!response.ok || waafiResult.responseCode !== "2001") {
      return res.status(500).json({
        success: false,
        message: waafiResult.responseMsg || 'Failed to initiate payment with Waafi.',
        waafiResult,
      });
    }
    return res.status(200).json({
      success: true,
      message: waafiResult.responseMsg,
      waafiResult,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    status: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log('Environment:', process.env.NODE_ENV);
}).on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
