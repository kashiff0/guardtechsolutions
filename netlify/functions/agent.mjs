// KM-GTS CRM conversational agent (Netlify Function → Anthropic Messages API + tool use).
// The portal chat panel POSTs the running conversation + a live snapshot of the leads;
// this runs a server-side tool loop where Claude can add/update/delete/move leads, add
// notes, and queue browser tabs to open. It returns the updated leads array (the client
// saves it → cloud-syncs to every device), the tabs to open, and the assistant's reply.
//
//   POST { messages:[{role,content}], leads:[...] }
//        -> { reply, leads, openTabs:[{url,reason}], actions:[...] }
//   Auth: header `x-gts-pw` must equal site env var GTS_ADMIN_PW (same as crm/time).
//   Needs site env var ANTHROPIC_API_KEY.
//
// Human-in-the-loop: the agent edits the pipeline and opens research tabs, but it DRAFTS
// outreach — it never sends LinkedIn messages or email on the user's behalf.

const MODEL = 'claude-sonnet-4-6'; // chat agent: fast + cheap for frequent tool loops. Swap to 'claude-opus-4-8' for max reasoning.
const STAGES = ['New', 'Contacted', 'Demo Sent', 'Proposal', 'Won', 'Lost'];
const MAX_TURNS = 6;

export default async (req) => {
  try {
    const pw = req.headers.get('x-gts-pw') || '';
    const expected = process.env.GTS_ADMIN_PW || '';
    if (!expected || pw !== expected) return json({ error: 'unauthorized' }, 401);

    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return json({ error: 'The agent is not configured yet — set the ANTHROPIC_API_KEY environment variable on the Netlify site, then redeploy.' }, 503);
    }

    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));
    let leads = Array.isArray(body.leads) ? body.leads.map(normalizeLead) : [];
    const incoming = Array.isArray(body.messages) ? body.messages : [];

    // Keep only role/content and a sane window of history.
    const messages = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-20)
      .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content) }));

    if (!messages.length) return json({ error: 'no message' }, 400);

    const openTabs = [];
    const actions = []; // human-readable log of what the agent changed, for the chat UI

    let reply = '';
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const ai = await callClaude(apiKey, system(leads), messages, TOOLS);
      if (ai.error) return json({ error: ai.error }, 502);

      // Collect any assistant prose from this turn.
      const text = (ai.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) reply = reply ? reply + '\n\n' + text : text;

      const toolUses = (ai.content || []).filter((c) => c.type === 'tool_use');
      if (!toolUses.length) break; // final answer, no more tools requested

      // Echo the assistant's tool-use turn into history, then answer each tool.
      messages.push({ role: 'assistant', content: ai.content });
      const toolResults = [];
      for (const tu of toolUses) {
        const out = runTool(tu.name, tu.input || {}, leads, openTabs, actions);
        if (out.leads) leads = out.leads;
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out.result, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!reply) reply = actions.length ? 'Done.' : "I'm here — tell me what you'd like to do with the pipeline.";
    return json({ reply, leads, openTabs, actions });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

/* ----------------------------- Anthropic call ----------------------------- */
async function callClaude(apiKey, sys, messages, tools) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: sys, tools, messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: (data && data.error && data.error.message) || ('Anthropic API error ' + r.status) };
    return { content: data.content || [] };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/* ------------------------------ system prompt ----------------------------- */
function system(leads) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the CRM Agent for KM Guard Tech Solutions (KM-GTS), a Houston, Texas security-guard company. You work inside the company's portal CRM as a hands-on teammate for the owner/admin.

Today is ${today}.

WHO WE SELL TO ("gatekeepers" — whoever controls the security-vendor buy): commercial/residential property managers, HOA managers, facilities & operations directors, GMs, construction PMs, plus churches/faith orgs, private & charter schools, and restaurants/food service — all in the Houston metro.

THE PIPELINE — leads move through these stages in order: ${STAGES.join(' → ')}.
A lead = { id, company, contact, title, phone, city, email, linkedin, specialty, stage, value, nextStep, nextStepDue, notes }.

WHAT YOU CAN DO (use the tools):
- add_lead / update_lead / delete_lead / move_stage / add_note — manage the pipeline directly. Refer to a lead by its company name; I match it for you.
- open_tab — open a browser tab for the user (LinkedIn profile/search, Google, a company website, Google Maps). Use this whenever research would help — e.g. they say "look up X" or "find PMs in the Heights": open the relevant LinkedIn/Google search. Prefer a lead's saved linkedin URL when it exists.

HOW TO WORK:
- Be concise and action-oriented. Take the obvious action rather than asking permission for routine pipeline edits.
- When you change the CRM, say what you changed in one short line.
- HUMAN-IN-THE-LOOP: you may DRAFT outreach (LinkedIn intros, follow-ups, proposals) into a lead's notes or just in chat, but you NEVER send messages or email yourself — the user reviews and sends.
- If a request is ambiguous (e.g. two leads match), ask a brief clarifying question instead of guessing.
- The user may have just edited the pipeline by hand; the CURRENT LEADS below are the live state — trust them over older chat history.

CURRENT LEADS (${leads.length}):
${JSON.stringify(leads.map((l) => ({ company: l.company, contact: l.contact, title: l.title, stage: l.stage, value: l.value, city: l.city, linkedin: l.linkedin || '', nextStep: l.nextStep || '' })), null, 0)}`;
}

/* --------------------------------- tools ---------------------------------- */
const leadFields = {
  company: { type: 'string' }, contact: { type: 'string' }, title: { type: 'string' },
  phone: { type: 'string' }, city: { type: 'string' }, email: { type: 'string' },
  linkedin: { type: 'string' }, specialty: { type: 'string' },
  value: { type: 'number', description: 'estimated annual contract value in dollars' },
  nextStep: { type: 'string' },
};

const TOOLS = [
  {
    name: 'add_lead',
    description: 'Add a new lead/prospect to the CRM pipeline.',
    input_schema: {
      type: 'object',
      properties: { ...leadFields, stage: { type: 'string', enum: STAGES, description: 'defaults to New' } },
      required: ['company'],
    },
  },
  {
    name: 'update_lead',
    description: 'Update fields on an existing lead. Identify it by company name (or part of it).',
    input_schema: {
      type: 'object',
      properties: { match: { type: 'string', description: 'company name (or distinctive part) of the lead to update' }, ...leadFields },
      required: ['match'],
    },
  },
  {
    name: 'move_stage',
    description: 'Move a lead to a different pipeline stage.',
    input_schema: {
      type: 'object',
      properties: { match: { type: 'string' }, stage: { type: 'string', enum: STAGES } },
      required: ['match', 'stage'],
    },
  },
  {
    name: 'delete_lead',
    description: 'Remove a lead from the CRM entirely.',
    input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] },
  },
  {
    name: 'add_note',
    description: 'Append a timestamped note to a lead (e.g. call notes, or a drafted outreach message for the user to review).',
    input_schema: { type: 'object', properties: { match: { type: 'string' }, text: { type: 'string' } }, required: ['match', 'text'] },
  },
  {
    name: 'open_tab',
    description: 'Open a browser tab for the user (research: LinkedIn profile/search, Google, company site, Google Maps). Returns immediately; the tab opens in the user\'s browser.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'full https URL' }, reason: { type: 'string', description: 'short note on why, shown to the user' } },
      required: ['url'],
    },
  },
];

/* ------------------------------ tool runner ------------------------------- */
function runTool(name, input, leads, openTabs, actions) {
  try {
    if (name === 'add_lead') {
      const stage = STAGES.includes(input.stage) ? input.stage : 'New';
      let lead = normalizeLead({
        id: rid(), company: String(input.company || '').trim(), contact: input.contact || '—',
        title: input.title || '', phone: input.phone || '—', city: input.city || 'Houston, TX',
        email: input.email || '—', linkedin: input.linkedin || '', specialty: input.specialty || '',
        stage, value: Number(input.value) || 0, nextStep: input.nextStep || 'First call',
        nextStepDue: '', notes: [], created: Date.now(),
      });
      if (!lead.company) return errResult('company name is required');
      if (stage !== 'New') lead = queueForAgent(lead); // non-New start → flag for the outreach agent
      const next = [...leads, lead];
      actions.push(`Added "${lead.company}" to ${stage}`);
      return { leads: next, result: `Added "${lead.company}" (${stage}).` };
    }

    if (name === 'open_tab') {
      const url = sanitizeUrl(input.url);
      if (!url) return errResult('invalid or non-http(s) url');
      openTabs.push({ url, reason: input.reason || '' });
      actions.push(`Opened a tab: ${url}`);
      return { result: `Tab queued to open: ${url}` };
    }

    // remaining tools all target an existing lead
    const { lead, error } = matchLead(leads, input.match);
    if (error) return errResult(error);

    if (name === 'update_lead') {
      const next = leads.map((l) => (l.id === lead.id ? applyUpdate(l, input) : l));
      actions.push(`Updated "${lead.company}"`);
      return { leads: next, result: `Updated "${lead.company}".` };
    }
    if (name === 'move_stage') {
      if (!STAGES.includes(input.stage)) return errResult(`stage must be one of: ${STAGES.join(', ')}`);
      const next = leads.map((l) => (l.id === lead.id ? queueForAgent({ ...l, stage: input.stage }) : l));
      actions.push(`Moved "${lead.company}" → ${input.stage}`);
      return { leads: next, result: `"${lead.company}" → ${input.stage}.` };
    }
    if (name === 'delete_lead') {
      const next = leads.filter((l) => l.id !== lead.id);
      actions.push(`Deleted "${lead.company}"`);
      return { leads: next, result: `Deleted "${lead.company}".` };
    }
    if (name === 'add_note') {
      const text = String(input.text || '').trim();
      if (!text) return errResult('note text is empty');
      const next = leads.map((l) => (l.id === lead.id ? { ...l, notes: [...(l.notes || []), { t: text, when: Date.now() }] } : l));
      actions.push(`Noted on "${lead.company}"`);
      return { leads: next, result: `Note added to "${lead.company}".` };
    }
    return errResult('unknown tool');
  } catch (e) {
    return errResult(String((e && e.message) || e));
  }
}

/* ------------------------------- helpers ---------------------------------- */
function matchLead(leads, match) {
  const q = String(match || '').trim().toLowerCase();
  if (!q) return { error: 'no lead specified' };
  let hits = leads.filter((l) => l.id === match);
  if (!hits.length) hits = leads.filter((l) => (l.company || '').toLowerCase() === q);
  if (!hits.length) hits = leads.filter((l) => (l.company || '').toLowerCase().includes(q));
  if (!hits.length) return { error: `no lead found matching "${match}"` };
  if (hits.length > 1) return { error: `"${match}" matches ${hits.length} leads (${hits.map((h) => h.company).join(', ')}) — be more specific.` };
  return { lead: hits[0] };
}

function applyUpdate(lead, input) {
  const out = { ...lead };
  for (const k of Object.keys(leadFields)) {
    if (input[k] !== undefined && input[k] !== null && input[k] !== '') {
      out[k] = k === 'value' ? Number(input[k]) || 0 : input[k];
    }
  }
  if (input.stage && STAGES.includes(input.stage) && input.stage !== lead.stage) {
    return queueForAgent({ ...out, stage: input.stage });
  }
  return out;
}

// Mirror portal's queueForAgent(): a stage change flags the lead so the outreach
// agent re-drafts that stage's artifact on its next review.
function queueForAgent(lead) {
  return { ...lead, actionStatus: 'pending', actionStage: lead.stage, draft: '' };
}

function normalizeLead(l) {
  l = l && typeof l === 'object' ? l : {};
  return {
    id: l.id || rid(), company: l.company || '', contact: l.contact || '—', title: l.title || '',
    phone: l.phone || '—', city: l.city || 'Houston, TX', email: l.email || '—',
    linkedin: l.linkedin || '', specialty: l.specialty || '',
    stage: STAGES.includes(l.stage) ? l.stage : 'New', value: Number(l.value) || 0,
    nextStep: l.nextStep || '', nextStepDue: l.nextStepDue || '',
    notes: Array.isArray(l.notes) ? l.notes : [], created: l.created || Date.now(),
    ...(l.actionStatus ? { actionStatus: l.actionStatus } : {}),
    ...(l.actionStage ? { actionStage: l.actionStage } : {}),
    ...(l.draft ? { draft: l.draft } : {}),
  };
}

function sanitizeUrl(u) {
  try {
    const url = new URL(String(u));
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch { return null; }
}

function rid() { return Math.random().toString(36).slice(2, 9); }
function errResult(msg) { return { result: 'Error: ' + msg, isError: true }; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
