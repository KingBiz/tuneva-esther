
(function () {
  "use strict";

  const API = "https://api.tunevaweb.com.ng/api/admin";
  const STORAGE_KEY = "tuneva_admin_access";

  const loginScreen = document.getElementById("ta-login");
  const mainScreen = document.getElementById("ta-main");

  const loginForm = document.getElementById("ta-login-form");
  const loginInput = document.getElementById("ta-access-key");
  const loginButton = document.getElementById("ta-login-button");
  const loginMessage = document.getElementById("ta-login-message");

  const settingsForm = document.getElementById("ta-settings-form");
  const settingsButton = document.getElementById("ta-save-settings");
  const settingsMessage = document.getElementById("ta-settings-message");

  const logoutButton = document.getElementById("ta-logout");
  const refreshButton = document.getElementById("ta-refresh");

  const accountsList = document.getElementById("ta-accounts-list");
  const accountCount = document.getElementById("ta-account-count");

  const fields = {
    priceOne: document.getElementById("ta-price-one"),
    priceTwo: document.getElementById("ta-price-two"),
    tapPoints: document.getElementById("ta-tap-points"),
    tapReward: document.getElementById("ta-tap-reward"),
    dailyLimit: document.getElementById("ta-daily-limit"),
    videoReward: document.getElementById("ta-video-reward")
  };

  const DEFAULT_SETTINGS = {
    activationPrices: [5300, 9300],
    tapPoints: 350,
    tapReward: 100,
    dailyTapLimit: 3000,
    videoReward: 1750
  };

  let accessKey = "";
  let requestInProgress = false;

  function setMessage(element, message, type) {
    if (!element) return;

    element.textContent = message || "";
    element.classList.remove("success", "error");

    if (type) {
      element.classList.add(type);
    }
  }

  function getHeaders(extra) {
    return Object.assign({
      Authorization: "Bearer " + accessKey,
      Accept: "application/json"
    }, extra || {});
  }

  async function apiRequest(method, body) {
    const response = await fetch(API, {
      method: method,
      headers: getHeaders(
        body ? { "Content-Type": "application/json" } : {}
      ),
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined
    });

    let result;

    try {
      result = await response.json();
    } catch (_) {
      throw new Error("Invalid response from the admin server.");
    }

    if (response.status === 401 || response.status === 403) {
      clearAccess();
      showLogin();
      throw new Error("Admin access expired or was denied. Enter your access code again.");
    }

    if (!response.ok || !result || result.ok !== true) {
      throw new Error(
        result?.message || "The admin request could not be completed."
      );
    }

    return result;
  }

  function saveAccess(key) {
    accessKey = key;

    try {
      sessionStorage.setItem(STORAGE_KEY, key);
    } catch (_) {
      // The current page session can still use the key.
    }
  }

  function clearAccess() {
    accessKey = "";

    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function showLogin() {
    loginScreen.hidden = false;
    mainScreen.hidden = true;
  }

  function showDashboard() {
    loginScreen.hidden = true;
    mainScreen.hidden = false;
  }

  function validNumber(value, minimum, maximum) {
    const number = Number(value);

    return (
      Number.isSafeInteger(number) &&
      number >= minimum &&
      number <= maximum
    );
  }

  function populateSettings(settings) {
    const prices = Array.isArray(settings.activationPrices)
      ? settings.activationPrices
      : DEFAULT_SETTINGS.activationPrices;

    fields.priceOne.value = prices[0];
    fields.priceTwo.value = prices[1];

    fields.tapPoints.value =
      settings.tapPoints ?? DEFAULT_SETTINGS.tapPoints;

    fields.tapReward.value =
      settings.tapReward ?? DEFAULT_SETTINGS.tapReward;

    fields.dailyLimit.value =
      settings.dailyTapLimit ?? DEFAULT_SETTINGS.dailyTapLimit;

    fields.videoReward.value =
      settings.videoReward ?? DEFAULT_SETTINGS.videoReward;
  }

  function collectSettings() {
    const values = {
      activationPrices: [
        Number(fields.priceOne.value),
        Number(fields.priceTwo.value)
      ],
      tapPoints: Number(fields.tapPoints.value),
      tapReward: Number(fields.tapReward.value),
      dailyTapLimit: Number(fields.dailyLimit.value),
      videoReward: Number(fields.videoReward.value)
    };

    if (
      !validNumber(values.activationPrices[0], 100, 1000000) ||
      !validNumber(values.activationPrices[1], 100, 1000000)
    ) {
      throw new Error("Enter valid activation fees.");
    }

    if (values.activationPrices[0] === values.activationPrices[1]) {
      throw new Error("The two activation fees must be different.");
    }

    if (!validNumber(values.tapPoints, 1, 1000000)) {
      throw new Error("Enter valid points per Tap.");
    }

    if (!validNumber(values.tapReward, 1, 1000000)) {
      throw new Error("Enter a valid Tap reward.");
    }

    if (!validNumber(values.dailyTapLimit, 1, 100000000)) {
      throw new Error("Enter a valid daily Tap limit.");
    }

    if (!validNumber(values.videoReward, 1, 1000000)) {
      throw new Error("Enter a valid video reward.");
    }

    return values;
  }

  function formatMoney(amount) {
    if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
      return "Unavailable";
    }

    return "₦" + Number(amount).toLocaleString("en-NG");
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);

    return element;
  }

  function renderAccounts(accounts) {
    accountsList.replaceChildren();

    const safeAccounts = Array.isArray(accounts)
      ? accounts
      : [];

    accountCount.textContent = safeAccounts.length.toLocaleString("en-NG");

    if (!safeAccounts.length) {
      accountsList.appendChild(
        createElement("div", "ta-empty", "No active accounts found.")
      );
      return;
    }

    safeAccounts.forEach(function (account) {
      const card = createElement("article", "ta-account");
      const top = createElement("div", "ta-account-top");

      const identity = createElement("div");

      identity.appendChild(
        createElement(
          "div",
          "ta-account-name",
          account.username ? "@" + account.username : "No username"
        )
      );

      identity.appendChild(
        createElement(
          "div",
          "ta-account-email",
          account.email || "No email"
        )
      );

      top.appendChild(identity);

      top.appendChild(
        createElement(
          "span",
          "ta-account-status",
          "ACTIVE"
        )
      );

      const bottom = createElement("div", "ta-account-bottom");

      bottom.appendChild(
        createElement("span", "", "Amount paid")
      );

      bottom.appendChild(
        createElement(
          "strong",
          "",
          formatMoney(account.amountPaid)
        )
      );

      card.appendChild(top);
      card.appendChild(bottom);

      accountsList.appendChild(card);
    });
  }

  async function loadDashboard() {
    if (requestInProgress) return;

    requestInProgress = true;

    if (refreshButton) refreshButton.disabled = true;

    try {
      const result = await apiRequest("GET");

      populateSettings(
        Object.assign({}, DEFAULT_SETTINGS, result.settings || {})
      );

      renderAccounts(result.accounts || []);

      showDashboard();

    } catch (error) {
      setMessage(loginMessage, error.message, "error");

    } finally {
      requestInProgress = false;

      if (refreshButton) refreshButton.disabled = false;
    }
  }

  // ADMIN LOGIN

  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const key = loginInput.value.trim();

    if (!key) {
      setMessage(loginMessage, "Enter your access code.", "error");
      return;
    }

    if (requestInProgress) return;

    requestInProgress = true;
    loginButton.disabled = true;
    loginButton.textContent = "Checking...";

    saveAccess(key);

    try {
      await loadDashboard();

      if (!mainScreen.hidden) {
        loginInput.value = "";
        setMessage(loginMessage, "", "");
      }

    } catch (error) {
      setMessage(loginMessage, error.message, "error");

    } finally {
      requestInProgress = false;
      loginButton.disabled = false;
      loginButton.textContent = "Continue";
    }
  });

  // SAVE SETTINGS

  settingsForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (requestInProgress) return;

    let settings;

    try {
      settings = collectSettings();
    } catch (error) {
      setMessage(settingsMessage, error.message, "error");
      return;
    }

    requestInProgress = true;
    settingsButton.disabled = true;
    settingsButton.textContent = "Saving...";

    setMessage(settingsMessage, "", "");

    try {
      const result = await apiRequest("POST", settings);

      populateSettings(
        Object.assign({}, DEFAULT_SETTINGS, result.settings || settings)
      );

      setMessage(
        settingsMessage,
        "All settings saved successfully.",
        "success"
      );

    } catch (error) {
      setMessage(settingsMessage, error.message, "error");

    } finally {
      requestInProgress = false;
      settingsButton.disabled = false;
      settingsButton.textContent = "Save all settings";
    }
  });

  // REFRESH ACCOUNTS AND SETTINGS

  refreshButton.addEventListener("click", async function () {
    setMessage(settingsMessage, "", "");
    await loadDashboard();
  });

  // LOG OUT

  logoutButton.addEventListener("click", function () {
    clearAccess();
    settingsForm.reset();
    renderAccounts([]);
    accountCount.textContent = "0";
    setMessage(loginMessage, "", "");
    setMessage(settingsMessage, "", "");
    showLogin();
  });

  // RESTORE THIS TAB'S ADMIN SESSION

  try {
    const savedKey = sessionStorage.getItem(STORAGE_KEY);

    if (savedKey) {
      saveAccess(savedKey);
      loadDashboard();
    } else {
      showLogin();
    }
  } catch (_) {
    showLogin();
  }

})();

 
