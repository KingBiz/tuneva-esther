
const crypto = require("crypto");

const { readJSON } = require("../../lib/github-storage");

function send(res, status, data) {
  return res.status(status).json(data);
}

function createSessionToken(user, secret) {
  const payload = {
    sub: String(user.id),
    v: Number(user.sessionVersion || 1)
  };

  const encodedPayload = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return encodedPayload + "." + signature;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    const { paymentId, statusToken } = req.body || {};

    if (
      typeof paymentId !== "string" ||
      typeof statusToken !== "string" ||
      !paymentId ||
      !/^[a-f0-9]{64}$/i.test(statusToken)
    ) {
      return send(res, 400, { ok: false });
    }

    const stored = await readJSON("data/payments.json", {
      payments: []
    });

    const payments = Array.isArray(stored.data?.payments)
      ? stored.data.payments
      : [];

    const payment = payments.find(
      item => String(item.id || "") === paymentId
    );

    if (
      !payment ||
      !payment.statusTokenHash ||
      payment.activation !== true ||
      String(payment.provider || "").toLowerCase() !== "movantra" ||
      String(payment.method || "").toLowerCase() !== "paga"
    ) {
      return send(res, 404, { ok: false });
    }

    /* VERIFY PAYMENT STATUS TOKEN */

    const submittedHash = crypto
      .createHash("sha256")
      .update(statusToken)
      .digest();

    const savedHash = Buffer.from(
      String(payment.statusTokenHash),
      "hex"
    );

    if (
      savedHash.length !== 32 ||
      !crypto.timingSafeEqual(savedHash, submittedHash)
    ) {
      return send(res, 403, { ok: false });
    }

    const status = String(
      payment.status || "pending"
    ).toLowerCase();

    /* NO LOGIN TOKEN UNTIL PAYMENT IS APPROVED */

    if (status !== "approved") {
      return send(res, 200, {
        ok: true,
        status,
        amount: Number(payment.amount || 0),
        reference: payment.reference || null
      });
    }

    /* VERIFY THAT THE ACCOUNT WAS ACTUALLY CREATED */

    const userFile = await readJSON("data/users.json", {
      users: []
    });

    const users = Array.isArray(userFile.data?.users)
      ? userFile.data.users
      : [];

    const user = users.find(item =>
      String(item.paymentId || "") === paymentId &&
      String(item.status || "").toLowerCase() === "active"
    );

    if (!user) {
      return send(res, 200, {
        ok: true,
        status: "pending",
        activationPending: true,
        amount: Number(payment.amount || 0),
        reference: payment.reference || null
      });
    }

    /* CREATE PERMANENT SIGNED LOGIN TOKEN */

    const sessionSecret = process.env.TUNEVA_SESSION_SECRET;

    if (!sessionSecret || sessionSecret.length < 32) {
      console.error(
        "[TUNEVA SESSION] TUNEVA_SESSION_SECRET is missing or too short."
      );

      return send(res, 500, {
        ok: false,
        message: "Login service is not configured."
      });
    }

    const authToken = createSessionToken(
      user,
      sessionSecret
    );

    return send(res, 200, {
      ok: true,
      status: "approved",
      authenticated: true,
      authToken,

      user: {
        id: user.id,
        fullName: user.fullName || "",
        username: user.username || "",
        email: user.email || "",
        phone: user.phone || "",
        status: user.status
      },

      amount: Number(payment.amount || 0),
      reference: payment.reference || null
    });

  } catch (error) {
    console.error("[TUNEVA PAYMENT STATUS]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to check payment status."
    });
  }
};
