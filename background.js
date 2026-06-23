const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-4-8';
const QUEUE_SERVER = 'http://127.0.0.1:7432';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (!tab?.url) return;
    const isLinkedIn = tab.url.startsWith('https://www.linkedin.com/');
    chrome.sidePanel.setOptions({ tabId, enabled: isLinkedIn });
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  const isLinkedIn = tab.url.startsWith('https://www.linkedin.com/');
  chrome.sidePanel.setOptions({ tabId, enabled: isLinkedIn });
});

// Fetch the next lead from the local campaign orchestrator queue server
async function fetchNextQueuedLead() {
  try {
    const token = await getLocalToken();
    const res = await fetch(`${QUEUE_SERVER}/next`, {
      headers: { 'X-GTS-Token': token || '' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.empty ? null : data;
  } catch {
    return null;
  }
}

async function reportToQueue(endpoint, body) {
  try {
    const token = await getLocalToken();
    await fetch(`${QUEUE_SERVER}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GTS-Token': token || '' },
      body: JSON.stringify(body)
    });
  } catch {
    // Queue server may not be running; continue without it
  }
}

async function getLocalToken() {
  const { gtsLocalToken } = await chrome.storage.local.get('gtsLocalToken');
  return gtsLocalToken || '';
}

const CAMPAIGN_PROMPTS = {
  cold_outreach: {
    system: `You are a professional outreach specialist for GuardTech Solutions, a cybersecurity and IT solutions company.
Your goal is to craft personalized LinkedIn connection requests and messages that feel genuine, not salesy.
Focus on the prospect's background and find a natural reason to connect.
GuardTech Solutions specializes in: cybersecurity consulting, managed security services, IT infrastructure, compliance (SOC2, ISO27001, HIPAA), and risk assessment.`,
    intent: 'introduce GuardTech Solutions and establish a meaningful professional connection'
  },
  partnership: {
    system: `You are a business development representative for GuardTech Solutions, a cybersecurity and IT solutions company.
Your goal is to explore strategic partnership opportunities with complementary businesses.
GuardTech Solutions specializes in: cybersecurity consulting, managed security services, IT infrastructure, compliance, and risk assessment.
Look for synergies and mutual value in the prospect's work.`,
    intent: 'explore potential partnership or collaboration opportunities between our organizations'
  },
  sales_demo: {
    system: `You are a sales development representative for GuardTech Solutions, a cybersecurity and IT solutions company.
Your goal is to warm up prospects who may benefit from GuardTech's security solutions and invite them to a brief demo.
GuardTech Solutions specializes in: cybersecurity consulting, managed security services, IT infrastructure, compliance (SOC2, ISO27001, HIPAA), and risk assessment.
Be consultative, not pushy. Lead with value and a specific pain point relevant to their industry/role.`,
    intent: 'invite the prospect to a 15-minute demo of GuardTech\'s relevant security solutions'
  },
  referral: {
    system: `You are reaching out on behalf of GuardTech Solutions, a cybersecurity and IT solutions company.
You have a mutual connection or shared context with this prospect.
GuardTech Solutions specializes in: cybersecurity consulting, managed security services, IT infrastructure, compliance, and risk assessment.
Leverage the shared connection or context naturally and authentically.`,
    intent: 'connect based on a shared context or mutual relationship and explore how GuardTech can help'
  },
  recruitment: {
    system: `You are a talent acquisition specialist at GuardTech Solutions, a growing cybersecurity and IT solutions company.
Your goal is to reach out to qualified candidates for potential opportunities at GuardTech.
GuardTech Solutions specializes in: cybersecurity consulting, managed security services, IT infrastructure, compliance, and risk assessment.
Be respectful of their current position and highlight what makes GuardTech an exciting place to work.`,
    intent: 'explore whether the prospect might be open to exciting opportunities at GuardTech Solutions'
  }
};

function buildSystemPrompt(campaign) {
  const config = CAMPAIGN_PROMPTS[campaign] || CAMPAIGN_PROMPTS.cold_outreach;
  return config.system;
}

function buildUserPrompt(profile, campaign, messageType, tone) {
  const config = CAMPAIGN_PROMPTS[campaign] || CAMPAIGN_PROMPTS.cold_outreach;
  const toneGuide = {
    professional: 'formal and polished, suitable for executive-level communication',
    friendly: 'warm and approachable, conversational but still professional',
    direct: 'concise and to the point, respecting their time'
  };

  const charLimit = messageType === 'connection' ? 300 : 1000;
  const messageLabel = messageType === 'connection' ? 'LinkedIn connection request note' : 'LinkedIn direct message';

  return `Write a ${messageLabel} for this LinkedIn prospect.

PROSPECT PROFILE:
- Name: ${profile.name || 'Unknown'}
- Headline: ${profile.headline || 'Not available'}
- Company: ${profile.company || 'Not available'}
- Location: ${profile.location || 'Not available'}
- About: ${profile.about ? profile.about.substring(0, 300) : 'Not available'}
- Mutual Connections: ${profile.mutualConnections || 'None listed'}
- Recent Activity/Posts: ${profile.recentActivity || 'Not available'}

CAMPAIGN GOAL: ${config.intent}

TONE: ${toneGuide[tone] || toneGuide.professional}

REQUIREMENTS:
- Maximum ${charLimit} characters (STRICT LIMIT — count carefully)
- Do NOT use generic phrases like "I came across your profile" or "I hope this message finds you well"
- Reference something specific from their background
- Make the value proposition clear but subtle
- End with a soft, non-pressuring call to action
- Write in first person as a GuardTech Solutions representative
- Do NOT include a subject line or greeting like "Hi [Name]," — start directly with the message body

Output ONLY the message text, nothing else.`;
}

async function generateMessage(profile, campaign, messageType, tone, apiKey) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(campaign),
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(profile, campaign, messageType, tone)
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(error?.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text.trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'generateMessage') {
    const { profile, campaign, messageType, tone, apiKey } = message;
    generateMessage(profile, campaign, messageType, tone, apiKey)
      .then(text => sendResponse({ success: true, message: text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getNextQueuedLead') {
    fetchNextQueuedLead()
      .then(lead => sendResponse({ lead }))
      .catch(() => sendResponse({ lead: null }));
    return true;
  }

  if (message.action === 'reportConnectionSent') {
    reportToQueue('connection-sent', { leadId: message.leadId, message: message.text })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'reportConnectionAccepted') {
    reportToQueue('connection-accepted', { leadId: message.leadId })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'reportMessageSent') {
    reportToQueue('message-sent', { leadId: message.leadId, message: message.text })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
