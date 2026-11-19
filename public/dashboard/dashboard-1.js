

(function () {
"use strict";

const dashboard = document.getElementById('tuneva-dashboard');

if (!dashboard || dashboard.dataset.initialized === 'true') return;

dashboard.dataset.initialized = 'true';

const auth = document.getElementById('tuneva-auth');

const API_BASE = 'https://api.tunevaweb.com.ng';
const EARNINGS_API = API_BASE + '/api/earnings';
const LOGOUT_API = API_BASE + '/api/logout';

const SESSION_STORAGE_KEY = 'tuneva_persistent_session';
const EARNINGS_QUEUE_KEY = 'tuneva_pending_earnings_v1';

const BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 100;
const FLUSH_INTERVAL = 15000;

const DEFAULT_TAP_SETTINGS = {
  tapReward: 100,
  tapPoints: 350,
  dailyTapLimit: 3000
};

const themeButton = dashboard.querySelector('#tv-theme-toggle');
const balanceEye = dashboard.querySelector('#tv-balance-eye');
const balanceAmount = dashboard.querySelector('#tv-balance-amount');
const toast = dashboard.querySelector('#tv-dashboard-toast');

const referralLinkElement = dashboard.querySelector('#tv-referral-link');
const copyReferralButton = dashboard.querySelector('#tv-copy-referral');
const copyFeedback = dashboard.querySelector('#tv-copy-feedback');
const referralSeeAll = dashboard.querySelector('#tv-referral-see-all');

const state = {
  referralUsername: '',
  referralUrl: '',
  currentCurrency: 'NGN',
  balanceVisible: true,
  toastTimeout: null,
  earningsLoadPromise: null,
  earningsQueue: Promise.resolve(),
  flushPromise: null,
  flushTimer: null,
  isLoggingOut: false,
  sessionEnded: false,
  tapTodayEarnings: 0,
  pendingEvents: [],
  serverEarnings: null,
  balances: {
    NGN: { amount: 0, symbol: '₦' },
    KWD: { amount: null, symbol: 'KWD ' }
  },
  earnings: {
    NGN: '₦0.00',
    KWD: 'KWD —'
  }
};

// =================================
// PERSISTENT BROWSER TOKEN
// =================================

function getPersistentToken() {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);

    if (!saved) return '';

    const session = JSON.parse(saved);

    return typeof session.token === 'string'
      ? session.token
      : '';

  } catch (error) {
    console.warn('Tuneva browser session could not be read:', error);
    return '';
  }
}

function getAuthHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const token = getPersistentToken();

  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }

  return headers;
}

// =================================
// FORMAT MONEY
// =================================

function formatMoney(amount) {
  return '₦' + (Number(amount) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatBalance(currency) {
  const item = state.balances[currency];

  if (!item || item.amount === null) {
    return 'KWD —';
  }

  return item.symbol + item.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// =================================
// UPDATE DASHBOARD
// =================================

function updateBalance() {
  if (balanceAmount) {
    balanceAmount.textContent = state.balanceVisible
      ? formatBalance(state.currentCurrency)
      : '••••••••••';
  }

  const earningsElement = dashboard.querySelector('#tv-today-earnings');

  if (earningsElement) {
    earningsElement.textContent = state.earnings[state.currentCurrency];
  }
}

// =================================
// TOAST MESSAGE
// =================================

function showToast(message) {
  if (!toast) return;

  clearTimeout(state.toastTimeout);

  toast.textContent = message;
  toast.classList.add('show');

  state.toastTimeout = setTimeout(function () {
    toast.classList.remove('show');
  }, 2800);
}

// =================================
// EVENT IDs
// =================================

function createEventId() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID === 'function'
  ) {
    return window.crypto.randomUUID();
  }

  return 'tv_' + Date.now() + '_' +
    Math.random().toString(36).slice(2);
}

// =================================
// PERSISTENT EARNINGS QUEUE
// =================================

function loadPendingEvents() {
  try {
    const saved = localStorage.getItem(EARNINGS_QUEUE_KEY);

    if (!saved) {
      state.pendingEvents = [];
      return;
    }

    const parsed = JSON.parse(saved);

    state.pendingEvents = Array.isArray(parsed)
      ? parsed.filter(function (event) {
          return (
            event &&
            typeof event.eventId === 'string' &&
            ['tap', 'video'].includes(event.action)
          );
        })
      : [];

  } catch (error) {
    console.warn('Tuneva earnings queue could not be loaded:', error);
    state.pendingEvents = [];
  }
}

function persistPendingEvents() {
  try {
    localStorage.setItem(
      EARNINGS_QUEUE_KEY,
      JSON.stringify(state.pendingEvents)
    );
  } catch (error) {
    console.warn('Tuneva earnings queue could not be saved:', error);
  }
}

function getPendingTapCount() {
  return state.pendingEvents.filter(function (event) {
    return event.action === 'tap';
  }).length;
}

// =================================
// DYNAMIC TAP SETTINGS
// =================================

function getTapSettings(snapshot) {
  const settings = snapshot && snapshot.settings
    ? snapshot.settings
    : {};

  return {
    tapReward:
      Number(settings.tapReward) > 0
        ? Number(settings.tapReward)
        : DEFAULT_TAP_SETTINGS.tapReward,

    tapPoints:
      Number(settings.tapPoints) > 0
        ? Number(settings.tapPoints)
        : DEFAULT_TAP_SETTINGS.tapPoints,

    dailyTapLimit:
      Number(settings.dailyTapLimit) > 0
        ? Number(settings.dailyTapLimit)
        : DEFAULT_TAP_SETTINGS.dailyTapLimit
  };
}

function formatDailyLimit(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG');
}

// =================================
// OPTIMISTIC EARNINGS SNAPSHOT
// =================================

function getOptimisticSnapshot() {
  const base = state.serverEarnings
    ? Object.assign({}, state.serverEarnings)
    : {
        balance: 0,
        todayEarnings: 0,
        tapPoints: 0,
        tapCount: 0,
        tapDailyPoints: 0,
        tapDailyEarnings: 0,
        videoEarnings: 0,
        claimedVideos: [],
        history: [],
        settings: Object.assign({}, DEFAULT_TAP_SETTINGS)
      };

  const tapSettings = getTapSettings(base);

  const tapReward = tapSettings.tapReward;
  const tapPoints = tapSettings.tapPoints;
  const dailyTapLimit = tapSettings.dailyTapLimit;

  const pendingTaps = getPendingTapCount();

  base.balance = Number(base.balance || 0);
  base.todayEarnings = Number(base.todayEarnings || 0);
  base.tapPoints = Number(base.tapPoints || 0);
  base.tapDailyPoints = Number(base.tapDailyPoints || 0);
  base.tapDailyEarnings = Number(base.tapDailyEarnings || 0);

  base.balance += pendingTaps * tapReward;
  base.todayEarnings += pendingTaps * tapReward;
  base.tapPoints += pendingTaps * tapPoints;
  base.tapDailyPoints += pendingTaps * tapPoints;
  base.tapDailyEarnings += pendingTaps * tapReward;

  base.settings = Object.assign(
    {},
    base.settings || {},
    tapSettings
  );

  base.tapLimitReached =
    base.tapDailyEarnings >= dailyTapLimit;

  base.claimedVideos = Array.isArray(base.claimedVideos)
    ? base.claimedVideos.slice()
    : [];

  state.pendingEvents.forEach(function (event) {
    if (
      event.action === 'video' &&
      event.videoId &&
      !base.claimedVideos.includes(event.videoId)
    ) {
      base.claimedVideos.push(event.videoId);
    }
  });

  return base;
}

// =================================
// BACKEND EARNINGS SNAPSHOT
// =================================

function getSnapshot(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return response.earnings ||
    response.data ||
    response.account ||
    response;
}

function applyEarningsSnapshot(response) {
  if (state.sessionEnded || state.isLoggingOut) return;

  const data = getSnapshot(response);

  if (!data) return;

  state.serverEarnings = Object.assign({}, data);

  const optimistic = getOptimisticSnapshot();

  const balance = Number(optimistic.balance);
  const today = Number(optimistic.todayEarnings);

  if (Number.isFinite(balance)) {
    state.balances.NGN.amount = balance;
  }

  if (Number.isFinite(today)) {
    state.tapTodayEarnings = today;
    state.earnings.NGN = formatMoney(today);
  }

  updateBalance();

  window.dispatchEvent(
    new CustomEvent('tuneva:earnings-updated', {
      detail: optimistic
    })
  );
}

// =================================
// LOAD BACKEND EARNINGS
// =================================

async function loadBackendEarnings() {
  if (state.sessionEnded || state.isLoggingOut) return null;

  if (state.earningsLoadPromise) {
    return state.earningsLoadPromise;
  }

  state.earningsLoadPromise = (async function () {
    try {
      const response = await fetch(EARNINGS_API, {
        method: 'GET',
        credentials: 'include',
        headers: getAuthHeaders({
          'Accept': 'application/json'
        })
      });

      const result = await response.json();

      if (!response.ok || result.ok !== true) {
        throw new Error(result.message || 'Could not load earnings.');
      }

      if (!state.sessionEnded && !state.isLoggingOut) {
        applyEarningsSnapshot(result);
      }

      return result;

    } catch (error) {
      console.warn('Tuneva earnings load failed:', error);
      return null;

    } finally {
      state.earningsLoadPromise = null;
    }
  })();

  return state.earningsLoadPromise;
}

// =================================
// SEND BATCH TO BACKEND
// =================================

async function sendBatch(events, keepalive) {
  const response = await fetch(EARNINGS_API, {
    method: 'POST',
    credentials: 'include',
    keepalive: Boolean(keepalive),
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }),
    body: JSON.stringify({
      events: events
    })
  });

  const result = await response.json();

  if (!response.ok || result.ok !== true) {
    throw new Error(result.message || 'Earnings could not be saved.');
  }

  return result;
}

// =================================
// FLUSH PENDING EVENTS
// =================================

async function flushPendingEarnings(options) {
  options = options || {};

  if (
    state.sessionEnded ||
    state.isLoggingOut ||
    !state.pendingEvents.length
  ) {
    return null;
  }

  if (!options.force && navigator.onLine === false) {
    return null;
  }

  if (state.flushPromise) {
    return state.flushPromise;
  }

  state.flushPromise = (async function () {
    try {
      const batch = state.pendingEvents.slice(0, MAX_BATCH_SIZE);

      const result = await sendBatch(batch, options.keepalive);

      const completedIds = new Set(
        batch.map(function (event) {
          return event.eventId;
        })
      );

      state.pendingEvents = state.pendingEvents.filter(function (event) {
        return !completedIds.has(event.eventId);
      });

      persistPendingEvents();

      if (!state.sessionEnded && !state.isLoggingOut) {
        applyEarningsSnapshot(result);
      }

      if (result.rejected > 0 && !options.silent) {
        const snapshot = getSnapshot(result);
        const settings = getTapSettings(snapshot);

        showToast(
          result.limitReached
            ? 'Your daily Tap Tap limit of ' +
              formatDailyLimit(settings.dailyTapLimit) +
              ' has been reached.'
            : 'Some rewards could not be processed.'
        );
      }

      return result;

    } catch (error) {
      console.warn('Tuneva batch submission failed:', error);

      if (!options.silent && !state.sessionEnded && !state.isLoggingOut) {
        showToast('Rewards are saved and will retry automatically.');
      }

      return null;

    } finally {
      state.flushPromise = null;
    }
  })();

  return state.flushPromise;
}

// =================================
// QUEUE A REWARD
// =================================

function addPendingEvent(action, extra) {
  if (state.sessionEnded || state.isLoggingOut) {
    return null;
  }

  if (!['tap', 'video'].includes(action)) {
    return null;
  }

  extra = extra || {};

  if (action === 'video' && extra.videoId) {
    const existing = state.pendingEvents.find(function (event) {
      return (
        event.action === 'video' &&
        event.videoId === extra.videoId
      );
    });

    if (existing) return existing;
  }

  const event = Object.assign({
    eventId: createEventId(),
    action: action,
    createdAt: new Date().toISOString()
  }, action === 'video'
    ? { videoId: String(extra.videoId || '') }
    : {});

  if (action === 'video' && !event.videoId) {
    return null;
  }

  state.pendingEvents.push(event);
  persistPendingEvents();

  applyEarningsSnapshot({
    earnings: state.serverEarnings || getOptimisticSnapshot()
  });

  return event;
}

// =================================
// PUBLIC SAVE METHOD
// =================================

function saveBackendEarning(action, extra) {
  if (state.sessionEnded || state.isLoggingOut) {
    return Promise.resolve(null);
  }

  if (action === 'tap') {
    const snapshot = getOptimisticSnapshot();
    const settings = getTapSettings(snapshot);

    const tapReward = settings.tapReward;
    const dailyTapLimit = settings.dailyTapLimit;

    if (
      Number(snapshot.tapDailyEarnings || 0) + tapReward >
      dailyTapLimit
    ) {
      return Promise.resolve({
        ok: true,
        limitReached: true,
        message:
          'You have reached your daily Tap Tap earnings limit of ' +
          formatDailyLimit(dailyTapLimit) + '.',
        earnings: snapshot
      });
    }

    const event = addPendingEvent('tap');

    if (!event) {
      return Promise.resolve(null);
    }

    if (getPendingTapCount() >= BATCH_SIZE) {
      flushPendingEarnings();
    }

    return Promise.resolve({
      ok: true,
      pending: true,
      earnings: getOptimisticSnapshot()
    });
  }

  if (action === 'video') {
    return (async function () {
      // Submit existing Tap events first.
      if (state.pendingEvents.length) {
        await flushPendingEarnings({ force: true });
      }

      const event = addPendingEvent('video', extra);

      if (!event) return null;

      // Video claims are confirmed individually.
      const result = await flushPendingEarnings({ force: true });

      if (!result) return null;

      const data = getSnapshot(result);

      if (
        data &&
        Array.isArray(data.claimedVideos) &&
        data.claimedVideos.includes(event.videoId)
      ) {
        return result;
      }

      return null;
    })();
  }

  return Promise.resolve(null);
}

// =================================
// AUTOMATIC RETRIES
// =================================

function scheduleFlush() {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
  }

  state.flushTimer = setInterval(function () {
    if (state.pendingEvents.length) {
      flushPendingEarnings({ silent: true });
    }
  }, FLUSH_INTERVAL);
}

window.addEventListener('online', function () {
  flushPendingEarnings({ force: true });
});

document.addEventListener('visibilitychange', function () {
  if (document.hidden && state.pendingEvents.length) {
    flushPendingEarnings({ silent: true });
  }
});

window.addEventListener('pagehide', function () {
  if (state.pendingEvents.length) {
    flushPendingEarnings({
      force: true,
      keepalive: true,
      silent: true
    });
  }
});

// =================================
// TAP EVENT COMPATIBILITY
// =================================

function processTapEarnings(event) {
  const detail = event.detail || {};

  if (!Number(detail.pointsEarned)) return;

  saveBackendEarning('tap');
}

window.addEventListener(
  'tuneva:tap-earned',
  processTapEarnings
);

// =================================
// THEME EVENT CONNECTION
// =================================

function requestTheme(theme) {
  window.dispatchEvent(
    new CustomEvent('tuneva:theme-change', {
      detail: { theme: theme }
    })
  );
}

// =================================
// SHARED DASHBOARD CORE
// =================================

window.TunevaDashboardCore = {
  dashboard: dashboard,
  auth: auth,
  state: state,

  elements: {
    themeButton: themeButton,
    balanceEye: balanceEye,
    referralLinkElement: referralLinkElement,
    copyReferralButton: copyReferralButton,
    copyFeedback: copyFeedback,
    referralSeeAll: referralSeeAll
  },

  updateBalance: updateBalance,
  formatMoney: formatMoney,
  showToast: showToast,
  loadBackendEarnings: loadBackendEarnings,
  saveBackendEarning: saveBackendEarning,
  applyEarningsSnapshot: applyEarningsSnapshot,
  requestTheme: requestTheme,
  getPersistentToken: getPersistentToken,
  flushPendingEarnings: flushPendingEarnings,
  getPendingEvents: function () {
    return state.pendingEvents.slice();
  }
};

// =================================
// PUBLIC EARNINGS METHODS
// =================================

window.TunevaEarnings = {
  load: loadBackendEarnings,
  save: saveBackendEarning,
  apply: applyEarningsSnapshot,
  flush: flushPendingEarnings,
  getPendingEvents: function () {
    return state.pendingEvents.slice();
  }
};

// =================================
// INITIALIZE QUEUE
// =================================

loadPendingEvents();
scheduleFlush();

loadBackendEarnings().then(function () {
  if (state.pendingEvents.length) {
    flushPendingEarnings({ silent: true });
  }
});

})();
