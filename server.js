const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

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
    'http://localhost:3000', // Keep if you have other services on 3000
    'http://localhost:9002', // Your Next.js frontend
    'https://checkout.paystack.com'
  ],
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // More specific origin handling for Access-Control-Allow-Origin is generally better if possible
  const allowedOrigins = ['http://localhost:3000', 'http://localhost:9002', 'https://checkout.paystack.com'];
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
  console.log('[Backend /paystack/initialize] Received request:', req.body);
  try {
    const { email, amount, metadata } = req.body;
    if (!email || !amount) {
      console.error('[Backend /paystack/initialize] Missing email or amount.');
      return res.status(400).json({
        status: false,
        message: 'Email and amount are required'
      });
    }

    // Ensure amount is a number
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        console.error('[Backend /paystack/initialize] Invalid amount:', amount);
        return res.status(400).json({ status: false, message: 'Invalid amount specified.' });
    }

    const paystackPayload = {
      email,
      amount: numericAmount * 100, // Convert KES to cents
      currency: 'KES',
      callback_url: `http://localhost:9002/`, // Corrected: Your Next.js frontend URL
      metadata: {
        ...metadata,
        // custom_fields are good for display on Paystack dashboard,
        // ensure your frontend metadata includes userId, coins, packageName if needed here
        // redirect_url is often used by Paystack for specific integrations,
        // but callback_url is the primary one for post-payment redirect.
      }
    };
    console.log('[Backend /paystack/initialize] Sending payload to Paystack:', paystackPayload);


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

    console.log('[Backend /paystack/initialize] Paystack initialization successful:', {
      reference: response.data.data.reference,
      authorization_url: response.data.data.authorization_url,
    });

    res.json(response.data);

  } catch (error) {
    console.error('[Backend /paystack/initialize] Payment initialization error:', error.response?.data || error.message);
    if (error.response) {
        console.error('[Backend /paystack/initialize] Paystack Error Details:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({
      status: false,
      message: 'Could not initialize payment',
      error: error.response?.data || error.message
    });
  }
});

// Verify transaction by reference
app.get('/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  console.log(`[Backend /paystack/verify] Verifying transaction for reference: ${reference}`);
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, // Use the same secret key
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('[Backend /paystack/verify] Paystack verification API response status:', response.status);
    // console.log('[Backend /paystack/verify] Paystack verification API response data:', JSON.stringify(response.data, null, 2));


    if (response.data.status && response.data.data.status === 'success') {
      const transactionData = response.data.data;
      const { email, metadata, amount: paystackAmount } = transactionData; // amount from Paystack is in kobo/cents
      
      // Ensure metadata exists and contains userId and coins
      if (!metadata || !metadata.userId || metadata.coins == null) {
          console.error(`[Backend /paystack/verify] CRITICAL: Missing userId or coins in metadata for reference ${reference}. Metadata:`, metadata);
          // Respond success to Paystack as payment was good, but log failure to credit.
          return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but metadata issue prevented crediting coins. Contact support.' });
      }

      const userId = metadata.userId;
      const coinsToAdd = Number(metadata.coins); // Ensure it's a number

      if (isNaN(coinsToAdd) || coinsToAdd <= 0) {
        console.error(`[Backend /paystack/verify] CRITICAL: Invalid coinsToAdd value in metadata for reference ${reference}. Value: ${metadata.coins}`);
        return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but coin metadata invalid. Contact support.' });
      }

      const userRef = db.collection('users').doc(userId);
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const paymentData = {
          amount: paystackAmount / 100, // Convert back to KES from kobo/cents
          coins: coinsToAdd,
 timestamp: new Date(),
          reference: reference,
          gateway: 'paystack',
          status: 'success',
          packageName: metadata.packageName || 'N/A',
          gatewayResponseSummary: { // Add more details from Paystack if needed
            ip_address: transactionData.ip_address,
            currency: transactionData.currency,
            channel: transactionData.channel,
            card_type: transactionData.authorization?.card_type,
            bank: transactionData.authorization?.bank,
          }
        };

        if (!userDoc.exists) {
          console.log(`[Backend /paystack/verify] User ${userId} not found. Creating new document.`);
          transaction.set(userRef, {
            uid: userId, // Ensure uid is set as it's often the primary key
            email: email || metadata.userEmail || 'N/A', // Get email from Paystack or metadata
            name: metadata.userName || 'New User',
            photoURL: metadata.userPhotoURL || null,
            coins: coinsToAdd,
            paymentHistory: [paymentData],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLogin: admin.firestore.FieldValue.serverTimestamp(),
            // Add other default fields from your userManagement.js if creating user here
            profileComplete: false,
            isAdmin: false,
            freeContentConsumedCount: 0,
            consumedContentIds: [],
            likedContentIds: [],
            savedContentIds: [],
            preferredCategories: [],
          });
        } else {
          console.log(`[Backend /paystack/verify] User ${userId} found. Updating balance.`);
          const currentCoins = userDoc.data().coins || 0;
          transaction.update(userRef, {
            coins: currentCoins + coinsToAdd,
            paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });

      console.log('[Backend /paystack/verify] Payment verified and user balance updated:', {
        reference,
        userId,
        coinsAdded: coinsToAdd
      });
      // Send back the original Paystack response, potentially augmented
      return res.json({ ...response.data, internal_message: 'Payment verified and coins credited.' });
    } else {
      console.warn(`[Backend /paystack/verify] Paystack verification failed or payment not successful for reference ${reference}. Message: ${response.data.message}`);
      return res.json(response.data); // Send Paystack's response back to client
    }

  } catch (error) {
    console.error('[Backend /paystack/verify] Verification error:', error.response?.data || error.message);
    if (error.response) {
        console.error('[Backend /paystack/verify] Paystack Error Details:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({
      status: false,
      message: 'Could not verify payment',
      error: error.response?.data || error.message
    });
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
app.post('/waafi/initiate', async (req, res) => {
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
