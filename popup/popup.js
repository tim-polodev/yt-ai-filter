const DIRECT_BASE_URL = 'https://api.commandcode.ai/provider/v1';
const GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/1d7601f97105bd0f5cc2bdc9101dc2d5/default/custom-command-code/provider/v1';

const form = document.getElementById('filter-form');
const enabledInput = document.getElementById('enabled');
const clickToPeekInput = document.getElementById('click-to-peek');
const promptInput = document.getElementById('prompt');
const thresholdInput = document.getElementById('threshold');
const thresholdOutput = document.getElementById('threshold-output');
const modelSelect = document.getElementById('model');
const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const baseUrlInput = document.getElementById('base-url');
const cfAigAuthInput = document.getElementById('cf-aig-auth');
const presetDirectBtn = document.getElementById('preset-direct');
const presetGatewayBtn = document.getElementById('preset-gateway');
const testApiBtn = document.getElementById('test-api-btn');
const saveBtn = document.getElementById('save-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const statusMsg = document.getElementById('status-msg');
const statScanned = document.getElementById('stat-scanned');
const statBlurred = document.getElementById('stat-blurred');
const statCached = document.getElementById('stat-cached');

function updateThresholdDisplay(val) {
  const num = Number(val);
  const pct = Math.round(num * 100);
  thresholdOutput.textContent = `${num.toFixed(2)} (${pct}%)`;
  if (!CSS.supports('accent-color', '#ef4444')) {
    const ratio = ((num - 0.5) / 0.45) * 100;
    thresholdInput.style.setProperty('--progress', `${ratio}%`);
  }
}

function showStatus(text, isError = false) {
  statusMsg.textContent = text;
  statusMsg.className = `status-msg ${isError ? 'is-err' : 'is-ok'}`;
}

function renderStats(stats, cacheCount) {
  statScanned.textContent = String(stats?.totalScanned ?? 0);
  statBlurred.textContent = String(stats?.totalBlurred ?? 0);
  statCached.textContent = String(cacheCount ?? 0);
  if (stats?.lastError) {
    showStatus(`Last API error: ${stats.lastError}`, true);
  }
}

function readFormSettings() {
  return {
    enabled: enabledInput.checked,
    clickToPeek: clickToPeekInput.checked,
    prompt: promptInput.value.trim(),
    threshold: Number(thresholdInput.value),
    model: modelSelect.value,
    apiKey: apiKeyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    cfAigAuth: cfAigAuthInput.value.trim()
  };
}

async function loadInitialState() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (!resp?.ok) {
    showStatus(resp?.error || 'Failed to load settings.', true);
    return;
  }

  const s = resp.settings;
  enabledInput.checked = Boolean(s.enabled);
  clickToPeekInput.checked = Boolean(s.clickToPeek);
  promptInput.value = s.prompt || '';
  thresholdInput.value = String(s.threshold ?? 0.65);
  updateThresholdDisplay(thresholdInput.value);
  modelSelect.value = s.model || 'typesafe/jev';
  apiKeyInput.value = s.apiKey || '';
  baseUrlInput.value = s.baseUrl || DIRECT_BASE_URL;
  cfAigAuthInput.value = s.cfAigAuth || '';

  renderStats(resp.stats, resp.cacheCount);
}

thresholdInput.addEventListener('input', (e) => {
  updateThresholdDisplay(e.target.value);
});

toggleKeyBtn.addEventListener('click', () => {
  const isMasked = apiKeyInput.type === 'password';
  apiKeyInput.type = isMasked ? 'text' : 'password';
  toggleKeyBtn.textContent = isMasked ? 'Hide' : 'Show';
  toggleKeyBtn.setAttribute('aria-pressed', String(isMasked));
  toggleKeyBtn.setAttribute('aria-label', isMasked ? 'Hide API key' : 'Show API key');
});

presetDirectBtn.addEventListener('click', () => {
  baseUrlInput.value = DIRECT_BASE_URL;
});

presetGatewayBtn.addEventListener('click', () => {
  baseUrlInput.value = GATEWAY_BASE_URL;
});

[promptInput, apiKeyInput, baseUrlInput].forEach((el) => {
  el.addEventListener('input', () => {
    el.setCustomValidity('');
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) {
    const firstInvalid = form.querySelector(':invalid');
    firstInvalid?.focus();
    return;
  }

  saveBtn.disabled = true;
  try {
    const settings = readFormSettings();
    const resp = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (resp?.ok) {
      showStatus('Settings saved and applied to YouTube tabs.');
      const refreshed = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (refreshed?.ok) renderStats(refreshed.stats, refreshed.cacheCount);
    } else {
      showStatus(resp?.error || 'Failed to save settings.', true);
    }
  } finally {
    saveBtn.disabled = false;
  }
});

testApiBtn.addEventListener('click', async () => {
  testApiBtn.disabled = true;
  showStatus('Testing Command Code Jev API...');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'TEST_API',
      settings: readFormSettings()
    });
    if (resp?.ok) {
      const pct = Math.round((resp.sampleNoul ?? 0) * 100);
      showStatus(`Connected (${resp.model}) in ${resp.latencyMs}ms · sample noul: ${resp.sampleNoul.toFixed(2)} (${pct}%)`);
    } else {
      showStatus(`API test failed: ${resp?.error || 'Unknown error'}`, true);
    }
  } finally {
    testApiBtn.disabled = false;
  }
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    if (resp?.ok) {
      renderStats({ totalScanned: 0, totalBlurred: 0 }, 0);
      showStatus('Cache cleared. Active YouTube tabs are re-scanning.');
    } else {
      showStatus(resp?.error || 'Failed to clear cache.', true);
    }
  } finally {
    clearCacheBtn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', loadInitialState);
