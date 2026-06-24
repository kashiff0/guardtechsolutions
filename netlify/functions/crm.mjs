// KM-GTS cloud CRM store (Netlify Function + Netlify Blobs). Single-admin.
// GET  -> { leads:[...] }   (also the login check)
// POST -> { leads:[...] }   saves the array
// Auth: header `x-gts-pw` must equal site env var GTS_ADMIN_PW.
// Everything is wrapped so any failure returns a readable JSON error, never a raw 502.

const STORE = 'gts-crm';
const KEY = 'leads';

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
