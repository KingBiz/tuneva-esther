
const crypto = require("crypto");

const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const {
  normalizeUsername,
  normalizeEmail,
  validUsername,
  hashPassword
} = require("../lib/auth");

const PAYMENTS_FILE = "data/payments.json";
const USERS_FILE = "data/users.json";

const DEFAULT_ACTIVATION_AMOUNT_KOBO = 530000;

const ALLOWED_ACTIVATION_AMOUNTS_KOBO = [
  530000,
  930000
];

const ACTIVATION_EXPIRY_MINUTES = 50;

function send(res, status, data) {
  return res.status(status).json(data);
}

function makeReference() {
  return (
    "tv_" + Date.now() + "_" +
    crypto.randomBytes(5).toString("hex")
  ).slice(0, 32);
}

function makePaymentId() {
  return "PAY-TUNEVA-" + crypto.randomBytes(12).toString("hex");
}

function makeStatusToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256")
    .update(String(token))
    .digest("hex");
}

function normalizePhone(phone) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("234") && value.length === 13) {
    value = "0" + value.slice(3);
  }

  return value;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      status: false,
      message: "Method not allowed."
    });
  }

  try {
    const secretKey = process.env.MOVANTRA_SECRET_KEY;

    if (!secretKey) {
      return send(res, 500, {
        status: false,
        message: "Payment service is not configured."
      });
    }

    const body = req.body || {};

    const customerName = String(
      body.customer_name || body.name || ""
    ).trim();

    const customerEmail = normalizeEmail(
      body.customer_email || body.email
    );

    const customerPhone = String(
      body.customer_phone || body.phone || ""
    ).trim();

    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (!customerName || !customerEmail) {
      return send(res, 400, {
        status: false,
        message: "Name and email are required."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return send(res, 400, {
        status: false,
        message: "Enter a valid email address."
      });
    }

    if (!validUsername(username)) {
      return send(res, 400, {
        status: false,
        message: "Username must be 3–20 characters using letters, numbers or underscores."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return send(res, 400, {
        status: false,
        message: "Password must be at least 8 characters."
      });
    }

    /* =====================================
       ACTIVATION AMOUNT VALIDATION
    ===================================== */

    const suppliedAmount = body.amount_kobo !== undefined
      ? Number(body.amount_kobo)
      : body.amount !== undefined
        ? Math.round(Number(body.amount) * 100)
        : DEFAULT_ACTIVATION_AMOUNT_KOBO;

    if (
      !Number.isSafeInteger(suppliedAmount) ||
      !ALLOWED_ACTIVATION_AMOUNTS_KOBO.includes(suppliedAmount)
    ) {
      return send(res, 400, {
        status: false,
        code: "invalid_activation_amount",
        message: "Choose a valid Tuneva activation price: NGN 5,300 or NGN 9,300."
      });
    }

    const activationAmountKobo = suppliedAmount;

    /* =====================================
       LOAD EXISTING DATA
    ===================================== */

    const [userFile, paymentFile] = await Promise.all([
      readJSON(USERS_FILE, { users: [] }),
      readJSON(PAYMENTS_FILE, { payments: [] })
    ]);

    const users = Array.isArray(userFile.data?.users)
      ? userFile.data.users
      : [];

    const payments = Array.isArray(paymentFile.data?.payments)
      ? paymentFile.data.payments
      : [];

    /* =====================================
       CHECK ACTIVATED ACCOUNTS ONLY

       Pending payment records do not reserve
       usernames, emails or phone numbers.
    ===================================== */

    const customerPhoneNormalized = normalizePhone(customerPhone);

    const existingAccount = users.find(user => {
      const existingUsername = normalizeUsername(user.username);
      const existingEmail = normalizeEmail(user.email);

      const existingPhone = normalizePhone(
        user.phone ||
        user.phoneNumber ||
        user.customerPhone ||
        user.customer_phone
      );

      return (
        existingUsername === username ||
        existingEmail === customerEmail ||
        (
          customerPhoneNormalized &&
          existingPhone &&
          existingPhone === customerPhoneNormalized
        )
      );
    });

    if (existingAccount) {
      return send(res, 409, {
        status: false,
        code: "account_exists",
        message: "An activated account already exists with this username, email or phone number."
      });
    }

    /* =====================================
       HASH PASSWORD
    ===================================== */

    const passwordHash = await hashPassword(password);

    /* =====================================
       CREATE MOVANTRA PAYMENT ACCOUNT
    ===================================== */

    const reference = makeReference();

    const movantraBody = {
      amount_kobo: activationAmountKobo,
      customer_name: customerName,
      customer_email: customerEmail,
      reference,
      expiry_minutes: ACTIVATION_EXPIRY_MINUTES
    };

    if (customerPhone) {
      movantraBody.customer_phone = customerPhone;
    }

    if (process.env.PAGA_CALLBACK_URL) {
      movantraBody.callback_url = process.env.PAGA_CALLBACK_URL;
    }

    const providerResponse = await fetch(
      "https://api.movantrapay.com/v1/paga/dynamic-accounts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(movantraBody)
      }
    );

    let result;

    try {
      result = await providerResponse.json();
    } catch (_) {
      return send(res, 502, {
        status: false,
        message: "Invalid response from payment provider."
      });
    }

    if (!providerResponse.ok || !result || result.status !== true) {
      console.error("[TUNEVA] Movantra account error:", result);

      return send(res, 502, {
        status: false,
        message: result?.message ||
          "Unable to create your payment account."
      });
    }

    if (
      !result.account_number ||
      !result.account_name ||
      !result.bank_name
    ) {
      return send(res, 502, {
        status: false,
        message: "Payment provider returned incomplete account details."
      });
    }

    const providerReference = String(
      result.reference || reference
    ).trim();

    if (!providerReference) {
      return send(res, 502, {
        status: false,
        message: "Invalid payment reference."
      });
    }

    /* =====================================
       CREATE PAYMENT RECORD
    ===================================== */

    const paymentId = makePaymentId();
    const statusToken = makeStatusToken();
    const createdAt = new Date().toISOString();

    const paymentRecord = {
      id: paymentId,
      customerName,
      username,
      email: customerEmail,
      phone: customerPhone,
      passwordHash,

      amount: activationAmountKobo / 100,
      amountKobo: activationAmountKobo,

      method: "paga",
      provider: "movantra",

      reference: providerReference,
      status: "pending",
      statusTokenHash: hashToken(statusToken),

      createdAt,
      processedAt: null,

      activation: true,
      activationExpiresAt:
        result.expires_at ||
        new Date(
          Date.now() +
          ACTIVATION_EXPIRY_MINUTES * 60 * 1000
        ).toISOString(),

      pofPass: null,
      pofGeneratedAt: null,
      pofUsed: false,
      pofUsedAt: null
    };

    if (
      payments.some(item =>
        String(item.reference || "") === providerReference
      )
    ) {
      return send(res, 409, {
        status: false,
        message: "Payment reference already exists."
      });
    }

    /* =====================================
       SAVE PAYMENT
    ===================================== */

    await writeJSON(
      PAYMENTS_FILE,
      {
        ...(paymentFile.data || {}),
        payments: [paymentRecord, ...payments]
      },
      paymentFile.sha
    );

    /* =====================================
       RETURN PAYMENT DETAILS
    ===================================== */

    return send(res, 200, {
      status: true,
      paymentId,
      statusToken,
      reference: providerReference,
      account_number: result.account_number,
      account_name: result.account_name,
      bank_name: result.bank_name,
      amount_kobo: activationAmountKobo,
      fee_kobo: result.fee_kobo ?? null,
      net_kobo: result.net_kobo ?? null,
      status_text: result.status_text || "pending",
      expires_at: paymentRecord.activationExpiresAt,
      mode: result.mode || null
    });

  } catch (error) {
    console.error("[TUNEVA] Payment creation error:", error);

    return send(res, 500, {
      status: false,
      message: "Unable to create your payment account."
    });
  }
};
