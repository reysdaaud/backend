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

// CORS setup
const allowedOrigins = [
  'http://localhost:9002', // Your local frontend
  'https://backend-aroy.onrender.com', // Your Render backend (for server-to-server, if needed)
  'https://checkout.paystack.com'
];

app.use(express.json());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
      callback_url: `http://localhost:9002/`, // Local frontend for testing
      metadata: {
        ...metadata,
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

// ... (rest of your endpoints remain unchanged)

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
