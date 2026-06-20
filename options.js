const input = document.getElementById('api-key-input');
const saveBtn = document.getElementById('save-btn');
const deleteBtn = document.getElementById('delete-btn');
const toggleBtn = document.getElementById('toggle-visibility');
const statusEl = document.getElementById('status');
const keyStatusEl = document.getElementById('key-status');
const keyStatusText = document.getElementById('key-status-text');

async function loadKey() {
  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (apiKey) {
    input.value = apiKey;
    setKeyStatus(true);
  } else {
    setKeyStatus(false);
  }
}

function setKeyStatus(isSet) {
  keyStatusEl.className = `api-key-status ${isSet ? 'set' : 'not-set'}`;
  keyStatusEl.querySelector('span').textContent = isSet ? '✓' : '⚠';
  keyStatusText.textContent = isSet ? 'API key is configured' : 'No API key configured';
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  setTimeout(() => {
    statusEl.className = 'status';
  }, 4000);
}

saveBtn.addEventListener('click', async () => {
  const key = input.value.trim();
  if (!key) {
    showStatus('Please enter an API key.', 'error');
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    showStatus('Invalid key format. Anthropic API keys start with "sk-ant-".', 'error');
    return;
  }
  await chrome.storage.sync.set({ apiKey: key });
  setKeyStatus(true);
  showStatus('API key saved successfully.', 'success');
});

deleteBtn.addEventListener('click', async () => {
  await chrome.storage.sync.remove('apiKey');
  input.value = '';
  setKeyStatus(false);
  showStatus('API key removed.', 'success');
});

toggleBtn.addEventListener('click', () => {
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  toggleBtn.textContent = isPassword ? 'Hide' : 'Show';
});

loadKey();
