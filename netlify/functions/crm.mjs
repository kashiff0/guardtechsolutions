// KM-GTS cloud CRM store (Netlify Function + Netlify Blobs). Single-admin.
// GET           -> { leads:[...] }   (also the login check)
// POST          -> { leads:[...] }   saves the array
// POST ?seed=1  -> merges the canonical 30 leads from seed-leads.json into the store.
//                  Dedupes by company|contact (lowercased). Adds missing as stage "New" /
//                  nextStep "First call". NEVER changes the stage or next-step of existing
//                  leads. Idempotent. Returns { added, skipped, totalNow }.
// Auth: header `x-gts-pw` must equal site env var GTS_ADMIN_PW.
// Everything is wrapped so any failure returns a readable JSON error, never a raw 502.

import SEED from './seed-leads.json' with { type: 'json' };

const STORE = 'gts-crm';
const KEY = 'leads';

const norm = (l) => (((l && l.company) || '') + '|' + ((l && l.contact) || '')).toLowerCase().trim();
const uid = () => Math.random().toString(36).slice(2, 9);

export default async (req) => {
  try {
    const pw = req.headers.get('x-gts-pw') || '';
    const expected = process.env.GTS_ADMIN_PW || '';
    if (!expected || pw !== expected) {
      return json({ error: 'unauthorized' }, 401);
    }

    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: STORE, consistency: 'strong' });

    if (req.method === 'GET') {
      const leads = (await store.get(KEY, { type: 'json' })) || [];
      return json({ leads });
    }
    if (req.method === 'POST') {
      const url = new URL(req.url);
      // One-shot seed/merge route: POST /.netlify/functions/crm?seed=1
      if (url.searchParams.get('seed')) {
        const leads = (await store.get(KEY, { type: 'json' })) || [];
        const have = new Set(leads.map(norm));
        const added = [];
        for (const l of SEED) {
          const k = norm(l);
          if (have.has(k)) continue;          // existing lead: leave stage/next-step untouched
          have.add(k);
          leads.push({
            id: uid(),
            company: l.company || '',
            contact: l.contact || '—',
            title: l.title || '',
            phone: l.phone || '',
            city: l.city || 'Houston, TX',
            email: l.email || '',
            linkedin: l.linkedin || '',
            specialty: l.specialty || '',
            stage: 'New',
            value: Number(l.value) || 0,
            nextStep: 'First call',
            nextStepDue: '',
            notes: l.note ? [{ t: l.note, when: Date.now() }] : [],
            created: Date.now(),
          });
          added.push(l.contact);
        }
        if (added.length) await store.setJSON(KEY, leads);
        return json({ added: added.length, skipped: SEED.length - added.length, totalNow: leads.length, addedNames: added });
      }
      const body = await req.json().catch(() => ({}));
      const leads = Array.isArray(body && body.leads) ? body.leads : [];
      await store.setJSON(KEY, leads);
      return json({ ok: true, count: leads.length });
    }
    return new Response('method not allowed', { status: 405 });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
