/**
 * Zhen · 国翻 — Background Service Worker
 *
 * V2 Architecture:
 *  1. User state management (free → basic → premium tiers)
 *  2. Device ID generation & sync
 *  3. Usage counting
 *  4. Action click → toggle translation on active tab
 *  5. Icon switching (ZH / EN)
 *  6. Translation fallback (googleapis) for browsers without Translator API
 *  7. LLM translation proxy (premium tier, via Vercel backend)
 */

// ── Backend Config ───────────────────────────────────────────────────
const BACKEND_URL = 'https://zhen-backend.vercel.app';

// ── User State ───────────────────────────────────────────────────────
const DEFAULT_STATE = {
  deviceId: null,
  tier: 'free',           // 'free' | 'basic' | 'premium'
  usageCount: 0,
  extendedTrial: false    // true after user clicks "还想再体验体验"
};

async function getUserState() {
  try {
    const { zhenState } = await chrome.storage.sync.get('zhenState');
    if (!zhenState || !zhenState.deviceId) {
      const newState = { ...DEFAULT_STATE, deviceId: crypto.randomUUID(), usageCount: 0 };
      await chrome.storage.sync.set({ zhenState: newState });
      return newState;
    }
    return { ...DEFAULT_STATE, ...zhenState };
  } catch (e) {
    console.error('[Zhen] Failed to get state:', e);
    return { ...DEFAULT_STATE, deviceId: crypto.randomUUID() };
  }
}

async function updateUserState(updates) {
  const current = await getUserState();
  const newState = { ...current, ...updates };
  await chrome.storage.sync.set({ zhenState: newState });
  return newState;
}

// ── Translation Cache ────────────────────────────────────────────────
const CACHE_MAX = 2000;

async function getCache() {
  const { translationCache = {} } = await chrome.storage.session.get('translationCache');
  return translationCache;
}

async function setCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    const toRemove = keys.slice(0, keys.length - CACHE_MAX);
    for (const k of toRemove) delete cache[k];
  }
  await chrome.storage.session.set({ translationCache: cache });
}

function cacheKey(text) {
  return `g:${text.trim().substring(0, 200)}`;
}

// ── Action / Shortcut Handlers ───────────────────────────────────────
async function toggleTabTranslation(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
    if (!response) throw new Error('No response');
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
    } catch (injectErr) {
      if (!injectErr.message.includes('chrome://')) {
        console.error('[Zhen] Failed to inject:', injectErr.message);
      }
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) toggleTabTranslation(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'translate-page') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) toggleTabTranslation(tab.id);
  }
});

// ── Message Handler ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── User State Messages ──
  if (message.type === 'GET_USER_STATE') {
    getUserState().then(state => sendResponse(state));
    return true;
  }

  if (message.type === 'INCREMENT_USAGE') {
    (async () => {
      try {
        const pageUrl = message.url || '';
        // Normalize URL: strip hash fragment
        const normalizedUrl = pageUrl.split('#')[0];

        // Check if this URL was already counted in this session
        const { countedUrls = [] } = await chrome.storage.session.get('countedUrls');
        if (normalizedUrl && countedUrls.includes(normalizedUrl)) {
          // Already counted this page, skip increment
          const state = await getUserState();
          sendResponse(state);
          return;
        }

        // New page — increment count and record URL
        const state = await getUserState();
        const newState = await updateUserState({ usageCount: state.usageCount + 1 });
        countedUrls.push(normalizedUrl);
        // Keep only last 500 URLs to avoid bloat
        if (countedUrls.length > 500) countedUrls.splice(0, countedUrls.length - 500);
        await chrome.storage.session.set({ countedUrls });
        sendResponse(newState);
      } catch (e) {
        console.error('[Zhen] INCREMENT_USAGE error:', e);
        sendResponse(await getUserState());
      }
    })();
    return true;
  }

  if (message.type === 'ACTIVATE_TIER') {
    updateUserState({ tier: message.tier }).then(state => sendResponse(state));
    return true;
  }

  if (message.type === 'EXTEND_TRIAL') {
    updateUserState({ extendedTrial: true }).then(state => sendResponse(state));
    return true;
  }

  if (message.type === 'CHECK_ACTIVATION') {
    (async () => {
      try {
        if (!BACKEND_URL) {
          sendResponse({ tier: 'free' });
          return;
        }
        const state = await getUserState();
        const res = await fetch(`${BACKEND_URL}/api/status/${state.deviceId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.tier && data.tier !== state.tier) {
          await updateUserState({ tier: data.tier });
        }
        sendResponse(data);
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // ── Translation Messages ──
  if (message.type === 'TRANSLATE_BATCH') {
    (async () => {
      try {
        const result = await translateBatch(message.texts);
        sendResponse({ success: true, translations: result });
      } catch (err) {
        console.error('[Zhen] Translation error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'TRANSLATE_BATCH_LLM') {
    (async () => {
      try {
        if (!BACKEND_URL) throw new Error('Backend not configured');
        const state = await getUserState();
        const res = await fetch(`${BACKEND_URL}/api/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: state.deviceId, texts: message.texts })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sendResponse({ success: true, translations: data.translations });
      } catch (err) {
        console.error('[Zhen] LLM translation error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Icon State Messages ──
  if (message.type === 'STATE_CHANGED' && sender.tab?.id) {
    const tabId = sender.tab.id;
    const isTranslated = message.state === 'translated' || message.state === 'translating';

    getUserState().then(state => {
      let prefix = '';
      if (state.tier === 'pro' || state.tier === 'basic') prefix = '-pro';
      if (state.tier === 'vip' || state.tier === 'subscription') prefix = '-vip';

      const lang = isTranslated ? 'en' : 'zh';
      
      chrome.action.setIcon({
        tabId,
        path: {
          "16": `icons/${lang}${prefix}-16.png`,
          "48": `icons/${lang}${prefix}-48.png`,
          "128": `icons/${lang}${prefix}-128.png`
        }
      });
      chrome.action.setTitle({
        tabId,
        title: isTranslated ? "恢复原文 (EN)" : "翻译此页 (ZH)"
      });
    });
    return true; // We use async reply or fire-and-forget in this case
  }
});

// ── Google Translate Fallback ────────────────────────────────────────
async function translateBatch(texts) {
  const cache = await getCache();
  const results = new Array(texts.length);
  const uncachedIndices = [];
  const uncachedTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const key = cacheKey(texts[i]);
    if (cache[key]) {
      results[i] = cache[key];
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  if (uncachedTexts.length === 0) return results;

  const translations = await translateWithGoogle(uncachedTexts);

  for (let i = 0; i < uncachedIndices.length; i++) {
    const idx = uncachedIndices[i];
    results[idx] = translations[i];
    cache[cacheKey(texts[idx])] = translations[i];
  }
  await setCache(cache);
  return results;
}

async function translateWithGoogle(texts) {
  if (texts.length === 0) return [];
  if (texts.length === 1) return fallbackConcurrentGoogle(texts);

  try {
    const url = `${BACKEND_URL}/api/google-proxy`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.translations && data.translations.length === texts.length) {
      return data.translations;
    }
    return fallbackConcurrentGoogle(texts);
  } catch (err) {
    return fallbackConcurrentGoogle(texts);
  }
}

async function fallbackConcurrentGoogle(texts) {
  const results = new Array(texts.length);
  const CONCURRENCY = 8;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < texts.length) {
      const idx = nextIdx++;
      const text = texts[idx];
      if (!text.trim()) { results[idx] = text; continue; }

      const url = `${BACKEND_URL}/api/google-proxy`;
      let retries = 2;
      while (retries >= 0) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts: [text] })
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          results[idx] = data.translations[0];
          break;
        } catch (err) {
          retries--;
          if (retries < 0) results[idx] = text;
          else await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker);
  await Promise.all(workers);
  return results;
}
