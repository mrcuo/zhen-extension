/**
 * Zhen · 国翻 — Content Script
 *
 * V3 Architecture:
 *  - Chrome Translator API (local AI) for free/basic users
 *  - Google Translate API fallback for unsupported browsers
 *  - LLM proxy (via background.js) for premium users
 *  - Two-stage paywall:
 *      Stage 1 (30 uses): gentle prompt with "try more" option (+20 uses)
 *      Stage 2 (50 uses): final prompt, pay or cancel
 *  - Smart skip: translate="no", contenteditable, decorative fonts
 */

(() => {
  if (window.__zhenInjected) return;
  window.__zhenInjected = true;
  window.__zhenState = 'idle';
  window.__zhenOriginals = new Map();
  window.__zhenMutationObserver = null;
  window.__zhenTranslatedNodes = new WeakSet();
  window.__zhenTranslator = null; // cached Chrome Translator instance

  function updateState(newState) {
    window.__zhenState = newState;
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: newState }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_TRANSLATE') {
      if (window.__zhenState === 'translated' || window.__zhenState === 'translating') {
        restoreOriginals();
      } else {
        translatePage();
      }
      sendResponse({ success: true });
    }
  });

  // ── Configuration ───────────────────────────────────────────────────
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'TD', 'TH',
    'ARTICLE', 'SECTION', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'BLOCKQUOTE',
    'BUTTON', 'FORM', 'FIELDSET', 'FIGCAPTION'
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'SVG', 'MATH', 'CANVAS',
    'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'TEXTAREA', 'INPUT',
    'SELECT', 'KBD', 'VAR', 'SAMP', 'TEMPLATE', 'SLOT', 'DIALOG'
  ]);

  const ICON_CLASSES = ['icon', 'material', 'fa-', 'fas', 'far', 'fab', 'symbol', 'mdi'];
  const ICON_LIGATURES = new Set([
    'mic', 'search', 'menu', 'close', 'settings', 'add', 'add_circle', 'arrow_forward',
    'arrow_back', 'home', 'info', 'check', 'check_circle', 'warning', 'error', 'star',
    'favorite', 'share', 'delete', 'edit', 'person', 'mail', 'phone', 'location_on',
    'expand_more', 'expand_less', 'chevron_right', 'chevron_left', 'more_vert', 'more_horiz'
  ]);

  const SYSTEM_FONTS = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif',
    'ui-serif', 'ui-monospace', 'ui-rounded', 'arial', 'helvetica', 'times', 'times new roman',
    'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'courier', 'courier new', 'microsoft yahei',
    'simhei', 'simsun', 'kaiti', 'fangsong', 'stheiti', 'heiti sc', 'songti sc',
    'pingfang sc', 'pingfang tc', 'hiragino sans gb', 'noto sans', 'noto sans sc',
    'noto sans cjk', 'noto serif', 'noto serif sc', 'noto serif cjk', 'roboto',
    'open sans', 'lato', 'source han sans', 'source han serif', 'wenquanyi',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'ubuntu', 'cantarell', 'inter'
  ]);

  const TRIAL_LIMIT_FIRST = 30;   // First paywall
  const TRIAL_LIMIT_FINAL = 50;   // Final paywall (30 + 20 extended)

  // ── Smart Skip Detection ────────────────────────────────────────────
  function shouldSkipTranslation(element) {
    let el = element;
    while (el && el !== document.body) {
      const translateAttr = el.getAttribute('translate');
      if (translateAttr === 'no' || translateAttr === 'false') return true;
      if (el.translate === false) return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isCustomFontText(element) {
    try {
      const style = window.getComputedStyle(element);
      const fontSize = parseFloat(style.fontSize);
      if (fontSize < 40) return false;
      const fontFamily = style.fontFamily.toLowerCase();
      const fonts = fontFamily.split(',').map(f => f.trim().replace(/["']/g, ''));
      const hasSystemFont = fonts.some(f => SYSTEM_FONTS.has(f));
      if (!hasSystemFont && fonts.length > 0) return true;
    } catch (e) {}
    return false;
  }

  // ── Styles ──────────────────────────────────────────────────────────
  if (!document.getElementById('__zhen-style')) {
    const style = document.createElement('style');
    style.id = '__zhen-style';
    style.textContent = `
      @keyframes __zhen-spin { to { transform: rotate(360deg); } }
      @keyframes __zhen-fadein { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes __zhen-fadeout { from { opacity: 1; } to { opacity: 0; } }
      @keyframes __zhen-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.02); } }

      .__zhen-inline-spinner {
        display: inline-block;
        width: 12px; height: 12px;
        margin-left: 6px;
        border: 2px solid rgba(99,102,241,0.2);
        border-top-color: #6366f1;
        border-radius: 50%;
        animation: __zhen-spin 0.6s linear infinite;
        vertical-align: middle;
      }

      /* ── Paywall Overlay ── */
      .__zhen-paywall-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        animation: __zhen-fadein 0.3s ease-out;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      }
      .__zhen-paywall-card {
        background: #fff; border-radius: 20px;
        padding: 48px 40px; max-width: 420px; width: 90%;
        text-align: center;
        box-shadow: 0 25px 60px rgba(0,0,0,0.3);
      }
      .__zhen-paywall-emoji {
        font-size: 48px; margin-bottom: 16px;
      }
      .__zhen-paywall-title {
        font-size: 22px; font-weight: 700; color: #111;
        margin: 0 0 8px;
      }
      .__zhen-paywall-subtitle {
        font-size: 15px; color: #666;
        margin: 0 0 28px; line-height: 1.6;
      }
      .__zhen-paywall-price {
        font-size: 42px; font-weight: 800; color: #111;
        margin: 0 0 4px;
      }
      .__zhen-paywall-price-note {
        font-size: 13px; color: #999;
        margin: 0 0 24px;
      }
      .__zhen-paywall-qr {
        width: 200px; height: 200px;
        margin: 0 auto 16px;
        background: #f5f5f5; border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        color: #999; font-size: 14px;
      }
      .__zhen-paywall-qr img {
        width: 100%; height: 100%; border-radius: 12px; object-fit: contain;
      }
      .__zhen-paywall-hint {
        font-size: 13px; color: #aaa;
        margin: 0 0 24px;
      }
      .__zhen-paywall-actions {
        display: flex; flex-direction: column; gap: 10px; align-items: center;
      }
      .__zhen-paywall-btn-primary {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff; border: none;
        padding: 12px 32px; border-radius: 12px;
        font-size: 16px; font-weight: 600;
        cursor: pointer; transition: all 0.2s;
        width: 100%; max-width: 280px;
      }
      .__zhen-paywall-btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 16px rgba(99,102,241,0.4);
      }
      .__zhen-paywall-btn-secondary {
        background: #f0f0f5; color: #555; border: none;
        padding: 12px 32px; border-radius: 12px;
        font-size: 15px; font-weight: 500;
        cursor: pointer; transition: all 0.2s;
        width: 100%; max-width: 280px;
      }
      .__zhen-paywall-btn-secondary:hover {
        background: #e8e8f0; color: #333;
      }
      .__zhen-paywall-btn-cancel {
        background: none; border: none;
        font-size: 14px; color: #bbb;
        cursor: pointer; padding: 8px 20px;
        transition: color 0.2s;
      }
      .__zhen-paywall-btn-cancel:hover { color: #666; }

      /* ── QR Payment View (replaces initial card content) ── */
      .__zhen-paywall-qr-view {
        animation: __zhen-fadein 0.3s ease-out;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Chrome Translator API ───────────────────────────────────────────
  async function getTranslator() {
    if (window.__zhenTranslator) return window.__zhenTranslator;

    if (!('translation' in self) && !('translator' in self)) return null;

    try {
      const api = self.translation || self.translator;
      const canTranslate = await api.canTranslate({
        sourceLanguage: 'en',
        targetLanguage: 'zh'
      });

      if (canTranslate === 'no') return null;

      window.__zhenTranslator = await api.create({
        sourceLanguage: 'en',
        targetLanguage: 'zh'
      });
      return window.__zhenTranslator;
    } catch (e) {
      console.warn('[Zhen] Chrome Translator API not available:', e);
      return null;
    }
  }

  async function translateWithChromeAI(texts) {
    const translator = await getTranslator();
    if (!translator) return null; // signal to use fallback

    const results = [];
    for (const text of texts) {
      try {
        results.push(await translator.translate(text));
      } catch (e) {
        results.push(text); // keep original on error
      }
    }
    return results;
  }

  async function translateWithFallback(texts) {
    const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', texts });
    if (!response?.success) throw new Error(response?.error || 'Translation failed');
    return response.translations;
  }

  async function translateTexts(texts, isPremium) {
    if (isPremium) {
      const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH_LLM', texts });
      if (response?.success) return response.translations;
      // Fall through to standard translation if LLM fails
    }

    // Try Chrome AI first
    const chromeResult = await translateWithChromeAI(texts);
    if (chromeResult) return chromeResult;

    // Fallback to Google Translate via background.js
    return translateWithFallback(texts);
  }

  // ── Node Processing ─────────────────────────────────────────────────
  function isIcon(node) {
    const text = node.textContent.trim();
    if (text && text.length < 25 && ICON_LIGATURES.has(text)) return true;

    let el = node.parentElement;
    let depth = 0;
    while (el && el !== document.body && depth < 4) {
      const className = (el.className || '').toString().toLowerCase();
      for (const c of ICON_CLASSES) {
        if (className.includes(c)) return true;
      }
      try {
        const font = window.getComputedStyle(el).fontFamily.toLowerCase();
        if (font.includes('material') || font.includes('icon') || font.includes('fontawesome')) return true;
      } catch (e) {}
      el = el.parentElement;
      depth++;
    }
    return false;
  }

  function isTranslatable(text) {
    const stripped = text.replace(/[\s\d\W]/g, '');
    if (stripped.length < 2) return false;
    const latinCount = (stripped.match(/[a-zA-Z]/g) || []).length;
    const cjkCount = (stripped.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkCount > 0 && cjkCount / stripped.length > 0.3) return false;
    return (latinCount / stripped.length) > 0.4;
  }

  function getBlockAncestor(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function collectAndGroupNodes(root) {
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.classList?.contains('__zhen-inline-spinner')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.__zhen-paywall-overlay, .__zhen-premium-bar')) return NodeFilter.FILTER_REJECT;
        if (shouldSkipTranslation(parent)) return NodeFilter.FILTER_REJECT;
        if (isCustomFontText(parent)) return NodeFilter.FILTER_REJECT;

        if (parent.offsetParent === null && parent.tagName !== 'BODY') {
          try {
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          } catch (e) {}
        }

        if (window.__zhenTranslatedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (isIcon(node)) return NodeFilter.FILTER_REJECT;
        if (!isTranslatable(node.textContent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const block = getBlockAncestor(node);
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }
    return Array.from(groups.values());
  }

  // ── Batching & Translation ──────────────────────────────────────────
  function prepareBatches(groups) {
    const batches = [];
    const BATCH_SIZE = 40;
    for (let i = 0; i < groups.length; i += BATCH_SIZE) {
      const chunk = groups.slice(i, i + BATCH_SIZE);
      const nodes = [];
      for (const group of chunk) nodes.push(...group);
      batches.push(nodes);
    }
    return batches;
  }

  function addSpinners(nodes) {
    const spinners = [];
    const seenBlocks = new Set();
    for (const node of nodes) {
      const block = getBlockAncestor(node);
      if (!seenBlocks.has(block)) {
        seenBlocks.add(block);
        const spinner = document.createElement('span');
        spinner.className = '__zhen-inline-spinner';
        try { block.appendChild(spinner); spinners.push(spinner); } catch (e) {}
      }
    }
    return spinners;
  }

  function removeSpinners(spinners) {
    for (const s of spinners) { if (s.parentNode) s.remove(); }
  }

  async function applyTranslations(nodes, translations) {
    const updates = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const text = node.textContent;
      const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!match) continue;
      const translated = translations[i] || match[2];
      if (!window.__zhenOriginals.has(node)) window.__zhenOriginals.set(node, text);
      window.__zhenTranslatedNodes.add(node);
      updates.push({ node, text: match[1] + translated + match[3] });
    }

    const CHUNK = 40;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK);
      await new Promise(resolve => requestAnimationFrame(() => {
        for (const { node, text } of slice) {
          try { node.textContent = text; } catch (e) {}
        }
        resolve();
      }));
      if (globalThis.scheduler?.yield) await scheduler.yield();
    }
  }

  async function translateBatches(batches, isPremium) {
    const CONCURRENCY = 4;
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < batches.length) {
        const idx = nextIdx++;
        const nodes = batches[idx];
        const texts = nodes.map(n => {
          const m = n.textContent.match(/^(\s*)([\s\S]*?)(\s*)$/);
          return m ? m[2] : n.textContent.trim();
        });

        const spinners = addSpinners(nodes);
        let retries = 2;
        while (retries >= 0) {
          try {
            const translations = await translateTexts(texts, isPremium);
            await applyTranslations(nodes, translations);
            removeSpinners(spinners);
            break;
          } catch (err) {
            retries--;
            if (retries < 0) {
              console.error('[Zhen] Batch failed:', err);
              removeSpinners(spinners);
            } else {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker);
    await Promise.all(workers);
  }

  // ── Paywall: Two-Stage System ───────────────────────────────────────

  /**
   * Cleanup helper: removes overlay and clears polling interval
   */
  function cleanupPaywall() {
    const overlay = document.querySelector('.__zhen-paywall-overlay');
    if (overlay) overlay.remove();
    if (window.__zhenPollInterval) {
      clearInterval(window.__zhenPollInterval);
      window.__zhenPollInterval = null;
    }
  }

  /**
   * Start polling the backend for payment confirmation.
   * Once confirmed, closes overlay and triggers translation.
   */
  function startPaymentPolling() {
    if (window.__zhenPollInterval) clearInterval(window.__zhenPollInterval);
    let pollCount = 0;
    window.__zhenPollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 200) { clearInterval(window.__zhenPollInterval); return; } // ~10 min timeout
      try {
        const result = await chrome.runtime.sendMessage({ type: 'CHECK_ACTIVATION' });
        if (result?.tier === 'basic' || result?.tier === 'premium') {
          cleanupPaywall();
          await chrome.runtime.sendMessage({ type: 'ACTIVATE_TIER', tier: result.tier });
          translatePage(); // auto-translate after payment
        }
      } catch (e) {}
    }, 3000);
  }

  /**
   * Show the QR payment view inside the existing paywall card.
   * Replaces the card's inner content with QR code + polling.
   */
  function showQRPaymentView(card) {
    card.innerHTML = `
      <div class="__zhen-paywall-qr-view">
        <div class="__zhen-paywall-emoji">💳</div>
        <div class="__zhen-paywall-title">Zhen · 国翻</div>
        <div class="__zhen-paywall-price">¥9.9</div>
        <div class="__zhen-paywall-price-note">一次付费，终身使用</div>
        <div class="__zhen-paywall-qr" id="__zhen-qr">
          <span class="__zhen-inline-spinner" style="border-top-color:#999;width:24px;height:24px;"></span>
        </div>
        <div class="__zhen-paywall-hint">微信 / 支付宝扫码 · 支付后自动激活</div>
        <div class="__zhen-paywall-actions">
          <button class="__zhen-paywall-btn-cancel" id="__zhen-qr-cancel">取消</button>
        </div>
      </div>
    `;

    // Fetch QR code from backend
    chrome.runtime.sendMessage({ type: 'GET_USER_STATE' }).then(state => {
      fetch('https://zhen-backend-api.vercel.app/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: state.deviceId, plan: 'basic' })
      }).then(res => res.json()).then(data => {
        const qrEl = document.getElementById('__zhen-qr');
        if (qrEl && data.qrCodeUrl) {
          qrEl.innerHTML = `<img src="${data.qrCodeUrl}" alt="付款二维码">`;
        } else if (qrEl) {
          qrEl.innerText = '生成二维码失败';
        }
      }).catch(() => {
        const qrEl = document.getElementById('__zhen-qr');
        if (qrEl) qrEl.innerText = '网络连接失败';
      });
    });

    // Cancel button
    document.getElementById('__zhen-qr-cancel')?.addEventListener('click', () => {
      cleanupPaywall();
    });

    // Start polling for payment confirmation
    startPaymentPolling();
  }

  /**
   * Stage 1 Paywall — shown at TRIAL_LIMIT_FIRST (30th translation)
   * Three options:
   *  1. "还想再体验体验" → extend trial by 20 more, then translate
   *  2. "值得买断 ¥9.9"  → show QR payment
   *  3. Close (×)        → don't translate
   */
  function showFirstPaywall() {
    if (document.querySelector('.__zhen-paywall-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = '__zhen-paywall-overlay';
    overlay.innerHTML = `
      <div class="__zhen-paywall-card" id="__zhen-paywall-card">
        <div class="__zhen-paywall-emoji">🎉</div>
        <div class="__zhen-paywall-title">Zhen 已陪你翻译了 ${TRIAL_LIMIT_FIRST} 个网页！</div>
        <div class="__zhen-paywall-subtitle">
          看来它对你真的很有帮助～<br>
          只需 <strong style="color:#6366f1;">¥9.9</strong> 即可永久解锁，无限翻译。
        </div>
        <div class="__zhen-paywall-actions">
          <button class="__zhen-paywall-btn-primary" id="__zhen-buy-now">值得买断 ¥9.9</button>
          <button class="__zhen-paywall-btn-secondary" id="__zhen-try-more">🤔 还想再体验体验</button>
          <button class="__zhen-paywall-btn-cancel" id="__zhen-close-first">暂时不用</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // "值得买断" → show QR payment in same card
    document.getElementById('__zhen-buy-now').addEventListener('click', () => {
      const card = document.getElementById('__zhen-paywall-card');
      if (card) showQRPaymentView(card);
    });

    // "还想再体验体验" → extend trial + translate immediately
    document.getElementById('__zhen-try-more').addEventListener('click', async () => {
      overlay.remove();
      await chrome.runtime.sendMessage({ type: 'EXTEND_TRIAL' });
      translatePage(); // immediately translate for the user
    });

    // "暂时不用" → close, don't translate
    document.getElementById('__zhen-close-first').addEventListener('click', () => {
      cleanupPaywall();
    });
  }

  /**
   * Stage 2 Paywall — shown at TRIAL_LIMIT_FINAL (50th translation)
   * Two options:
   *  1. "值得买断 ¥9.9" → show QR payment
   *  2. "取消"          → don't translate
   */
  function showFinalPaywall() {
    if (document.querySelector('.__zhen-paywall-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = '__zhen-paywall-overlay';
    overlay.innerHTML = `
      <div class="__zhen-paywall-card" id="__zhen-paywall-card">
        <div class="__zhen-paywall-emoji">✨</div>
        <div class="__zhen-paywall-title">免费体验已结束</div>
        <div class="__zhen-paywall-subtitle">
          你已经用 Zhen 翻译了 ${TRIAL_LIMIT_FINAL} 个网页，<br>
          相信它已经成为你的得力助手。<br><br>
          <strong style="color:#6366f1;">¥9.9 一次买断，终身无限翻译</strong>
        </div>
        <div class="__zhen-paywall-actions">
          <button class="__zhen-paywall-btn-primary" id="__zhen-buy-final">值得买断 ¥9.9</button>
          <button class="__zhen-paywall-btn-cancel" id="__zhen-cancel-final">取消</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // "值得买断" → show QR payment
    document.getElementById('__zhen-buy-final').addEventListener('click', () => {
      const card = document.getElementById('__zhen-paywall-card');
      if (card) showQRPaymentView(card);
    });

    // "取消" → close, don't translate
    document.getElementById('__zhen-cancel-final').addEventListener('click', () => {
      cleanupPaywall();
    });
  }

  // ── Main Logic ──────────────────────────────────────────────────────
  async function translatePage() {
    if (window.__zhenState === 'translating') return;

    // ── Step 1: Check user state ──
    let userState;
    try {
      userState = await chrome.runtime.sendMessage({ type: 'GET_USER_STATE' });
    } catch (e) {
      userState = { tier: 'free', usageCount: 0, extendedTrial: false };
    }

    // ── Step 2: Paywall check for free users ──
    if (userState.tier === 'free') {
      // Final paywall: used up all extended trial
      if (userState.usageCount >= TRIAL_LIMIT_FINAL) {
        showFinalPaywall();
        return;
      }
      // First paywall: reached initial limit, hasn't extended yet
      if (userState.usageCount >= TRIAL_LIMIT_FIRST && !userState.extendedTrial) {
        showFirstPaywall();
        return;
      }
    }

    // ── Step 3: Translate ──
    updateState('translating');
    const isPremium = userState.tier === 'premium';

    try {
      const groups = collectAndGroupNodes(document.body);
      if (groups.length === 0) { updateState('idle'); return; }

      const viewportGroups = [];
      const offscreenGroups = [];
      const vh = window.innerHeight;

      for (const group of groups) {
        const firstNode = group[0];
        const parent = firstNode.parentElement;
        try {
          const rect = parent.getBoundingClientRect();
          if (rect.top < vh + 500 && rect.bottom > -500) viewportGroups.push(group);
          else offscreenGroups.push(group);
        } catch (e) {
          viewportGroups.push(group);
        }
      }

      const viewportBatches = prepareBatches(viewportGroups);
      const offscreenBatches = prepareBatches(offscreenGroups);

      if (viewportBatches.length > 0) await translateBatches(viewportBatches, isPremium);
      if (offscreenBatches.length > 0) await translateBatches(offscreenBatches, isPremium);

      setupMutationObserver(isPremium);
      updateState('translated');

      // ── Step 4: Increment usage ──
      try {
        await chrome.runtime.sendMessage({ type: 'INCREMENT_USAGE' });
      } catch (e) {}

    } catch (err) {
      console.error('[Zhen]', err);
      updateState('idle');
    }
  }

  function restoreOriginals() {
    if (window.__zhenMutationObserver) {
      window.__zhenMutationObserver.disconnect();
      window.__zhenMutationObserver = null;
    }

    for (const [node, originalText] of window.__zhenOriginals.entries()) {
      try { node.textContent = originalText; } catch (e) {}
    }

    document.querySelectorAll('.__zhen-inline-spinner').forEach(el => el.remove());

    window.__zhenOriginals.clear();
    window.__zhenTranslatedNodes = new WeakSet();
    updateState('idle');
  }

  function setupMutationObserver(isPremium) {
    if (window.__zhenMutationObserver) return;
    let pendingNodes = [];
    let timer = null;

    const processMutations = async () => {
      if (window.__zhenState !== 'translated') return;
      const toProcess = pendingNodes;
      pendingNodes = [];

      const newGroups = [];
      for (const node of toProcess) {
        if (!document.body.contains(node)) continue;
        newGroups.push(...collectAndGroupNodes(node));
      }

      if (newGroups.length > 0) {
        const batches = prepareBatches(newGroups);
        await translateBatches(batches, isPremium);
      }
    };

    window.__zhenMutationObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('__zhen-inline-spinner')) continue;
            if (node.closest?.('.__zhen-paywall-overlay, .__zhen-premium-bar')) continue;
            pendingNodes.push(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            pendingNodes.push(node.parentElement);
          }
        }
      }
      if (pendingNodes.length > 0) {
        clearTimeout(timer);
        timer = setTimeout(processMutations, 1000);
      }
    });

    window.__zhenMutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Auto-start ──────────────────────────────────────────────────────
  if (window.__zhenState === 'idle') {
    translatePage();
  }
})();
