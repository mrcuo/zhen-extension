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
 *  - Per-URL usage dedup (same page toggles don't count twice)
 *  - Smart skip: translate="no", contenteditable, decorative fonts
 */

(() => {
  if (window.__zhenInjected) return;
  window.__zhenInjected = true;
  window.__zhenState = 'idle';
  window.__zhenOriginals = new Map();
  window.__zhenMutationObserver = null;
  window.__zhenTranslatedNodes = new WeakSet();
  window.__zhenTranslator = null;

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

  // TODO: Restore to 30/50 before production release!
  const TRIAL_LIMIT_FIRST = 2;    // First paywall (production: 30)
  const TRIAL_LIMIT_FINAL = 4;    // Final paywall (production: 50)

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
      @keyframes __zhen-fadein {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes __zhen-overlay-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes __zhen-shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      @keyframes __zhen-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-6px); }
      }
      @keyframes __zhen-pulse-ring {
        0% { transform: scale(0.8); opacity: 0.5; }
        50% { transform: scale(1); opacity: 0.2; }
        100% { transform: scale(1.2); opacity: 0; }
      }

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

      /* ── Premium Paywall Overlay ── */
      .__zhen-paywall-overlay {
        position: fixed; inset: 0;
        background: rgba(15, 15, 25, 0.6);
        backdrop-filter: blur(12px) saturate(1.2);
        -webkit-backdrop-filter: blur(12px) saturate(1.2);
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        animation: __zhen-overlay-in 0.3s ease-out;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
        padding: 20px;
      }

      .__zhen-paywall-card {
        background: linear-gradient(145deg, rgba(255,255,255,0.97), rgba(248,250,252,0.97));
        border: 1px solid rgba(255,255,255,0.3);
        border-radius: 24px;
        padding: 0;
        max-width: 400px; width: 100%;
        text-align: center;
        box-shadow:
          0 0 0 1px rgba(0,0,0,0.04),
          0 8px 16px rgba(0,0,0,0.08),
          0 24px 48px rgba(0,0,0,0.12),
          0 48px 96px rgba(0,0,0,0.08);
        animation: __zhen-fadein 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        overflow: hidden;
      }

      /* Card header band */
      .__zhen-paywall-header {
        background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
        padding: 28px 32px 24px;
        position: relative;
        overflow: hidden;
      }
      .__zhen-paywall-header::before {
        content: '';
        position: absolute; inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
        background-size: 200% 100%;
        animation: __zhen-shimmer 3s ease-in-out infinite;
      }
      .__zhen-paywall-logo {
        width: 56px; height: 56px;
        background: rgba(255,255,255,0.2);
        border-radius: 14px;
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 12px;
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.25);
        animation: __zhen-float 3s ease-in-out infinite;
      }
      .__zhen-paywall-logo img {
        width: 48px; height: 48px;
        border-radius: 10px;
      }
      .__zhen-paywall-brand {
        font-size: 16px; font-weight: 600; color: rgba(255,255,255,0.9);
        letter-spacing: 1px;
        margin: 0;
      }

      /* Card body */
      .__zhen-paywall-body {
        padding: 28px 32px 32px;
      }
      .__zhen-paywall-title {
        font-size: 20px; font-weight: 700;
        color: #1a1a2e;
        margin: 0 0 10px;
        line-height: 1.4;
      }
      .__zhen-paywall-subtitle {
        font-size: 14px; color: #64748b;
        margin: 0 0 24px; line-height: 1.7;
      }
      .__zhen-paywall-subtitle strong {
        color: #6366f1; font-weight: 600;
      }

      /* Price tag */
      .__zhen-paywall-price-tag {
        display: inline-flex; align-items: baseline; gap: 4px;
        margin: 0 0 4px;
      }
      .__zhen-paywall-price-currency {
        font-size: 20px; font-weight: 700; color: #6366f1;
      }
      .__zhen-paywall-price-amount {
        font-size: 48px; font-weight: 800; color: #6366f1;
        line-height: 1;
      }
      .__zhen-paywall-price-note {
        font-size: 12px; color: #94a3b8;
        margin: 0 0 24px;
        letter-spacing: 0.5px;
      }

      /* Buttons */
      .__zhen-paywall-actions {
        display: flex; flex-direction: column; gap: 10px;
        align-items: center;
      }
      .__zhen-paywall-btn-primary {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff; border: none;
        padding: 14px 32px; border-radius: 14px;
        font-size: 16px; font-weight: 600;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        width: 100%;
        position: relative;
        overflow: hidden;
        letter-spacing: 0.3px;
      }
      .__zhen-paywall-btn-primary::before {
        content: '';
        position: absolute; inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
        background-size: 200% 100%;
        animation: __zhen-shimmer 2s ease-in-out infinite;
      }
      .__zhen-paywall-btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(99,102,241,0.4);
      }
      .__zhen-paywall-btn-primary:active {
        transform: translateY(0);
      }
      .__zhen-paywall-btn-secondary {
        background: #f1f5f9; color: #475569; border: none;
        padding: 13px 32px; border-radius: 14px;
        font-size: 15px; font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        width: 100%;
      }
      .__zhen-paywall-btn-secondary:hover {
        background: #e2e8f0; color: #334155;
      }
      .__zhen-paywall-btn-cancel {
        background: none; border: none;
        font-size: 13px; color: #94a3b8;
        cursor: pointer; padding: 8px 20px;
        transition: color 0.2s;
        margin-top: 4px;
      }
      .__zhen-paywall-btn-cancel:hover { color: #64748b; }

      /* Trust badge */
      .__zhen-paywall-trust {
        display: flex; align-items: center; justify-content: center; gap: 16px;
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid #f1f5f9;
      }
      .__zhen-paywall-trust-item {
        display: flex; align-items: center; gap: 4px;
        font-size: 11px; color: #94a3b8;
      }
      .__zhen-paywall-trust-item svg {
        width: 14px; height: 14px; fill: #94a3b8;
      }

      /* ── QR Payment View ── */
      .__zhen-paywall-qr-view {
        animation: __zhen-fadein 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .__zhen-paywall-qr {
        width: 180px; height: 180px;
        margin: 0 auto 12px;
        background: #fff;
        border-radius: 16px;
        display: flex; align-items: center; justify-content: center;
        color: #94a3b8; font-size: 14px;
        border: 2px solid #f1f5f9;
        position: relative;
        overflow: hidden;
      }
      .__zhen-paywall-qr img {
        width: 100%; height: 100%;
        border-radius: 14px;
        object-fit: contain;
        padding: 8px;
      }
      .__zhen-paywall-qr-hint {
        font-size: 13px; color: #94a3b8;
        margin: 0 0 6px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
      }
      .__zhen-paywall-qr-apps {
        font-size: 12px; color: #cbd5e1;
        margin: 0 0 20px;
      }
      .__zhen-paywall-qr-status {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        font-size: 13px; color: #94a3b8;
        margin-bottom: 16px;
      }
      .__zhen-paywall-qr-status .dot {
        width: 8px; height: 8px;
        background: #6366f1;
        border-radius: 50%;
        position: relative;
      }
      .__zhen-paywall-qr-status .dot::after {
        content: '';
        position: absolute; inset: -4px;
        border: 2px solid rgba(99,102,241,0.3);
        border-radius: 50%;
        animation: __zhen-pulse-ring 1.5s ease-out infinite;
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
        sourceLanguage: 'en', targetLanguage: 'zh'
      });
      if (canTranslate === 'no') return null;
      window.__zhenTranslator = await api.create({
        sourceLanguage: 'en', targetLanguage: 'zh'
      });
      return window.__zhenTranslator;
    } catch (e) {
      console.warn('[Zhen] Chrome Translator API not available:', e);
      return null;
    }
  }

  async function translateWithChromeAI(texts) {
    const translator = await getTranslator();
    if (!translator) return null;
    const results = [];
    for (const text of texts) {
      try { results.push(await translator.translate(text)); }
      catch (e) { results.push(text); }
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
    }
    const chromeResult = await translateWithChromeAI(texts);
    if (chromeResult) return chromeResult;
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
      for (const c of ICON_CLASSES) { if (className.includes(c)) return true; }
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
        if (parent.closest('.__zhen-paywall-overlay')) return NodeFilter.FILTER_REJECT;
        if (shouldSkipTranslation(parent)) return NodeFilter.FILTER_REJECT;
        if (isCustomFontText(parent)) return NodeFilter.FILTER_REJECT;
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

  function cleanupPaywall() {
    const overlay = document.querySelector('.__zhen-paywall-overlay');
    if (overlay) overlay.remove();
    if (window.__zhenPollInterval) {
      clearInterval(window.__zhenPollInterval);
      window.__zhenPollInterval = null;
    }
  }

  function startPaymentPolling() {
    if (window.__zhenPollInterval) clearInterval(window.__zhenPollInterval);
    let pollCount = 0;
    window.__zhenPollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 200) { clearInterval(window.__zhenPollInterval); return; }
      try {
        const result = await chrome.runtime.sendMessage({ type: 'CHECK_ACTIVATION' });
        if (result?.tier === 'basic' || result?.tier === 'premium') {
          cleanupPaywall();
          await chrome.runtime.sendMessage({ type: 'ACTIVATE_TIER', tier: result.tier });
          translatePage();
        }
      } catch (e) {}
    }, 3000);
  }

  /**
   * Show QR payment view (replaces card body content)
   */
  function showQRPaymentView(bodyEl) {
    bodyEl.innerHTML = `
      <div class="__zhen-paywall-qr-view">
        <div class="__zhen-paywall-price-tag">
          <span class="__zhen-paywall-price-currency">¥</span>
          <span class="__zhen-paywall-price-amount">9.9</span>
        </div>
        <div class="__zhen-paywall-price-note">一次付费 · 终身使用 · 无限翻译</div>
        <div class="__zhen-paywall-qr" id="__zhen-qr">
          <span class="__zhen-inline-spinner" style="border-top-color:#94a3b8;width:24px;height:24px;border-width:3px;"></span>
        </div>
        <div class="__zhen-paywall-qr-hint">
          📱 打开微信或支付宝扫码支付
        </div>
        <div class="__zhen-paywall-qr-apps">支持微信支付 · 支付宝</div>
        <div class="__zhen-paywall-qr-status">
          <span class="dot"></span>
          等待支付确认中…
        </div>
        <button class="__zhen-paywall-btn-cancel" id="__zhen-qr-cancel">返回</button>
      </div>
    `;

    // Fetch QR code
    chrome.runtime.sendMessage({ type: 'GET_USER_STATE' }).then(state => {
      fetch('https://zhen-backend.vercel.app/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: state.deviceId, plan: 'basic' })
      }).then(res => res.json()).then(data => {
        const qrEl = document.getElementById('__zhen-qr');
        if (qrEl && data.qrCodeUrl) {
          qrEl.innerHTML = `<img src="${data.qrCodeUrl}" alt="付款二维码">`;
        } else if (qrEl) {
          qrEl.innerHTML = '<span style="color:#ef4444;">生成失败，请重试</span>';
        }
      }).catch(() => {
        const qrEl = document.getElementById('__zhen-qr');
        if (qrEl) qrEl.innerHTML = '<span style="color:#ef4444;">网络连接失败</span>';
      });
    });

    document.getElementById('__zhen-qr-cancel')?.addEventListener('click', () => {
      cleanupPaywall();
    });

    startPaymentPolling();
  }

  /**
   * Stage 1 — First paywall (gentle, with "try more" option)
   */
  function showFirstPaywall() {
    if (document.querySelector('.__zhen-paywall-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = '__zhen-paywall-overlay';
    overlay.innerHTML = `
      <div class="__zhen-paywall-card">
        <div class="__zhen-paywall-header">
          <div class="__zhen-paywall-logo"><img src="${chrome.runtime.getURL('icons/logo-48.png')}" alt="Logo"></div>
          <p class="__zhen-paywall-brand">ZHEN · 国翻</p>
        </div>
        <div class="__zhen-paywall-body" id="__zhen-paywall-body">
          <div class="__zhen-paywall-title">🎉 你已翻译了 ${TRIAL_LIMIT_FIRST} 个网页！</div>
          <div class="__zhen-paywall-subtitle">
            看来 Zhen 已经成为你浏览英文世界的好帮手。<br>
            <strong>¥9.9</strong> 即可永久解锁，无限翻译所有网页。
          </div>
          <div class="__zhen-paywall-actions">
            <button class="__zhen-paywall-btn-primary" id="__zhen-buy-now">值得买断 ¥9.9</button>
            <button class="__zhen-paywall-btn-secondary" id="__zhen-try-more">🤔 还想再体验体验</button>
            <button class="__zhen-paywall-btn-cancel" id="__zhen-close-first">暂时不用</button>
          </div>
          <div class="__zhen-paywall-trust">
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
              安全支付
            </span>
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              终身有效
            </span>
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
              无订阅
            </span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('__zhen-buy-now').addEventListener('click', () => {
      const body = document.getElementById('__zhen-paywall-body');
      if (body) showQRPaymentView(body);
    });

    document.getElementById('__zhen-try-more').addEventListener('click', async () => {
      overlay.remove();
      await chrome.runtime.sendMessage({ type: 'EXTEND_TRIAL' });
      translatePage();
    });

    document.getElementById('__zhen-close-first').addEventListener('click', () => {
      cleanupPaywall();
    });
  }

  /**
   * Stage 2 — Final paywall (no more free uses)
   */
  function showFinalPaywall() {
    if (document.querySelector('.__zhen-paywall-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = '__zhen-paywall-overlay';
    overlay.innerHTML = `
      <div class="__zhen-paywall-card">
        <div class="__zhen-paywall-header">
          <div class="__zhen-paywall-logo"><img src="${chrome.runtime.getURL('icons/logo-48.png')}" alt="Logo"></div>
          <p class="__zhen-paywall-brand">ZHEN · 国翻</p>
        </div>
        <div class="__zhen-paywall-body" id="__zhen-paywall-body">
          <div class="__zhen-paywall-title">免费体验已结束</div>
          <div class="__zhen-paywall-subtitle">
            你已经用 Zhen 翻译了 <strong>${TRIAL_LIMIT_FINAL}</strong> 个网页，<br>
            它已经为你消除了大量语言障碍。<br><br>
            <strong>¥9.9 一次买断</strong>，从此无限畅翻所有英文网页。
          </div>
          <div class="__zhen-paywall-price-tag">
            <span class="__zhen-paywall-price-currency">¥</span>
            <span class="__zhen-paywall-price-amount">9.9</span>
          </div>
          <div class="__zhen-paywall-price-note">一次付费 · 终身使用 · 无限翻译</div>
          <div class="__zhen-paywall-actions">
            <button class="__zhen-paywall-btn-primary" id="__zhen-buy-final">立即买断</button>
            <button class="__zhen-paywall-btn-cancel" id="__zhen-cancel-final">取消</button>
          </div>
          <div class="__zhen-paywall-trust">
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
              安全支付
            </span>
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              终身有效
            </span>
            <span class="__zhen-paywall-trust-item">
              <svg viewBox="0 0 24 24"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
              无订阅
            </span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('__zhen-buy-final').addEventListener('click', () => {
      const body = document.getElementById('__zhen-paywall-body');
      if (body) showQRPaymentView(body);
    });

    document.getElementById('__zhen-cancel-final').addEventListener('click', () => {
      cleanupPaywall();
    });
  }

  // ── Main Logic ──────────────────────────────────────────────────────
  async function translatePage() {
    if (window.__zhenState === 'translating') return;

    let userState;
    try {
      userState = await chrome.runtime.sendMessage({ type: 'GET_USER_STATE' });
    } catch (e) {
      userState = { tier: 'free', usageCount: 0, extendedTrial: false };
    }

    // Paywall check for free users
    if (userState.tier === 'free') {
      if (userState.usageCount >= TRIAL_LIMIT_FINAL) {
        showFinalPaywall();
        return;
      }
      if (userState.usageCount >= TRIAL_LIMIT_FIRST && !userState.extendedTrial) {
        showFirstPaywall();
        return;
      }
    }

    // Translate
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

      // Increment usage (with current page URL for dedup)
      try {
        await chrome.runtime.sendMessage({
          type: 'INCREMENT_USAGE',
          url: window.location.href
        });
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
            if (node.closest?.('.__zhen-paywall-overlay')) continue;
            pendingNodes.push(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            pendingNodes.push(node.parentElement);
          }
        }
      }
      if (pendingNodes.length > 0) {
        clearTimeout(timer);
        timer = setTimeout(processMutations, 150);
      }
    });

    window.__zhenMutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Auto-start ──────────────────────────────────────────────────────
  if (window.__zhenState === 'idle') {
    translatePage();
  }
})();
