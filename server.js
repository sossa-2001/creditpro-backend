const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_ENV = process.env.FEDAPAY_ENVIRONMENT || 'live';
const FEDAPAY_BASE = FEDAPAY_ENV === 'sandbox'
  ? 'https://sandbox-api.fedapay.com/v1'
  : 'https://api.fedapay.com/v1';
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://creditpro-backend-8qj6.onrender.com/payment-redirect';
const DEEP_LINK = 'creditpro://payment/status';

const COUNTRY_CODES = {
  '237': 'CM', '225': 'CI', '229': 'BJ',
  '221': 'SN', '223': 'ML', '226': 'BF',
  '228': 'TG', '227': 'NE', '224': 'GN',
  '233': 'GH', '234': 'NG',
};

function parsePhone(phone) {
  if (!phone || !phone.startsWith('+')) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;

  for (const [code, country] of Object.entries(COUNTRY_CODES)) {
    if (digits.startsWith(code)) {
      const local = digits.slice(code.length);
      return { number: local, country: country.toLowerCase() };
    }
  }
  return null;
}

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstname: 'Client', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(' '),
  };
}

async function createFedaPayTransaction(data) {
  const response = await axios.post(
    `${FEDAPAY_BASE}/transactions`,
    {
      description: data.description,
      amount: data.amount,
      currency: { iso: 'XOF' },
      callback_url: CALLBACK_URL,
      customer: {
        firstname: data.customer.firstname,
        lastname: data.customer.lastname || undefined,
        phone_number: {
          number: data.customer.phone_number.number,
          country: data.customer.phone_number.country,
        },
        email: data.customer.email || undefined,
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-User-Agent': 'CreditPro/1.0.0',
      },
      timeout: 30000,
    }
  );
  return response.data;
}

async function getPaymentToken(transactionId) {
  const response = await axios.post(
    `${FEDAPAY_BASE}/transactions/${transactionId}/token`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }
  );
  return response.data;
}

// ============= ROUTES =============

// Root
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'CreditPro Backend', environment: FEDAPAY_ENV });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: FEDAPAY_ENV });
});

// Create payment (transaction + token)
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, description, customer_name, customer_phone, customer_email } = req.body;

    if (!amount || !description || !customer_name || !customer_phone) {
      return res.status(400).json({
        success: false,
        message: 'Champs requis manquants : amount, description, customer_name, customer_phone',
      });
    }

    const phone = parsePhone(customer_phone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Numéro de téléphone invalide. Format attendu : +229XXXXXXXX',
      });
    }

    const name = splitName(customer_name);

    console.log('Creating FedaPay transaction...');
    console.log('  amount:', amount);
    console.log('  phone:', JSON.stringify(phone));

    const txnResponse = await createFedaPayTransaction({
      amount: Math.round(amount),
      description,
      customer: {
        firstname: name.firstname,
        lastname: name.lastname,
        phone_number: phone,
        email: customer_email || undefined,
      },
    });

    console.log('FedaPay response:', JSON.stringify(txnResponse));

    // The FedaPay API returns the transaction under the "v1/transaction" key
    const txnWrapper = txnResponse['v1/transaction'];
    const txn = txnWrapper || txnResponse;
    const txnId = txn.id;
    const paymentUrl = txn.payment_url || '';
    console.log('Transaction created, id:', txnId);

    if (!paymentUrl) {
      return res.status(500).json({
        success: false,
        message: 'Impossible de récupérer le lien de paiement',
      });
    }

    console.log('Payment URL:', paymentUrl);

    res.json({
      success: true,
      transaction_id: txnId,
      reference: txn.reference || '',
      payment_url: paymentUrl,
    });

  } catch (error) {
    console.error('create-payment error:');
    if (error.response) {
      console.error('  status:', error.response.status);
      console.error('  data:', JSON.stringify(error.response.data));
      const errData = error.response.data;
      const message = errData?.message || JSON.stringify(errData?.errors) || 'Erreur FedaPay';
      return res.status(error.response.status).json({ success: false, message });
    }
    console.error('  message:', error.message);
    res.status(500).json({ success: false, message: 'Erreur serveur: ' + error.message });
  }
});

// Verify payment status by transaction ID
app.get('/verify-payment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`${FEDAPAY_BASE}/transactions/${id}`, {
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    const txnWrapper = response.data['v1/transaction'];
    const txn = txnWrapper || response.data;

    res.json({
      success: true,
      status: txn.status,
      transaction: {
        id: txn.id,
        status: txn.status,
        reference: txn.reference,
        amount: txn.amount,
      },
    });
  } catch (error) {
    console.error('verify-payment error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Erreur de vérification' });
  }
});

// FedaPay callback redirect — redirects browser back to the app
app.get('/payment-redirect', (req, res) => {
  const status = req.query.status || 'pending';
  const transaction_id = req.query.id || req.query.transaction_id || '';
  const redirectUrl = `${DEEP_LINK}?transaction_id=${transaction_id}&status=${status}`;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Redirection...</title>
      <script>
        window.location.href = "${redirectUrl}";
      </script>
    </head>
    <body>
      <p>Redirection vers CréditPro...</p>
      <a href="${redirectUrl}">Cliquez ici si la redirection ne fonctionne pas</a>
    </body>
    </html>
  `);
});

// Webhook for FedaPay payment notifications
app.post('/fedapay-webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('Webhook reçu:', JSON.stringify(event, null, 2));

    if (event.name === 'transaction.approved') {
      const txn = event.entity;
      console.log('Paiement confirmé - Transaction ID:', txn.id);
      console.log('Montant:', txn.amount, 'Référence:', txn.reference);
      // TODO: stocker dans une base de données (SQLite, etc.)
      // TODO: notifier le client Flutter si connecté
    } else if (event.name === 'transaction.declined') {
      console.log('Paiement refusé:', event.entity?.id);
    } else if (event.name === 'transaction.canceled') {
      console.log('Paiement annulé:', event.entity?.id);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`CreditPro Backend demarre sur le port ${PORT}`);
  console.log(`Environnement FedaPay: ${FEDAPAY_ENV}`);
  console.log(`URL API FedaPay: ${FEDAPAY_BASE}`);
});
