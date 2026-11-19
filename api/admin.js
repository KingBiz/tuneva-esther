
const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const SETTINGS_FILE = "data/admin-settings.json";
const USERS_FILE = "data/users.json";
const PAYMENTS_FILE = "data/payments.json";

const DEFAULT_SETTINGS = {
  activationPrices: [5300, 9300],
  tapPoints: 350,
  tapReward: 100,
  dailyTapLimit: 3000,
  videoReward: 1750
};

function send(res, status, data) {
  return res.status(status).json(data);
}

function getData(result, key) {
  const data = result && result.data;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];

  return [];
}

function validAmount(value, min, max) {
  return (
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validateSettings(body) {
  if (!body || typeof body !== "object") return null;

  const prices = body.activationPrices;

  if (
    !Array.isArray(prices) ||
    prices.length !== 2 ||
    !prices.every(value => validAmount(value, 100, 1000000)) ||
    prices[0] === prices[1]
  ) {
    return null;
  }

  if (!validAmount(body.tapPoints, 1, 1000000)) return null;
  if (!validAmount(body.tapReward, 1, 1000000)) return null;
  if (!validAmount(body.dailyTapLimit, 1, 100000000)) return null;
  if (!validAmount(body.videoReward, 1, 1000000)) return null;

  return {
    activationPrices: prices,
    tapPoints: body.tapPoints,
    tapReward: body.tapReward,
    dailyTapLimit: body.dailyTapLimit,
    videoReward: body.videoReward
  };
}

function findPaymentForUser(user, payments) {
  const paymentId = String(
    user.paymentId || user.paymentID || ""
  );

  const reference = String(
    user.paymentReference || user.reference || ""
  );

  return payments.find(payment => {
    if (
      String(payment.status || "").toLowerCase() !== "approved" ||
      payment.activation !== true
    ) {
      return false;
    }

    if (
      paymentId &&
      String(payment.id || "") === paymentId
    ) {
      return true;
    }

    if (
      reference &&
      String(payment.reference || "") === reference
    ) {
      return true;
    }

    return (
      String(payment.username || "").toLowerCase() ===
        String(user.username || "").toLowerCase() &&
      String(payment.email || "").toLowerCase() ===
        String(user.email || "").toLowerCase()
    );
  });
}

module.exports = async function handler(req, res) {
  const allowedOrigin =
    process.env.TUNEVA_ADMIN_ORIGIN ||
    process.env.TUNEVA_FRONTEND_ORIGIN;

  const origin = req.headers.origin;

  if (allowedOrigin && origin && origin !== allowedOrigin) {
    return send(res, 403, {
      ok: false,
      message: "Origin not allowed."
    });
  }

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowedOrigin || "*"
  );

  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");

    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    if (req.method === "GET") {
      const [
        settingsResult,
        usersResult,
        paymentsResult
      ] = await Promise.all([
        readJSON(SETTINGS_FILE, DEFAULT_SETTINGS),
        readJSON(USERS_FILE, { users: [] }),
        readJSON(PAYMENTS_FILE, { payments: [] })
      ]);

      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsResult.data || {})
      };

      const users = getData(usersResult, "users");
      const payments = getData(paymentsResult, "payments");

      const accounts = users
        .filter(user =>
          String(user.status || "").toLowerCase() === "active"
        )
        .map(user => {
          const payment = findPaymentForUser(user, payments);

          return {
            email: user.email || "",
            username: user.username || "",
            status: user.status,
            amountPaid: payment
              ? Number(payment.amount || 0)
              : null
          };
        });

      return send(res, 200, {
        ok: true,
        settings,
        accounts
      });
    }

    const settings = validateSettings(req.body);

    if (!settings) {
      return send(res, 400, {
        ok: false,
        message: "Invalid settings. Check the values and try again."
      });
    }

    const stored = await readJSON(
      SETTINGS_FILE,
      DEFAULT_SETTINGS
    );

    await writeJSON(
      SETTINGS_FILE,
      {
        ...DEFAULT_SETTINGS,
        ...(stored.data || {}),
        ...settings,
        updatedAt: new Date().toISOString()
      },
      stored.sha
    );

    return send(res, 200, {
      ok: true,
      message: "Admin settings updated.",
      settings
    });

  } catch (error) {
    console.error("[TUNEVA ADMIN]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to process the admin request."
    });
  }
};
      
