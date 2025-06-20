const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // For Waafi endpoint
const crypto = require('crypto'); // Required for webhook verification

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
const port = process
.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: [
    'https://www.icasti.com', // Your frontend domain
    'http://icasti.com',     // Your frontend domain (consider removing http if not needed)
    'https://checkout.paystack.com', // Paystack checkout domain
    // Add your Vercel frontend domain here as well
    process.env.FRONTEND_URL, // Assuming you have a FRONTEND_URL env var
    process.env.VERCEL_URL,   // Assuming you have a VERCEL_URL env var (might not include protocol)
     'https://maano-nu.vercel.app' // Add your Vercel domain explicitly if needed
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'], // Include OPTIONS for preflight requests
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Dynamically set Access-Control-Allow-Origin based on request origin
  const allowedOrigins = [
    'https://www.icasti.com',
    'http://icasti.com',
    'https://checkout.paystack.com',
    'https://maano-nu.vercel.app',
     process.env.FRONTEND_URL,
     process.env.VERCEL_URL
  ].filter(Boolean); // Remove null/undefined entries

  const origin = req.headers.origin;
   if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (req.headers.host === `localhost:${port}`) {
     // Allow localhost access for local development
     res.setHeader('Access-Control-Allow-Origin', `http://localhost:${req.headers['x-forwarded-port'] || port}`);
  }


  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
  }

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

// Paystack initialization endpoint - MODIFIED TO ACCEPT CHANNEL
app.post('/paystack/initialize', async (req, res) => {
  try {
    // Added 'channel' to the destructured request body
    const { email, amount, metadata, channel } = req.body;

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
      // Consider making this callback URL dynamic or configurable in environment variables
      callback_url: `${process.env.FRONTEND_URL || process.env.VERCEL_URL || 'https://www.icasti.com/'}/payment/verify`, // Example: Redirect to a verify page on your frontend
      metadata: { ...metadata },
      // --- Add the channels parameter based on the 'channel' from the request ---
      channels: channel ? [channel] : ['card', 'mpesa'] // Use the specified channel or default to both
      // Valid channels according to Paystack docs typically include: 'card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer
'
      // Ensure 'mpesa' is the correct channel name for Paystack's Mpesa option.
    };

    console.log('[API /paystack/initialize] Paystack Payload:', paystackPayload); // Log the payload

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
    console.log('[API /paystack/initialize] Paystack Response:', response.data); // Log the response
    res.json(response.data);

  } catch (error) {
    console.error('[API /paystack/initialize] Error initializing payment:', error.response?.data || error.message); // Log the error
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

    console.log('[API /paystack/verify] Paystack Verification Response:', response.data); // Log the verification response


    if (response.data.status && response.data.data.status === 'success') {
      const transactionData = response.data.data;
      const { email, metadata, amount: paystackAmount, reference: paystackReference } = transactionData; // Get reference from tx data

      if (!metadata || !metadata.userId || metadata.coins == null) {
         console.warn('[API /paystack/verify] Payment verified, but missing or invalid metadata for crediting coins. Tx Ref:', paystackReference, 'Metadata:', metadata);
         // Consider logging this to a database for manual review
        return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but metadata issue prevented crediting coins. Contact support.' });
      }

      const userId = metadata.userId;
      const coinsToAdd = Number(metadata.coins);
      if (isNaN(coinsToAdd) || coinsToAdd <= 0) {
        console.warn('[API /paystack/verify] Payment verified, but coin metadata invalid for crediting coins. Tx Ref:', paystackReference, 'Coins:', metadata.coins);
         // Consider logging this to a database for manual review
        return res.status(200).json({ ...response.data, internal_message: 'Payment verified, but coin metadata invalid. Contact support.' });
      }

      // Check if this reference has already been processed to prevent double crediting
      const transactionAlreadyProcessed = await db.collection('users').doc(userId).collection('paymentHistory').where('reference', '==', paystackReference).limit(1).get();

      if (!transactionAlreadyProcessed.empty) {
         console.warn(`[API /paystack/verify] Transaction reference ${paystackReference} already processed for user ${userId}. Skipping coin credit.`);
         return res.status(200).json({ ...response.data, internal_message: 'Transaction already processed.' });
      }


      const userRef = db.collection('users').doc(userId);

      // Use a transaction for atomic update
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);

        const paymentData = {
          amount: paystackAmount / 100, // Store amount in KES
          coins: coinsToAdd,
          timestamp: admin.firestore.FieldValue.serverTimestamp(), // Use Admin SDK serverTimestamp
          reference: paystackReference, // Use the reference from the verified transaction data
          gateway: 'paystack',
          status: 'success',
          packageName: metadata.packageName || 'N/A',
          gatewayResponseSummary: {
            ip_address: transactionData.ip_address,
            currency: transactionData.currency,
            channel: transactionData.channel,
            card_type: transactionData.authorization?.card_type,
            bank: transactionData.authorization?.bank,
            paystackId: transactionData.id // Store Paystack's internal transaction ID
          }
        };

        if (!userDoc.exists) {
           console.error(`[API /paystack/verify] User document for ${userId} not found during verification processing. Cannot credit coins. Tx Ref: ${paystackReference}`);
           // Decide how to handle this - perhaps create user or just log and notify admin
           throw new Error(`User document not found for userId: ${userId} during verification of ref: ${paystackReference}`); // Throw to roll back transaction
        } else {
          const currentCoins = userDoc.data().coins || 0;
          transaction.update(userRef, {
            coins: currentCoins + coinsToAdd,
            // Add to a subcollection for better querying and prevent large array
            // Alternatively, if paymentHistory as an array is required, keep it.
             paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentData),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
           console.log(`[API /paystack/verify] Firestore updated for user ${userId}. Added ${coinsToAdd} coins. New balance: ${currentCoins + coinsToAdd}. Tx Ref: ${paystackReference}`);
        }
      });

       console.log(`[API /paystack/verify] Payment verified and coins credited for user ${userId}. Tx Ref: ${paystackReference}`);
      return res.json({ ...response.data, internal_message: 'Payment verified and coins credited.' });

    } else {
       console.log('[API /paystack/verify] Payment verification status not success:', response.data.data.status, 'Tx Ref:', reference);
       // Log failed or pending payments if needed
      return res.json(response.data);
    }
  } catch (error) {
     console.error('[API /paystack/verify] Error verifying payment:', error.response?.data || error.message);
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
     // Add logging for the payload being sent to Waafi
    console.log('[API /api/waafi/initiate] Sending payload to Waafi:', waafiPayload);

    const response = await fetch('https://api.waafipay.net/asm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(waafiPayload),
    });
    const waafiResult = await response.json();
    console.log('[API /api/waafi/initiate] Waafi initiation response:', waafiResult); // Log the response

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
    console.error('[API /api/waafi/initiate] Error during payment initiation:', error); // Log the error
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// --- Waafi Callback Endpoint (Using Admin SDK) ---
app.post('/api/waafi/callback', async (req, res) => {
  console.log('[API /api/waafi/callback] Received Waafi callback request.');
  console.log("[API /api/waafi/callback] Request Body:", req.body);
  console.log("[API /api/waafi/callback] Request Headers:", req.headers);

  // --- TODO: Implement Waafi webhook signature/authenticity verification ---
  // Consult Waafi documentation for details on how to verify the request.
  // You MUST implement this to ensure the request is from Waafi.
  // Example (requires 'crypto' module):
  const waafiSignature = req.headers['x-waafi-signature']; // Example header name - ADJUST THIS BASED ON WAAFI DOCS
  const waafiWebhookSecret = process.env.WAAFI_WEBHOOK_SECRET; // Get from environment variables - ENSURE THIS IS SET

  if (!waafiSignature || !waafiWebhookSecret) {
     console.error("[API /api/waafi/callback] Missing signature header or webhook secret.");
     // Return a response code that doesn't cause Waafi to retry infinitely
     return res.status(401).json({ success: false, message: "Unauthorized: Missing signature or server misconfiguration." });
  }

  // Reconstruct the payload string that Waafi signed.
  // Consult Waafi docs precisely how they sign the payload (e.g., raw body, JSON stringified).
  // If Waafi signs the raw body, you'll need middleware like 'body-parser' raw body parser
  // or read the raw body stream before express.json() parses it.
  const payload = JSON.stringify(req.body); // ASSUMPTION: Waafi signs the JSON stringified body - VERIFY WITH DOCS

  try {
      const calculatedSignature = crypto.createHmac('sha256', waafiWebhookSecret)
                                  .update(payload)
                                  .digest('hex');

      if (waafiSignature !== calculatedSignature) {
        console.error("[API /api/waafi/callback] Waafi callback signature mismatch. Calculated:", calculatedSignature, "Received:", waafiSignature);
        return res.status(403).json({ success: false, message: "Forbidden: Invalid signature." });
      }
      console.log("[API /api/waafi/callback] Waafi callback signature verified.");

  } catch (verificationError) {
      console.error("[API /api/waafi/callback] Error during signature verification:", verificationError);
      return res.status(500).json({ success: false, message: "Internal server error during signature verification." });
  }
  // --- End of verification ---


  try {
    // --- Extract data from Waafi webhook (ADJUST BASED ON WAAFI DOCS) ---
    const {
      // Example fields from a hypothetical Waafi callback payload
      status, // e.g., "SUCCESS", "FAILED"
      transactionId, // This should be the referenceId we sent (or Waafi's transaction ID)
      amountPaid, // Amount paid in the target currency (e.g., SOS or USD if currency was USD)
      currency,   // Currency of amountPaid (e.g., "SOS" or "USD")
      msisdn,     // Payer's phone number
      customReference // The JSON stringified metadata we sent
    } = req.body;

    // Ensure essential fields are present (ADJUST FIELD NAMES)
     if (!status || !transactionId || typeof amountPaid === 'undefined' || !currency || !customReference) {
         console.error("[API /api/waafi/callback] Missing essential data in Waafi webhook payload.");
         return res.status(400).json({ success: false, message: "Callback data incomplete." });
     }

    let internalMetadata;
    try {
        internalMetadata = JSON.parse(customReference);
    } catch (parseError) {
        console.error("[API /api/waafi/callback] Error parsing customReference from Waafi callback:", parseError, "Raw customReference:", customReference);
        return res.status(400).json({ success: false, message: "Invalid customReference format." });
    }

    const { userId, coins, originalAmountKES, packageName, internalTxId } = internalMetadata;

    // Validate metadata for processing
    if (!userId || typeof coins === 'undefined' || !internalTxId) {
      console.error("[API /api/waafi/callback] Waafi callback missing critical metadata: userId, coins, or internalTxId.");
      return res.status(400).json({ success: false, message: "Callback metadata incomplete." });
    }

    // It's good to check if Waafi's transactionId matches the internalTxId we sent, for reconciliation.
    if (transactionId && transactionId !== internalTxId) {
        console.warn(`[API /api/waafi/callback] Waafi callback transactionId (${transactionId}) does not match internalTxId (${internalTxId}). Proceeding, but investigate.`);
    }

     // Ensure coinsToAdd is a number
    const coinsToAdd = parseInt(coins, 10);
     if (isNaN(coinsToAdd) || coinsToAdd <= 0) {
       console.error(`[API /api/waafi/callback] CRITICAL: Invalid coins value in metadata for transaction ${internalTxId}. coins:`, coins);
       return res.status(400).json({ success: false, message: "Callback metadata has invalid coins value." });
     }


    // --- Check if the payment was successful (ADJUST STATUS VALUE) ---
    if (status.toUpperCase() === 'SUCCESS') { // ASSUMPTION: SUCCESS indicates a completed payment
      const userRef = db.collection('users').doc(userId);

      // Use a transaction for atomic update
      await db.runTransaction(async (transaction) => {
          const userDoc = await transaction.get(userRef);

          const paymentRecord = {
              method: 'waafi',
              amount: originalAmountKES, // Log KES amount for consistency
              coins: coinsToAdd,
              timestamp: admin.firestore.FieldValue.serverTimestamp(), // Use Admin SDK serverTimestamp
              reference: internalTxId, // Our internal transaction ID
              gatewayTransactionId: req.body.waafiTransactionId || transactionId || 'N/A', // Waafi's specific ID from their payload
              status: 'success',
              packageName: packageName,
              currency: "KES", // Record payment in KES
              gatewayResponseSummary: { // Store some raw Waafi data for reference
                  waafiStatus: status,
                  waafiAmountPaid: amountPaid, // This is the amount in the currency Waafi processed (e.g., USD)
                  waafiCurrency: currency,   // This is the currency Waafi processed (e.g., "USD")
                  waafiMsisdn: msisdn,
                  // Add any other relevant fields from the Waafi payload
              }
          };

          if (!userDoc.exists) {
             // This case should ideally not happen if user is created on signup
             console.error(`[API /api/waafi/callback] User document for ${userId} not found during callback processing. Cannot credit coins.`);
             // Decide how to respond to Waafi here. A 200 might be expected even on internal errors.
             // Returning a specific error status might cause retries from Waafi.
             // For now, let's log and potentially return a 200 with a message indicating the issue.
             throw new Error(`User document not found for userId: ${userId}`); // Throw to roll back transaction and hit catch
          } else {
              const currentCoins = userDoc.data().coins || 0;
              transaction.update(userRef, {
                  coins: currentCoins + coinsToAdd,
                  paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentRecord), // Use Admin SDK arrayUnion
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(), // Use Admin SDK serverTimestamp
              });
              console.log(`[API /api/waafi/callback] Firestore updated for user ${userId}. Added ${coinsToAdd} coins. New balance: ${currentCoins + coinsToAdd}`);
          }
      });

      console.log(`[API /api/waafi/callback] Waafi payment successful for user ${userId}. ${coinsToAdd} coins added.`);
      // Respond to Waafi to acknowledge receipt (usually a 200 OK)
      return res.status(200).json({ success: true, message: "Payment processed successfully." });

    } else {
      console.log(`[API /api/waafi/callback] Waafi payment not successful or status unknown for transaction ${transactionId}. Status: ${status}`);
      // Optionally log failed or pending transactions to a separate collection
      // await db.collection('failed_transactions').add({ ... });

      // Return a 200 OK to Waafi even for non-success if their webhook expects it
      return res.status(200).json({ success: false, message: `Payment status: ${status || 'unknown'}` });
    }

  } catch (error: any) {
    console.error('[API /api/waafi/callback] Error processing Waafi callback:', error);
    // Return a 500 for unexpected internal errors, or a 200 with error message if Waafi expects it.
    // Returning a 500 might cause Waafi to retry the webhook.
    return res.status(500).json({ success: false, message: error.message || 'Internal server error processing Waafi callback.' });
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
