try {
  importScripts('./env-config.js');
} catch {
  // Optional build-generated env-config.js; user can also set the API key in the popup UI.
}

const BUILD_ENV = globalThis.__YT_AI_FILTER_ENV__ || {};

const DEFAULT_SETTINGS = {
  enabled: true,
  prompt: 'Block all ai slops, brain rot, bad news about stock markets',
  threshold: 0.65,
  clickToPeek: true,
  apiKey: BUILD_ENV.CMD_API_KEY || '',
  model: BUILD_ENV.CMD_MODEL || 'typesafe/jev',
  baseUrl: BUILD_ENV.CMD_BASE_URL || 'https://api.commandcode.ai/provider/v1',
  cfAigAuth: BUILD_ENV.CF_AIG_AUTH || ''
};

const DEFAULT_STATS = {
  totalScanned: 0,
  totalBlurred: 0,
  lastError: ''
};

const DEFAULT_CUSTOM_BACKGROUND = {
  type: 'none',
  src: '',
  fit: 'cover',
  fileName: ''
};

const MAX_CACHE_ENTRIES = 1500;
const API_BATCH_SIZE = 15;

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function makeCacheKey(model, prompt, title) {
  return `${model}::${normalizeText(prompt)}::${normalizeText(title)}`;
}

function cleanBaseUrl(url) {
  return String(url || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
}

function isJevModel(model) {
  return String(model || '').startsWith('typesafe/jev');
}

async function getStoredState() {
  const data = await chrome.storage.local.get(['settings', 'stats', 'verdictCache']);
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  if (!mergedSettings.apiKey && BUILD_ENV.CMD_API_KEY) {
    mergedSettings.apiKey = BUILD_ENV.CMD_API_KEY;
  }
  return {
    settings: mergedSettings,
    stats: { ...DEFAULT_STATS, ...(data.stats || {}) },
    verdictCache: data.verdictCache || {}
  };
}

function pruneCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) {
    return cache;
  }
  entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
  const kept = entries.slice(entries.length - MAX_CACHE_ENTRIES);
  return Object.fromEntries(kept);
}

function buildHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.apiKey.trim()}`
  };
  if (settings.cfAigAuth && settings.cfAigAuth.trim()) {
    headers['cf-aig-authorization'] = settings.cfAigAuth.trim();
  }
  return headers;
}

async function callJevSystemOne(items, settings) {
  const endpoint = `${cleanBaseUrl(settings.baseUrl)}/systemone`;
  const lines = items.map((item, idx) => `[v${idx}] Title: "${item.title.replace(/"/g, '\\"')}"`);
  const state = `Filter Rule: ${settings.prompt}\n\nVideos to evaluate:\n${lines.join('\n')}`;

  const questions = {};
  items.forEach((_, idx) => {
    const qKey = `v${idx}`;
    questions[qKey] = {
      type: 'noul',
      instructions: `Should video [${qKey}] be blocked based strictly on the Filter Rule?`
    };
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      state,
      questions
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`);
  }

  const data = await response.json();
  const answers = data?.answers || {};
  const scores = {};

  items.forEach((item, idx) => {
    const qKey = `v${idx}`;
    const rawNoul = answers[qKey]?.noul;
    const noul = typeof rawNoul === 'number' ? Math.max(0, Math.min(1, rawNoul)) : 0;
    scores[item.id] = { noul, reason: settings.prompt };
  });

  return scores;
}

async function callChatFallback(items, settings) {
  const endpoint = `${cleanBaseUrl(settings.baseUrl)}/chat/completions`;
  const lines = items.map((item, idx) => `[v${idx}] ${item.title}`);
  const systemPrompt = [
    'You classify YouTube video titles against a user blocking rule.',
    'Return ONLY valid JSON mapping each video key (e.g. "v0") to a probability number between 0.0 and 1.0 indicating how strongly the title violates the filter rule.',
    'Example: {"v0": 0.92, "v1": 0.04}'
  ].join(' ');

  const userPrompt = `Filter Rule: ${settings.prompt}\n\nTitles:\n${lines.join('\n')}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  const scores = {};

  items.forEach((item, idx) => {
    const val = Number(parsed[`v${idx}`]);
    const noul = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
    scores[item.id] = { noul, reason: settings.prompt };
  });

  return scores;
}

async function evaluateChunk(items, settings) {
  if (isJevModel(settings.model)) {
    return await callJevSystemOne(items, settings);
  }
  return await callChatFallback(items, settings);
}

async function handleEvaluateTitles(rawItems) {
  const { settings, stats, verdictCache } = await getStoredState();

  if (!settings.enabled || !settings.prompt.trim() || !settings.apiKey.trim()) {
    return { ok: true, results: {}, settings };
  }

  const results = {};
  const uncached = [];

  for (const item of rawItems) {
    if (!item || !item.id || !item.title) continue;
    const key = makeCacheKey(settings.model, settings.prompt, item.title);
    const cached = verdictCache[key];
    if (cached && typeof cached.noul === 'number') {
      results[item.id] = {
        noul: cached.noul,
        shouldBlur: cached.noul >= settings.threshold,
        reason: settings.prompt
      };
    } else {
      uncached.push(item);
    }
  }

  let newScanned = 0;
  let newBlurred = 0;
  let lastError = '';

  if (uncached.length > 0) {
    for (let i = 0; i < uncached.length; i += API_BATCH_SIZE) {
      const chunk = uncached.slice(i, i + API_BATCH_SIZE);
      try {
        const chunkScores = await evaluateChunk(chunk, settings);
        const now = Date.now();
        for (const item of chunk) {
          const entry = chunkScores[item.id] || { noul: 0, reason: settings.prompt };
          const cacheKey = makeCacheKey(settings.model, settings.prompt, item.title);
          verdictCache[cacheKey] = { noul: entry.noul, ts: now };
          const shouldBlur = entry.noul >= settings.threshold;
          results[item.id] = {
            noul: entry.noul,
            shouldBlur,
            reason: entry.reason
          };
          newScanned += 1;
          if (shouldBlur) newBlurred += 1;
        }
      } catch (err) {
        lastError = err?.message || String(err);
        console.error('[yt-ai-filter] Evaluation error:', lastError);
        break;
      }
    }

    const prunedCache = pruneCache(verdictCache);
    const updatedStats = {
      totalScanned: stats.totalScanned + newScanned,
      totalBlurred: stats.totalBlurred + newBlurred,
      lastError
    };
    await chrome.storage.local.set({
      verdictCache: prunedCache,
      stats: updatedStats
    });
  } else if (stats.lastError) {
    await chrome.storage.local.set({
      stats: { ...stats, lastError: '' }
    });
  }

  return { ok: !lastError, error: lastError, results, settings };
}

async function notifyYouTubeTabs(type, payload = {}) {
  const tabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/*', 'https://m.youtube.com/*']
  });
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type, ...payload });
      } catch {
        // Tab may not have content script ready yet
      }
    })
  );
}

async function handleSaveSettings(newSettings) {
  const { settings: oldSettings, stats } = await getStoredState();
  const merged = {
    ...DEFAULT_SETTINGS,
    ...oldSettings,
    ...newSettings,
    threshold: Number(newSettings.threshold ?? oldSettings.threshold),
    baseUrl: cleanBaseUrl(newSettings.baseUrl ?? oldSettings.baseUrl)
  };

  const promptChanged = normalizeText(oldSettings.prompt) !== normalizeText(merged.prompt);
  const modelChanged = oldSettings.model !== merged.model;

  if (promptChanged || modelChanged) {
    await chrome.storage.local.set({
      settings: merged,
      verdictCache: {},
      stats: { ...DEFAULT_STATS }
    });
    await notifyYouTubeTabs('RESCAN_REQUIRED', { settings: merged });
  } else {
    await chrome.storage.local.set({
      settings: merged,
      stats: { ...stats, lastError: '' }
    });
    await notifyYouTubeTabs('SETTINGS_UPDATED', { settings: merged });
  }

  return { ok: true, settings: merged };
}

async function handleClearCache() {
  const { settings } = await getStoredState();
  await chrome.storage.local.set({
    verdictCache: {},
    stats: { ...DEFAULT_STATS }
  });
  await notifyYouTubeTabs('RESCAN_REQUIRED', { settings });
  return { ok: true };
}

async function handleTestApi(candidateSettings) {
  const { settings: stored } = await getStoredState();
  const testSettings = {
    ...stored,
    ...(candidateSettings || {}),
    baseUrl: cleanBaseUrl(candidateSettings?.baseUrl ?? stored.baseUrl)
  };

  if (!testSettings.apiKey.trim()) {
    return { ok: false, error: 'API key is required.' };
  }

  const startedAt = Date.now();
  try {
    const sample = [{ id: 'test', title: 'S&P 500 CRASHING TODAY - SELL EVERYTHING NOW!' }];
    const scores = await evaluateChunk(sample, testSettings);
    const latencyMs = Date.now() - startedAt;
    return {
      ok: true,
      model: testSettings.model,
      sampleNoul: scores.test?.noul ?? 0,
      latencyMs
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function handleUpdateBadge(count, tabId) {
  const text = count > 0 ? String(count) : '';
  const options = tabId ? { text, tabId } : { text };
  await chrome.action.setBadgeText(options);
  if (count > 0) {
    const colorOptions = tabId ? { color: '#ef4444', tabId } : { color: '#ef4444' };
    await chrome.action.setBadgeBackgroundColor(colorOptions);
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'EVALUATE_TITLES':
      return await handleEvaluateTitles(message.items || []);
    case 'GET_SETTINGS': {
      const { settings, stats, verdictCache } = await getStoredState();
      return {
        ok: true,
        settings,
        stats,
        cacheCount: Object.keys(verdictCache).length
      };
    }
    case 'SAVE_SETTINGS':
      return await handleSaveSettings(message.settings || {});
    case 'CLEAR_CACHE':
      return await handleClearCache();
    case 'TEST_API':
      return await handleTestApi(message.settings || {});
    case 'UPDATE_BADGE':
      await handleUpdateBadge(Number(message.count || 0), sender?.tab?.id);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['settings', 'stats', 'customBackground']);
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!existing.stats) {
    await chrome.storage.local.set({ stats: DEFAULT_STATS });
  }
  if (!existing.customBackground) {
    await chrome.storage.local.set({ customBackground: DEFAULT_CUSTOM_BACKGROUND });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const response = await handleMessage(message, sender);
      sendResponse(response);
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
