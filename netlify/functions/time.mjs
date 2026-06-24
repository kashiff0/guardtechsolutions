// KM-GTS cloud time-clock store (Netlify Function + Netlify Blobs).
// Replaces Connecteam's time clock: real, multi-device, attributable punches.
//
// Single JSON doc in blob `gts-time` key `data`:
//   { employees:[{id,name,title,pin,rate,active}],
//     entries:[{id,empId,in,out,breaks:[{start,end}],inLoc,outLoc,site,shiftId,status,flags,reviewNote}],
//     shifts:[{id,empId,date,start,end,site}],
//     sites:[{id,name,lat,lng,radius}] }
//
// Two auth paths:
//   - ADMIN: header `x-gts-pw` === GTS_ADMIN_PW  -> full read + config/review writes.
//   - GUARD: body { empId, pin } validated against employees -> read-own + punch only.
//
// Punches mutate server-side (read-modify-write) so concurrent guards never clobber.
// Admin config (employees/shifts/sites) is a full-array replace; entries are NEVER
// full-replaced — only targeted server-side mutations touch them, avoiding clobber.
//
// Routes:
//   GET  ?roster=1                 -> { roster:[{id,name,title}] }   (public, for login screen)
//   GET  (admin pw)                -> full snapshot { employees,entries,shifts,sites }
//   POST { action:'login', empId, pin }                  -> { ok, employee, entries, shifts, sites }
//   POST { action:'punch', empId, pin, type, loc }       -> { ok, entries }   type: in|break_start|break_end|out
//   POST { action:'review', entryId, status, note }      -> admin: approve|reject|flag a punch
//   POST { action:'config', employees?, shifts?, sites? } -> admin: replace provided config arrays

const STORE = 'gts-time';
const KEY = 'data';
const EMPTY = { employees: [], entries: [], shifts: [], sites: [] };

export default async (req) => {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: STORE, consistency: 'strong' });
    const url = new URL(req.url);

    const read = async () => ({ ...EMPTY, ...((await store.get(KEY, { type: 'json' })) || {}) });
    const write = (d) => store.setJSON(KEY, d);
    const isAdmin = () => {
      const expected = process.env.GTS_ADMIN_PW || '';
      return expected && (req.headers.get('x-gts-pw') || '') === expected;
    };

    // --- public roster (login screen needs names before anyone is authed) ---
    if (req.method === 'GET' && url.searchParams.get('roster')) {
      const d = await read();
      const roster = d.employees.filter((e) => e.active !== false).map((e) => ({ id: e.id, name: e.name, title: e.title }));
      return json({ roster });
    }

    // --- admin full snapshot ---
    if (req.method === 'GET') {
      if (!isAdmin()) return json({ error: 'unauthorized' }, 401);
      return json(await read());
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const action = body.action;

      // ===== GUARD: login =====
      if (action === 'login') {
        const d = await read();
        const emp = d.employees.find((e) => e.id === body.empId && e.active !== false);
        if (!emp || String(emp.pin) !== String(body.pin)) return json({ error: 'bad-credentials' }, 401);
        return json({
          ok: true,
          employee: { id: emp.id, name: emp.name, title: emp.title, rate: emp.rate },
          entries: d.entries.filter((t) => t.empId === emp.id),
          shifts: d.shifts.filter((s) => s.empId === emp.id),
          sites: d.sites,
        });
      }

      // ===== GUARD: punch (server-side mutation) =====
      if (action === 'punch') {
        const d = await read();
        const emp = d.employees.find((e) => e.id === body.empId && e.active !== false);
        if (!emp || String(emp.pin) !== String(body.pin)) return json({ error: 'bad-credentials' }, 401);

        const now = Date.now();
        const loc = sanitizeLoc(body.loc);
        const active = d.entries.find((t) => t.empId === emp.id && !t.out);

        if (body.type === 'in') {
          if (active) return json({ error: 'already-clocked-in' }, 409);
          const site = resolveSite(d, emp.id, loc);
          const entry = {
            id: uid(), empId: emp.id, in: now, out: null, breaks: [],
            inLoc: loc, outLoc: null, site: site ? site.name : null,
            shiftId: site ? site.shiftId || null : null,
            status: 'pending', flags: [], reviewNote: '',
          };
          if (site) geofenceFlag(entry, site, loc, 'in');
          d.entries.push(entry);
          await write(d);
          return json({ ok: true, entries: d.entries.filter((t) => t.empId === emp.id) });
        }

        if (!active) return json({ error: 'not-clocked-in' }, 409);
        const openBreak = active.breaks.find((b) => !b.end);

        if (body.type === 'break_start') {
          if (openBreak) return json({ error: 'already-on-break' }, 409);
          active.breaks.push({ start: now, end: null });
        } else if (body.type === 'break_end') {
          if (!openBreak) return json({ error: 'not-on-break' }, 409);
          openBreak.end = now;
        } else if (body.type === 'out') {
          if (openBreak) openBreak.end = now; // auto-close a dangling break
          active.out = now;
          active.outLoc = loc;
          const site = d.sites.find((s) => s.name === active.site);
          if (site) geofenceFlag(active, site, loc, 'out');
        } else {
          return json({ error: 'bad-punch-type' }, 400);
        }
        await write(d);
        return json({ ok: true, entries: d.entries.filter((t) => t.empId === emp.id) });
      }

      // ===== ADMIN: review a punch (approve / reject / flag) =====
      if (action === 'review') {
        if (!isAdmin()) return json({ error: 'unauthorized' }, 401);
        const d = await read();
        const entry = d.entries.find((t) => t.id === body.entryId);
        if (!entry) return json({ error: 'not-found' }, 404);
        if (!['approved', 'rejected', 'flagged', 'pending'].includes(body.status)) return json({ error: 'bad-status' }, 400);
        entry.status = body.status;
        if (typeof body.note === 'string') entry.reviewNote = body.note;
        await write(d);
        return json({ ok: true, entry });
      }

      // ===== ADMIN: replace config arrays (employees / shifts / sites) =====
      if (action === 'config') {
        if (!isAdmin()) return json({ error: 'unauthorized' }, 401);
        const d = await read();
        if (Array.isArray(body.employees)) d.employees = body.employees;
        if (Array.isArray(body.shifts)) d.shifts = body.shifts;
        if (Array.isArray(body.sites)) d.sites = body.sites;
        await write(d);
        return json({ ok: true, employees: d.employees.length, shifts: d.shifts.length, sites: d.sites.length });
      }

      return json({ error: 'bad-action' }, 400);
    }

    return new Response('method not allowed', { status: 405 });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

// Resolve which post a clock-in belongs to: today's scheduled shift first, else
// nearest site within its geofence radius. Returns the site (+shiftId) or null.
function resolveSite(d, empId, loc) {
  const today = new Date().toISOString().slice(0, 10);
  const shift = d.shifts.find((s) => s.empId === empId && s.date === today);
  if (shift) {
    const site = d.sites.find((s) => s.name === shift.site);
    return site ? { ...site, shiftId: shift.id } : { name: shift.site, shiftId: shift.id };
  }
  if (loc && d.sites.length) {
    let best = null, bestDist = Infinity;
    for (const s of d.sites) {
      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue;
      const dist = haversine(loc.lat, loc.lng, s.lat, s.lng);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    if (best && bestDist <= (best.radius || 150)) return best;
  }
  return null;
}

// Flag an entry if the punch GPS is outside the site geofence.
function geofenceFlag(entry, site, loc, which) {
  if (typeof site.lat !== 'number' || typeof site.lng !== 'number') return;
  if (!loc) { addFlag(entry, `No GPS on clock-${which === 'in' ? 'in' : 'out'}`); return; }
  const dist = Math.round(haversine(loc.lat, loc.lng, site.lat, site.lng));
  if (dist > (site.radius || 150)) addFlag(entry, `Clock-${which} ${dist}m from ${site.name} (>${site.radius || 150}m)`);
}
function addFlag(entry, msg) { if (!entry.flags.includes(msg)) entry.flags.push(msg); }

function sanitizeLoc(loc) {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  return { lat: loc.lat, lng: loc.lng, acc: typeof loc.acc === 'number' ? Math.round(loc.acc) : null };
}

// Great-circle distance in meters.
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
