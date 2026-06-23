function isProfilePage() {
  return /linkedin\.com\/in\/[^/]+/.test(window.location.href);
}

function isSearchResultsPage() {
  return /linkedin\.com\/search\/results\/people/.test(window.location.href);
}

function getText(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }
  return null;
}

function extractProfileData() {
  if (!isProfilePage()) return null;

  const name = getText([
    'h1.text-heading-xlarge',
    '.pv-text-details__left-panel h1',
    'h1[class*="artdeco-entity-lockup__title"]',
    '.profile-info-subheader .full-name',
    'h1'
  ]);

  const headline = getText([
    '.text-body-medium.break-words',
    '[data-generated-suggestion-target] .pv-text-details__left-panel .text-body-medium',
    '.pv-text-details__left-panel .text-body-medium',
    '.ph5 .mt2 .text-body-medium'
  ]);

  const location = getText([
    '.text-body-small.inline.t-black--light.break-words',
    '.pv-text-details__left-panel .text-body-small',
    '[data-field="location_pill"]'
  ]);

  const company = getText([
    '.pv-text-details__right-panel .inline-show-more-text',
    '.pv-position-entity__company-name',
    'a[data-field="experience_company_logo"]',
    '.experience-item .pv-entity__secondary-title',
    '#experience ~ .pvs-list__outer-container .pvs-entity .hoverable-link-text span[aria-hidden="true"]'
  ]) || extractCurrentCompanyFromExperience();

  const about = getText([
    '#about ~ .pvs-list__outer-container .inline-show-more-text',
    '.pv-about-section .pv-about__summary-text',
    '[data-generated-suggestion-target] .pv-about__summary-text',
    '.pvs-list [data-view-name="profile-component-entity"] .inline-show-more-text'
  ]);

  const mutualConnections = getText([
    '.ph5 .t-black--light a[href*="mutual"]',
    '[data-field="mutual_connections_count"]',
    '.pv-highlights-section .pv-highlights-section__title',
    '.pvs-header__badge-text'
  ]);

  const recentActivity = extractRecentActivity();

  return { name, headline, location, company, about, mutualConnections, recentActivity };
}

function extractCurrentCompanyFromExperience() {
  const experienceSection = document.querySelector('#experience');
  if (!experienceSection) return null;

  const list = experienceSection.closest('section')?.nextElementSibling;
  if (!list) return null;

  const firstItem = list.querySelector('.pvs-entity');
  if (!firstItem) return null;

  const spans = firstItem.querySelectorAll('span[aria-hidden="true"]');
  for (const span of spans) {
    const text = span.textContent.trim();
    if (text && !text.includes('·')) return text;
  }
  return null;
}

function extractRecentActivity() {
  const activitySection = document.querySelector('[data-view-name="profile-component-entity"] .visually-hidden');
  if (activitySection) return activitySection.textContent.trim().substring(0, 200);

  const posts = document.querySelectorAll('.feed-shared-text span.break-words');
  if (posts.length > 0) return posts[0].textContent.trim().substring(0, 200);

  return null;
}

function findMessageBox() {
  const selectors = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form__msg-content-container .msg-form__contenteditable',
    '[data-placeholder="Write a message…"][contenteditable="true"]',
    '[aria-label="Write a message…"][contenteditable="true"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function findConnectionNoteBox() {
  const selectors = [
    '.send-invite__custom-message textarea',
    'textarea[name="customizedMessage"]',
    '#custom-message',
    '[data-test-custom-message-to-connect] textarea',
    '.artdeco-modal textarea'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function injectMessage(text) {
  const msgBox = findMessageBox();
  if (msgBox) {
    msgBox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
    return { success: true, type: 'message' };
  }

  const noteBox = findConnectionNoteBox();
  if (noteBox) {
    noteBox.focus();
    noteBox.value = text;
    noteBox.dispatchEvent(new Event('input', { bubbles: true }));
    noteBox.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, type: 'connection_note' };
  }

  return {
    success: false,
    error: 'No message box found. Please open a message thread or connection request dialog first.'
  };
}

// ── Search Results Scraping ──────────────────────────────────────────────────

function extractSearchResults() {
  const cards = document.querySelectorAll('.entity-result, .search-result, [data-view-name="search-entity-result-universal-template"]');
  const results = [];

  cards.forEach(card => {
    const nameEl = card.querySelector(
      '.entity-result__title-text a span[aria-hidden="true"], ' +
      '.app-aware-link span[aria-hidden="true"], ' +
      'a.app-aware-link span:not(.visually-hidden)'
    );
    const name = nameEl?.textContent?.trim();
    if (!name || name === 'LinkedIn Member') return;

    const profileLinkEl = card.querySelector('a[href*="/in/"]');
    const linkedinUrl = profileLinkEl?.href?.split('?')[0];

    const headlineEl = card.querySelector(
      '.entity-result__primary-subtitle, ' +
      '.t-14.t-black.t-normal'
    );
    const headline = headlineEl?.textContent?.trim() || null;

    const locationEl = card.querySelector(
      '.entity-result__secondary-subtitle, ' +
      '.t-14.t-black--light.t-normal'
    );
    const location = locationEl?.textContent?.trim() || null;

    const nameParts = name.split(' ');
    results.push({
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(' ') || null,
      linkedin_name: name,
      linkedin_url: linkedinUrl || null,
      headline: headline,
      location: location,
      title: headline?.split(' at ')?.[0]?.trim() || null,
      company: headline?.split(' at ')?.[1]?.trim() || null,
      source: 'linkedin_search'
    });
  });

  return results;
}

// ── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getProfile') {
    const profile = extractProfileData();
    sendResponse({ success: !!profile, profile, isProfilePage: isProfilePage() });
    return false;
  }

  if (message.action === 'injectMessage') {
    const result = injectMessage(message.text);
    sendResponse(result);
    return false;
  }

  if (message.action === 'getSearchResults') {
    if (!isSearchResultsPage()) {
      sendResponse({ success: false, error: 'Not on a LinkedIn people search page', results: [] });
      return false;
    }
    const results = extractSearchResults();
    sendResponse({ success: true, results, isSearchPage: true });
    return false;
  }
});

let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    chrome.runtime.sendMessage({ action: 'urlChanged', url: lastUrl }).catch(() => {});
  }
});

observer.observe(document.body, { childList: true, subtree: true });
