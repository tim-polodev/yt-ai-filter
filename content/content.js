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

  let currentSettings = {
    enabled: true,
    prompt: '',
    threshold: 0.65,
    clickToPeek: true
  };

  let scanTimer = null;
  let isScanning = false;
  let pendingRescan = false;
  let nextCardId = 1;

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
    const count = document.querySelectorAll('.yt-ai-filter-blurred').length;
    try {
      await chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count });
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
    if (isScanning) {
      pendingRescan = true;
      return;
    }
    isScanning = true;

    try {
      const stateResp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
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
        const chunk = toEvaluate.slice(i, i + EVAL_BATCH_SIZE);
        const resp = await chrome.runtime.sendMessage({
          type: 'EVALUATE_TITLES',
          items: chunk
        });

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
      console.warn('[yt-ai-filter] Scan error:', err?.message || err);
    } finally {
      isScanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        scheduleScan();
      }
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanAndFilter();
    }, SCAN_DEBOUNCE_MS);
  }

  function resetAllCardsAndRescan() {
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === 'SETTINGS_UPDATED') {
        if (message.settings) {
          currentSettings = message.settings;
        }
        await reEvaluateFromLocalScores();
        sendResponse({ ok: true });
      } else if (message?.type === 'RESCAN_REQUIRED') {
        if (message.settings) {
          currentSettings = message.settings;
        }
        resetAllCardsAndRescan();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        scheduleScan();
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', scheduleScan);
  window.addEventListener('yt-page-data-updated', scheduleScan);

  scheduleScan();
})();
