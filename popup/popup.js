const DIRECT_BASE_URL = 'https://api.commandcode.ai/provider/v1';
const GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/1d7601f97105bd0f5cc2bdc9101dc2d5/default/custom-command-code/provider/v1';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/gif',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif'
]);
const DATA_IMAGE_RE = /^data:image\/(?:gif|png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

const form = document.getElementById('filter-form');
const enabledInput = document.getElementById('enabled');
const clickToPeekInput = document.getElementById('click-to-peek');
const promptInput = document.getElementById('prompt');
const thresholdInput = document.getElementById('threshold');
const thresholdOutput = document.getElementById('threshold-output');
const bgModeRadios = Array.from(document.querySelectorAll('input[name="bgMode"]'));
const bgFitRadios = Array.from(document.querySelectorAll('input[name="bgFit"]'));
const bgUploadPanel = document.getElementById('bg-upload-panel');
const bgUrlPanel = document.getElementById('bg-url-panel');
const bgDropzone = document.getElementById('bg-dropzone');
const bgFileInput = document.getElementById('bg-file');
const bgFileName = document.getElementById('bg-file-name');
const openTabUploaderBtn = document.getElementById('open-tab-uploader-btn');
const clearBgBtn = document.getElementById('clear-bg-btn');
const bgUrlInput = document.getElementById('bg-url');
const bgPreviewPanel = document.getElementById('bg-preview-panel');
const bgPreviewImg = document.getElementById('bg-preview-img');
const bgPreviewError = document.getElementById('bg-preview-error');
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

let uploadedDataUrl = '';
let uploadedFileName = '';

const isTabView = new URLSearchParams(window.location.search).get('view') === 'tab';
if (isTabView) {
  document.body.classList.add('is-tab-view');
  openTabUploaderBtn.hidden = true;
}

function getSelectedBgMode() {
  return bgModeRadios.find((r) => r.checked)?.value || 'none';
}

function setSelectedBgMode(mode) {
  const normalized = mode === 'upload' || mode === 'url' ? mode : 'none';
  for (const radio of bgModeRadios) {
    radio.checked = radio.value === normalized;
  }
}

function getSelectedBgFit() {
  return bgFitRadios.find((r) => r.checked)?.value === 'contain' ? 'contain' : 'cover';
}

function setSelectedBgFit(fit) {
  const normalized = fit === 'contain' ? 'contain' : 'cover';
  for (const radio of bgFitRadios) {
    radio.checked = radio.value === normalized;
  }
}

function showPreviewError(msg) {
  if (!msg) {
    bgPreviewError.textContent = '';
    bgPreviewError.hidden = true;
    return;
  }
  bgPreviewError.textContent = msg;
  bgPreviewError.hidden = false;
}

function validateBgUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter an https:// image or GIF URL.' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Enter a valid https:// image or GIF URL.' };
  }
  if (parsed.protocol === 'file:') {
    return { ok: false, error: 'Local file:// URLs are blocked. Switch to "Upload GIF / image" instead.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// URLs are allowed for custom backgrounds.' };
  }
  return { ok: true, href: parsed.href };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

function syncBackgroundUi() {
  const mode = getSelectedBgMode();
  const fit = getSelectedBgFit();

  bgUploadPanel.hidden = mode !== 'upload';
  bgUrlPanel.hidden = mode !== 'url';

  bgFileName.textContent = uploadedFileName ? `Selected: ${uploadedFileName}` : 'No file selected';
  clearBgBtn.hidden = !uploadedDataUrl;

  bgPreviewImg.classList.toggle('is-contain', fit === 'contain');
  showPreviewError('');

  let previewSrc = '';
  if (mode === 'upload' && uploadedDataUrl && DATA_IMAGE_RE.test(uploadedDataUrl)) {
    previewSrc = uploadedDataUrl;
  } else if (mode === 'url') {
    const check = validateBgUrl(bgUrlInput.value);
    if (check.ok) {
      previewSrc = check.href;
    }
  }

  if (previewSrc) {
    if (bgPreviewImg.getAttribute('src') !== previewSrc) {
      bgPreviewImg.setAttribute('src', previewSrc);
    }
    bgPreviewPanel.hidden = false;
  } else {
    bgPreviewImg.removeAttribute('src');
    bgPreviewPanel.hidden = true;
  }
}

async function handleSelectedFile(file) {
  if (!file) return;
  bgFileInput.setCustomValidity('');

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    const msg = 'Unsupported file type. Use GIF, PNG, JPG, WebP, or AVIF.';
    bgFileInput.setCustomValidity(msg);
    showStatus(msg, true);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const msg = 'File exceeds 8 MB limit. Please choose a smaller GIF or image.';
    bgFileInput.setCustomValidity(msg);
    showStatus(msg, true);
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    if (!DATA_IMAGE_RE.test(dataUrl)) {
      const msg = 'Selected file is not a supported GIF, PNG, JPG, WebP, or AVIF image.';
      bgFileInput.setCustomValidity(msg);
      showStatus(msg, true);
      return;
    }
    uploadedDataUrl = dataUrl;
    uploadedFileName = file.name || 'custom-image';
    setSelectedBgMode('upload');
    syncBackgroundUi();
    showStatus('Background loaded. Click "Save & Apply" to apply to YouTube tabs.');
  } catch (err) {
    showStatus(err?.message || 'Could not read image file.', true);
  }
}

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
  const [resp, bgStored] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    chrome.storage.local.get('customBackground')
  ]);
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

  const bg = bgStored?.customBackground || {};
  setSelectedBgMode(bg.type || 'none');
  setSelectedBgFit(bg.fit || 'cover');
  if (bg.type === 'upload' && typeof bg.src === 'string' && DATA_IMAGE_RE.test(bg.src)) {
    uploadedDataUrl = bg.src;
    uploadedFileName = bg.fileName || 'Saved image';
  } else if (bg.type === 'url' && typeof bg.src === 'string') {
    bgUrlInput.value = bg.src;
  }
  syncBackgroundUi();

  renderStats(resp.stats, resp.cacheCount);
}

thresholdInput.addEventListener('input', (e) => {
  updateThresholdDisplay(e.target.value);
});

for (const radio of [...bgModeRadios, ...bgFitRadios]) {
  radio.addEventListener('change', () => {
    bgFileInput.setCustomValidity('');
    bgUrlInput.setCustomValidity('');
    syncBackgroundUi();
  });
}

bgFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    await handleSelectedFile(file);
  }
});

bgDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  bgDropzone.classList.add('is-dragover');
});

bgDropzone.addEventListener('dragleave', () => {
  bgDropzone.classList.remove('is-dragover');
});

bgDropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  bgDropzone.classList.remove('is-dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    await handleSelectedFile(file);
  }
});

document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && ALLOWED_MIME_TYPES.has(item.type)) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        await handleSelectedFile(file);
        break;
      }
    }
  }
});

bgUrlInput.addEventListener('input', () => {
  bgUrlInput.setCustomValidity('');
  showPreviewError('');
  const check = validateBgUrl(bgUrlInput.value);
  if (check.ok) {
    syncBackgroundUi();
  } else {
    bgPreviewImg.removeAttribute('src');
    bgPreviewPanel.hidden = true;
  }
});

bgUrlInput.addEventListener('blur', () => {
  const raw = bgUrlInput.value.trim();
  if (!raw) return;
  const check = validateBgUrl(raw);
  if (!check.ok) {
    bgUrlInput.setCustomValidity(check.error);
    showPreviewError(check.error);
  } else {
    syncBackgroundUi();
  }
});

bgPreviewImg.addEventListener('load', () => {
  showPreviewError('');
});

bgPreviewImg.addEventListener('error', () => {
  showPreviewError('Could not load preview image. Check that the URL points directly to a public image or GIF.');
});

openTabUploaderBtn.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?view=tab') });
});

clearBgBtn.addEventListener('click', () => {
  uploadedDataUrl = '';
  uploadedFileName = '';
  bgFileInput.value = '';
  bgFileInput.setCustomValidity('');
  syncBackgroundUi();
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
  bgFileInput.setCustomValidity('');
  bgUrlInput.setCustomValidity('');

  const bgMode = getSelectedBgMode();
  const bgFit = getSelectedBgFit();
  let customBackground = {
    type: 'none',
    src: '',
    fit: bgFit,
    fileName: ''
  };

  if (bgMode === 'upload') {
    if (!uploadedDataUrl || !DATA_IMAGE_RE.test(uploadedDataUrl)) {
      bgFileInput.setCustomValidity('Please choose a GIF or image file to upload, or switch to Default blur.');
      bgFileInput.reportValidity();
      bgFileInput.focus();
      return;
    }
    customBackground = {
      type: 'upload',
      src: uploadedDataUrl,
      fit: bgFit,
      fileName: uploadedFileName
    };
  } else if (bgMode === 'url') {
    const check = validateBgUrl(bgUrlInput.value);
    if (!check.ok) {
      bgUrlInput.setCustomValidity(check.error);
      bgUrlInput.reportValidity();
      bgUrlInput.focus();
      return;
    }
    customBackground = {
      type: 'url',
      src: check.href,
      fit: bgFit,
      fileName: ''
    };
  }

  if (!form.reportValidity()) {
    const firstInvalid = form.querySelector(':invalid');
    firstInvalid?.focus();
    return;
  }

  saveBtn.disabled = true;
  try {
    try {
      await chrome.storage.local.set({ customBackground });
    } catch (storageErr) {
      showStatus(`Failed to save background: ${storageErr?.message || 'Storage quota exceeded.'}`, true);
      return;
    }

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
