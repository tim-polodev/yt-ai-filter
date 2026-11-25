(() => {
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-video-with-context-renderer',
    'ytm-rich-item-renderer'
  ].join(', ');

  const TITLE_SELECTORS = [
    '#video-title',
    '#video-title-link',
    'a.yt-lockup-metadata-view-model__title',
    '.yt-lockup-metadata-view-model__title',
    'a.yt-lockup-metadata-view-model-wiz__title',
    '.yt-lockup-metadata-view-model-wiz__title',
    'h3.yt-lockup-metadata-view-model__heading-reset',
    'h3.yt-lockup-metadata-view-model-wiz__heading-reset',
    '[class*="lockup-metadata-view-model"][class*="title"]',
    '.shortsLockupViewModelHostMetadataTitle',
    '[class*="shortsLockupViewModelHostMetadataTitle"]',
    '.media-item-headline',
    'h3 a',
    'h3'
  ];

  const THUMB_SELECTORS = [
    'ytd-thumbnail',
    'yt-thumbnail-view-model',
    '.shortsLockupViewModelHostThumbnailParent',
    '.media-item-thumbnail-container',
    'a#thumbnail'
  ];

  const SCAN_DEBOUNCE_MS = 150;
  const DOM_BATCH_SIZE = 20;
  const EVAL_BATCH_SIZE = 15;
  const DATA_IMAGE_RE = /^data:image\/(?:gif|png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

  let currentSettings = {
    enabled: true,
    prompt: '',
    threshold: 0.65,
    clickToPeek: true
  };

  let activeBgState = {
    active: false,
    type: 'none',
    rawSrc: '',
    renderSrc: '',
    blobUrl: '',
    fit: 'cover'
  };

  let scanTimer = null;
  let isScanning = false;
  let pendingRescan = false;
  let nextCardId = 1;
  let isContextInvalidated = false;
  let observer = null;

  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    const msg = String(err?.message || err || '');
    return !isExtensionContextValid() || /Extension context invalidated/i.test(msg);
  }

  function handleContextInvalidated() {
    if (isContextInvalidated) return;
    isContextInvalidated = true;
    pendingRescan = false;

    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('yt-navigate-finish', handleYouTubeNavigate);
    window.removeEventListener('yt-page-data-updated', handleYouTubePageDataUpdated);
  }

  function ensureContextValid() {
    if (isContextInvalidated) return false;
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return false;
    }
    return true;
  }

  async function safeSendMessage(message) {
    if (!ensureContextValid()) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        handleContextInvalidated();
        return null;
      }
      throw err;
    }
  }

  function resolveBackgroundConfig(bg) {
    if (!bg || typeof bg !== 'object') {
      return { active: false, type: 'none', rawSrc: '', fit: 'cover' };
    }
    const fit = bg.fit === 'contain' ? 'contain' : 'cover';
    const src = typeof bg.src === 'string' ? bg.src.trim() : '';
    if (!src) {
      return { active: false, type: 'none', rawSrc: '', fit: 'cover' };
    }

    if (bg.type === 'upload') {
      return DATA_IMAGE_RE.test(src)
        ? { active: true, type: 'upload', rawSrc: src, fit }
        : { active: false, type: 'none', rawSrc: '', fit: 'cover' };
    }

    if (bg.type === 'url') {
      try {
        const parsed = new URL(src);
        if (parsed.protocol !== 'https:') {
          return { active: false, type: 'none', rawSrc: '', fit: 'cover' };
        }
        return { active: true, type: 'url', rawSrc: parsed.href, fit };
      } catch {
        return { active: false, type: 'none', rawSrc: '', fit: 'cover' };
      }
    }

    return { active: false, type: 'none', rawSrc: '', fit: 'cover' };
  }

  function dataUrlToBlobUrl(dataUrl) {
    try {
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) return '';
      const header = dataUrl.slice(0, commaIdx);
      const mimeMatch = /^data:(image\/(?:gif|png|jpeg|webp|avif));base64$/.exec(header);
      if (!mimeMatch) return '';

      const binary = atob(dataUrl.slice(commaIdx + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeMatch[1] });
      return URL.createObjectURL(blob);
    } catch {
      return '';
    }
  }

  function syncBadgeBackground(badge, { recoverBroken = false } = {}) {
    if (!badge) return;

    if (!activeBgState.active || !activeBgState.renderSrc) {
      badge.classList.remove('yt-ai-filter-badge--custom-bg');
      badge.querySelector(':scope > .yt-ai-filter-badge__bg')?.remove();
      badge.querySelector(':scope > .yt-ai-filter-badge__scrim')?.remove();
      return;
    }

    badge.classList.add('yt-ai-filter-badge--custom-bg');

    let bgImg = badge.querySelector(':scope > img.yt-ai-filter-badge__bg');
    if (!bgImg) {
      bgImg = document.createElement('img');
      bgImg.className = 'yt-ai-filter-badge__bg';
      bgImg.alt = '';
      bgImg.setAttribute('aria-hidden', 'true');
      bgImg.decoding = 'async';
      bgImg.referrerPolicy = 'no-referrer';
      bgImg.addEventListener('error', () => {
        if (
          activeBgState.type === 'upload' &&
          activeBgState.rawSrc &&
          bgImg.getAttribute('src') !== activeBgState.rawSrc
        ) {
          bgImg.setAttribute('src', activeBgState.rawSrc);
        }
      });
      badge.prepend(bgImg);
    }

    let scrim = badge.querySelector(':scope > .yt-ai-filter-badge__scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'yt-ai-filter-badge__scrim';
      scrim.setAttribute('aria-hidden', 'true');
      bgImg.after(scrim);
    }

    bgImg.classList.toggle('yt-ai-filter-badge__bg--contain', activeBgState.fit === 'contain');

    const currentSrc = bgImg.getAttribute('src') || '';
    if (currentSrc !== activeBgState.renderSrc) {
      bgImg.setAttribute('src', activeBgState.renderSrc);
    } else if (recoverBroken && bgImg.complete && bgImg.naturalWidth === 0) {
      bgImg.removeAttribute('src');
      bgImg.setAttribute('src', activeBgState.renderSrc);
    }
  }

  function syncAllBadgesBackground(options = {}) {
    for (const badge of document.querySelectorAll('.yt-ai-filter-badge')) {
      syncBadgeBackground(badge, options);
    }
  }

  function applyCustomBackground(bg, options = {}) {
    const root = document.documentElement;
    if (root) {
      root.classList.remove('yt-ai-filter-has-custom-bg');
      root.style.removeProperty('--yt-ai-filter-bg-image');
      root.style.removeProperty('--yt-ai-filter-bg-fit');
    }

    const next = resolveBackgroundConfig(bg);

    if (
      next.active === activeBgState.active &&
      next.type === activeBgState.type &&
      next.rawSrc === activeBgState.rawSrc
    ) {
      activeBgState.fit = next.fit;
      if (options.recoverBroken && activeBgState.type === 'upload' && activeBgState.rawSrc) {
        const hasBroken = Array.from(
          document.querySelectorAll('.yt-ai-filter-badge > img.yt-ai-filter-badge__bg')
        ).some((img) => img.complete && img.naturalWidth === 0);
        if (hasBroken) {
          const oldBlobUrl = activeBgState.blobUrl;
          const nextBlobUrl = dataUrlToBlobUrl(activeBgState.rawSrc);
          activeBgState.blobUrl = nextBlobUrl;
          activeBgState.renderSrc = nextBlobUrl || activeBgState.rawSrc;
          syncAllBadgesBackground(options);
          if (oldBlobUrl && oldBlobUrl !== nextBlobUrl) {
            URL.revokeObjectURL(oldBlobUrl);
          }
          return;
        }
      }
      syncAllBadgesBackground(options);
      return;
    }

    const nextBlobUrl = next.type === 'upload' ? dataUrlToBlobUrl(next.rawSrc) : '';
    const nextRenderSrc = next.active ? (nextBlobUrl || next.rawSrc) : '';
    const oldBlobUrl = activeBgState.blobUrl;

    activeBgState = {
      active: next.active,
      type: next.type,
      rawSrc: next.rawSrc,
      renderSrc: nextRenderSrc,
      blobUrl: nextBlobUrl,
      fit: next.fit
    };

    syncAllBadgesBackground(options);

    if (oldBlobUrl && oldBlobUrl !== nextBlobUrl) {
      URL.revokeObjectURL(oldBlobUrl);
    }
  }

  async function loadCustomBackground(options = {}) {
    if (!ensureContextValid()) return;
    try {
      const { customBackground } = await chrome.storage.local.get('customBackground');
      if (!isContextInvalidated) {
        applyCustomBackground(customBackground, options);
      }
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        handleContextInvalidated();
      }
      // Ignore transient storage errors
    }
  }

  function getVideoCards() {
    const candidates = Array.from(document.querySelectorAll(CARD_SELECTOR));
    return candidates.filter((el) => {
      const parentCard = el.parentElement?.closest(CARD_SELECTOR);
      return !parentCard;
    });
  }

  function findTitleElements(card) {
    const matched = new Set();
    for (const sel of TITLE_SELECTORS) {
      const nodes = card.querySelectorAll(sel);
      for (const el of nodes) {
        const text = (el.textContent || el.getAttribute('title') || '').trim();
        if (!text) continue;
        matched.add(el);
        const heading = el.closest('h3');
        if (heading && card.contains(heading)) {
          matched.add(heading);
        }
      }
    }
    return Array.from(matched);
  }

  function extractTitle(card) {
    for (const sel of TITLE_SELECTORS) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const text = (el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
      if (text) return text;
    }
    return '';
  }

  function markTitleElements(card) {
    for (const el of findTitleElements(card)) {
      el.classList.add('yt-ai-filter-title-target');
    }
  }

  function unmarkTitleElements(card) {
    for (const el of card.querySelectorAll('.yt-ai-filter-title-target')) {
      el.classList.remove('yt-ai-filter-title-target');
    }
  }

  function findThumbHost(card) {
    for (const sel of THUMB_SELECTORS) {
      const el = card.querySelector(sel);
      if (el) return el;
    }
    return card;
  }

  function formatPromptReason(prompt) {
    const clean = String(prompt || '').trim();
    if (!clean) return 'Matches filter rule';
    return clean.length > 72 ? `Rule: ${clean.slice(0, 69)}...` : `Rule: ${clean}`;
  }

  function ensureCardBadge(card, noul, reason, peeked) {
    const thumbHost = findThumbHost(card);
    if (!thumbHost) return;

    thumbHost.classList.add('yt-ai-filter-thumb-host');
    let badge = thumbHost.querySelector(':scope > .yt-ai-filter-badge');

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'yt-ai-filter-badge';
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');

      const pill = document.createElement('span');
      pill.className = 'yt-ai-filter-badge__pill';

      const reasonEl = document.createElement('span');
      reasonEl.className = 'yt-ai-filter-badge__reason';

      const peekEl = document.createElement('span');
      peekEl.className = 'yt-ai-filter-badge__peek';

      badge.append(pill, reasonEl, peekEl);

      const togglePeek = (e) => {
        if (!currentSettings.clickToPeek) return;
        e.preventDefault();
        e.stopPropagation();
        const isNowPeeked = card.classList.toggle('yt-ai-filter-peeked');
        card.dataset.ytAiPeeked = isNowPeeked ? '1' : '0';
        if (isNowPeeked) {
          document.body.classList.remove('yt-ai-filter-hovering-blurred');
        }
        ensureCardBadge(card, Number(card.dataset.ytAiNoul || 0), card.dataset.ytAiReason || '', isNowPeeked);
      };

      badge.addEventListener('click', togglePeek);
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          togglePeek(e);
        }
      });

      thumbHost.appendChild(badge);
    }

    const pct = Math.round(noul * 100);
    const noulFixed = noul.toFixed(2);
    const pill = badge.querySelector('.yt-ai-filter-badge__pill');
    const reasonEl = badge.querySelector('.yt-ai-filter-badge__reason');
    const peekEl = badge.querySelector('.yt-ai-filter-badge__peek');

    if (peeked) {
      pill.textContent = `Jev ${pct}% (noul ${noulFixed}) • Hide`;
      badge.setAttribute('aria-label', `Video peeked. Jev probability ${pct} percent. Click to re-blur.`);
    } else {
      pill.textContent = `Filtered • Jev ${pct}% (noul ${noulFixed})`;
      reasonEl.textContent = formatPromptReason(reason);
      peekEl.textContent = currentSettings.clickToPeek ? 'Click to peek' : 'Blurred';
      badge.setAttribute(
        'aria-label',
        `Video blurred. Jev noul probability ${pct} percent. ${formatPromptReason(reason)}. ${currentSettings.clickToPeek ? 'Click to peek.' : ''}`
      );
    }

    syncBadgeBackground(badge);
  }

  function clearCardFilter(card) {
    card.classList.remove('yt-ai-filter-blurred', 'yt-ai-filter-peeked', 'yt-ai-filter-no-peek');
    unmarkTitleElements(card);
    const thumbHost = findThumbHost(card);
    if (thumbHost) {
      const badge = thumbHost.querySelector(':scope > .yt-ai-filter-badge');
      if (badge) badge.remove();
      thumbHost.classList.remove('yt-ai-filter-thumb-host');
    }
  }

  function applyCardVerdict(card, noul, reason) {
    card.dataset.ytAiNoul = String(noul);
    card.dataset.ytAiReason = reason || currentSettings.prompt || '';

    const shouldBlur = currentSettings.enabled && noul >= currentSettings.threshold;
    if (!shouldBlur) {
      clearCardFilter(card);
      return false;
    }

    card.classList.add('yt-ai-filter-blurred');
    card.classList.toggle('yt-ai-filter-no-peek', !currentSettings.clickToPeek);
    markTitleElements(card);
    const peeked = card.dataset.ytAiPeeked === '1';
    card.classList.toggle('yt-ai-filter-peeked', peeked);
    ensureCardBadge(card, noul, card.dataset.ytAiReason, peeked);
    return true;
  }

  async function applyDomUpdatesBatched(updates) {
    for (let i = 0; i < updates.length; i += DOM_BATCH_SIZE) {
      const batch = updates.slice(i, i + DOM_BATCH_SIZE);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          for (const { card, noul, reason } of batch) {
            if (card.isConnected) {
              applyCardVerdict(card, noul, reason);
            }
          }
          resolve();
        });
      });
      if (globalThis.scheduler?.yield) {
        await scheduler.yield();
      }
    }
  }

  async function updateBadgeCount() {
    if (!ensureContextValid()) return;
    const count = document.querySelectorAll('.yt-ai-filter-blurred').length;
    try {
      await safeSendMessage({ type: 'UPDATE_BADGE', count });
    } catch {
      // Ignore transient extension context disconnect
    }
  }

  async function reEvaluateFromLocalScores() {
    const cards = getVideoCards();
    const updates = [];

    for (const card of cards) {
      if (card.dataset.ytAiNoul !== undefined) {
        updates.push({
          card,
          noul: Number(card.dataset.ytAiNoul),
          reason: card.dataset.ytAiReason || currentSettings.prompt
        });
      }
    }

    if (updates.length > 0) {
      await applyDomUpdatesBatched(updates);
    }
    await updateBadgeCount();
  }

  async function scanAndFilter() {
    if (!ensureContextValid()) return;
    if (isScanning) {
      pendingRescan = true;
      return;
    }
    isScanning = true;

    try {
      const stateResp = await safeSendMessage({ type: 'GET_SETTINGS' });
      if (isContextInvalidated) return;
      if (stateResp?.settings) {
        currentSettings = stateResp.settings;
      }

      if (!currentSettings.enabled || !currentSettings.prompt?.trim()) {
        const cards = getVideoCards();
        await applyDomUpdatesBatched(cards.map((card) => ({ card, noul: 0, reason: '' })));
        await updateBadgeCount();
        return;
      }

      const cards = getVideoCards();
      const toEvaluate = [];
      const cardMap = new Map();

      for (const card of cards) {
        const title = extractTitle(card);
        if (!title) continue;

        // Detect YouTube SPA DOM node recycling when title changes
        if (card.dataset.ytAiTitle !== title) {
          card.dataset.ytAiTitle = title;
          delete card.dataset.ytAiNoul;
          delete card.dataset.ytAiPeeked;
          clearCardFilter(card);
        }

        if (card.dataset.ytAiNoul === undefined) {
          const id = `card_${nextCardId++}`;
          cardMap.set(id, card);
          toEvaluate.push({ id, title });
        }
      }

      for (let i = 0; i < toEvaluate.length; i += EVAL_BATCH_SIZE) {
        if (!ensureContextValid()) return;
        const chunk = toEvaluate.slice(i, i + EVAL_BATCH_SIZE);
        const resp = await safeSendMessage({
          type: 'EVALUATE_TITLES',
          items: chunk
        });
        if (isContextInvalidated) return;

        if (resp?.settings) {
          currentSettings = resp.settings;
        }

        const results = resp?.results || {};
        const updates = [];
        for (const item of chunk) {
          const verdict = results[item.id];
          const card = cardMap.get(item.id);
          if (card && verdict && typeof verdict.noul === 'number') {
            updates.push({
              card,
              noul: verdict.noul,
              reason: verdict.reason || currentSettings.prompt
            });
          }
        }

        if (updates.length > 0) {
          await applyDomUpdatesBatched(updates);
          await updateBadgeCount();
        }
      }
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        handleContextInvalidated();
      } else {
        console.warn('[yt-ai-filter] Scan error:', err?.message || err);
      }
    } finally {
      isScanning = false;
      if (pendingRescan && !isContextInvalidated) {
        pendingRescan = false;
        scheduleScan();
      } else {
        pendingRescan = false;
      }
    }
  }

  function scheduleScan() {
    if (!ensureContextValid()) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (!ensureContextValid()) return;
      scanAndFilter();
    }, SCAN_DEBOUNCE_MS);
  }

  function resetAllCardsAndRescan() {
    if (!ensureContextValid()) return;
    for (const card of getVideoCards()) {
      delete card.dataset.ytAiTitle;
      delete card.dataset.ytAiNoul;
      delete card.dataset.ytAiReason;
      delete card.dataset.ytAiPeeked;
      clearCardFilter(card);
    }
    scheduleScan();
  }

  function pausePreviewVideos(card) {
    const videos = [
      ...card.querySelectorAll('video'),
      ...document.querySelectorAll('ytd-video-preview video, #video-preview video')
    ];
    for (const v of videos) {
      try {
        if (!v.paused) v.pause();
      } catch {
        // Ignore media state errors
      }
    }
  }

  function blockHoverPreview(e) {
    if (!currentSettings.enabled) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const card = target.closest('.yt-ai-filter-blurred:not(.yt-ai-filter-peeked)');
    if (!card) return;

    document.body.classList.add('yt-ai-filter-hovering-blurred');
    pausePreviewVideos(card);
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function handleHoverLeave(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const card = target.closest('.yt-ai-filter-blurred:not(.yt-ai-filter-peeked)');
    if (!card) return;
    const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (!next || !card.contains(next)) {
      document.body.classList.remove('yt-ai-filter-hovering-blurred');
    }
  }

  for (const evt of ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove', 'focusin']) {
    document.addEventListener(evt, blockHoverPreview, true);
  }
  for (const evt of ['mouseleave', 'pointerleave']) {
    document.addEventListener(evt, handleHoverLeave, true);
  }

  // Click-to-peek delegation on blurred title or thumbnail links
  document.addEventListener(
    'click',
    (e) => {
      if (!currentSettings.enabled || !currentSettings.clickToPeek) return;
      const card = e.target?.closest?.('.yt-ai-filter-blurred:not(.yt-ai-filter-peeked)');
      if (!card) return;
      if (e.target.closest('.yt-ai-filter-badge')) return;

      const clickedTitleOrThumb = e.target.closest(
        'ytd-thumbnail, yt-thumbnail-view-model, .yt-ai-filter-title-target, #video-title, #video-title-link, a.yt-lockup-metadata-view-model__title'
      );
      if (clickedTitleOrThumb) {
        e.preventDefault();
        e.stopPropagation();
        card.classList.add('yt-ai-filter-peeked');
        card.dataset.ytAiPeeked = '1';
        document.body.classList.remove('yt-ai-filter-hovering-blurred');
        ensureCardBadge(card, Number(card.dataset.ytAiNoul || 0), card.dataset.ytAiReason || '', true);
      }
    },
    true
  );

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      loadCustomBackground({ recoverBroken: true });
    }
  }

  function handleWindowFocus() {
    loadCustomBackground({ recoverBroken: true });
  }

  function handlePageShow(e) {
    if (e.persisted) {
      loadCustomBackground({ recoverBroken: true });
    }
  }

  function handleYouTubeNavigate() {
    loadCustomBackground();
    scheduleScan();
  }

  function handleYouTubePageDataUpdated() {
    loadCustomBackground();
    scheduleScan();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!ensureContextValid()) return false;
    (async () => {
      try {
        if (message?.type === 'SETTINGS_UPDATED') {
          if (message.settings) {
            currentSettings = message.settings;
          }
          await loadCustomBackground();
          await reEvaluateFromLocalScores();
          if (isExtensionContextValid()) sendResponse({ ok: true });
        } else if (message?.type === 'RESCAN_REQUIRED') {
          if (message.settings) {
            currentSettings = message.settings;
          }
          await loadCustomBackground();
          resetAllCardsAndRescan();
          if (isExtensionContextValid()) sendResponse({ ok: true });
        } else {
          if (isExtensionContextValid()) sendResponse({ ok: false });
        }
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          handleContextInvalidated();
        } else if (isExtensionContextValid()) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
      }
    })();
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!ensureContextValid()) return;
    if (areaName === 'local' && changes.customBackground) {
      applyCustomBackground(changes.customBackground.newValue);
    }
  });

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('pageshow', handlePageShow);

  window.addEventListener('pagehide', (e) => {
    if (!e.persisted && activeBgState.blobUrl) {
      URL.revokeObjectURL(activeBgState.blobUrl);
      activeBgState.blobUrl = '';
    }
  });

  observer = new MutationObserver((mutations) => {
    if (!ensureContextValid()) return;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        scheduleScan();
        break;
      }
    }
  });

  if (document.body && ensureContextValid()) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('yt-navigate-finish', handleYouTubeNavigate);
  window.addEventListener('yt-page-data-updated', handleYouTubePageDataUpdated);

  if (ensureContextValid()) {
    loadCustomBackground();
    scheduleScan();
  }
})();
