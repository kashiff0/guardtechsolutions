let currentProfile = null;
let activeTab = null;

const CHAR_LIMITS = {
  connection: 300,
  message: 1000
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isLinkedInProfile(url) {
  return url && /linkedin\.com\/in\/[^/]+/.test(url);
}

async function loadProfile() {
  activeTab = await getActiveTab();

  if (!isLinkedInProfile(activeTab?.url)) {
    show('not-profile-page');
    hide('main-content');
    hide('no-api-key');
    return;
  }

  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) {
    show('no-api-key');
    hide('main-content');
    hide('not-profile-page');
    return;
  }

  show('main-content');
  hide('not-profile-page');
  hide('no-api-key');

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'getProfile' });
    if (response?.profile) {
      currentProfile = response.profile;
      renderProfile(currentProfile);
    } else {
      setProfileText('Could not read profile data.');
    }
  } catch {
    setProfileText('Reload the LinkedIn page and try again.');
  }
}

function renderProfile(profile) {
  document.getElementById('profile-name').textContent = profile.name || 'Unknown';
  document.getElementById('profile-headline').textContent = profile.headline || '';
  document.getElementById('profile-company').textContent = profile.company ? `🏢 ${profile.company}` : '';
  document.getElementById('profile-mutual').textContent = profile.mutualConnections ? `👥 ${profile.mutualConnections}` : '';
}

function setProfileText(text) {
  document.getElementById('profile-name').textContent = text;
  document.getElementById('profile-headline').textContent = '';
  document.getElementById('profile-company').textContent = '';
  document.getElementById('profile-mutual').textContent = '';
}

async function generateMessage() {
  if (!currentProfile) return;

  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) {
    showNotice('no-api-key');
    return;
  }

  const campaign = document.getElementById('campaign').value;
  const messageType = document.getElementById('message-type').value;
  const tone = document.getElementById('tone').value;

  setGenerating(true);
  hide('output-section');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'generateMessage',
      profile: currentProfile,
      campaign,
      messageType,
      tone,
      apiKey
    });

    if (response.success) {
      showOutput(response.message, messageType);
    } else {
      alert(`Error generating message: ${response.error}`);
    }
  } catch (err) {
    alert(`Extension error: ${err.message}`);
  } finally {
    setGenerating(false);
  }
}

function showOutput(text, messageType) {
  const textarea = document.getElementById('message-output');
  textarea.value = text;
  updateCharCount(text, messageType);
  show('output-section');
  hide('inject-status');
}

function updateCharCount(text, messageType) {
  const messageTypeVal = messageType || document.getElementById('message-type').value;
  const limit = CHAR_LIMITS[messageTypeVal] || 300;
  const count = text.length;
  const el = document.getElementById('char-count');
  el.textContent = `${count} / ${limit}`;
  el.classList.toggle('over-limit', count > limit);
}

function setGenerating(loading) {
  const btn = document.getElementById('generate-btn');
  const label = document.getElementById('generate-label');
  const spinner = document.getElementById('generate-spinner');
  btn.disabled = loading;
  label.textContent = loading ? 'Generating...' : 'Generate Message';
  spinner.classList.toggle('hidden', !loading);
}

async function injectMessage() {
  const text = document.getElementById('message-output').value;
  if (!text || !activeTab) return;

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'injectMessage',
      text
    });
    showInjectStatus(response);
  } catch {
    showInjectStatus({ success: false, error: 'Could not connect to LinkedIn tab. Make sure the LinkedIn page is open.' });
  }
}

function showInjectStatus(response) {
  const el = document.getElementById('inject-status');
  el.classList.remove('hidden', 'success', 'error');

  if (response.success) {
    el.textContent = response.type === 'connection_note'
      ? '✓ Injected into connection request note'
      : '✓ Injected into message box';
    el.classList.add('success');
  } else {
    el.textContent = `✗ ${response.error}`;
    el.classList.add('error');
  }
}

function copyToClipboard() {
  const text = document.getElementById('message-output').value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-btn');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

function show(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

function hide(id) {
  document.getElementById(id)?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();

  document.getElementById('generate-btn').addEventListener('click', generateMessage);
  document.getElementById('regenerate-btn').addEventListener('click', generateMessage);
  document.getElementById('inject-btn').addEventListener('click', injectMessage);
  document.getElementById('copy-btn').addEventListener('click', copyToClipboard);

  document.getElementById('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('settings-link').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('message-output').addEventListener('input', (e) => {
    updateCharCount(e.target.value);
  });

  document.getElementById('message-type').addEventListener('change', () => {
    const text = document.getElementById('message-output').value;
    if (text) updateCharCount(text);
  });
});
