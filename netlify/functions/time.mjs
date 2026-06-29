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
//   - ADMIN/OWNER: header `x-gts-pw` === GTS_ADMIN_PW (operator) or GTS_OWNER_PW
//                  (owner Kenrick M.) -> full read + config/review writes. The owner
//                  uses this to approve/reject timesheets from his summary view.
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
      const admin = process.env.GTS_ADMIN_PW || '';
      const owner = process.env.GTS_OWNER_PW || '';
      const pw = req.headers.get('x-gts-pw') || '';
      return (admin && pw === admin) || (owner && pw === owner);
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
          if (!loc) return json({ error: 'location-required' }, 422);   // GPS is mandatory

          const today = new Date().toISOString().slice(0, 10);
          const shift = d.shifts.find((s) => s.empId === emp.id && s.date === today);
          const geocoded = d.sites.filter(hasCoords);

          // Determine the post this punch belongs to: scheduled shift first, else nearest geocoded post.
          let site = null, shiftId = null;
          if (shift) { site = d.sites.find((s) => s.name === shift.site) || { name: shift.site }; shiftId = shift.id; }
          else { site = nearestSite(geocoded, loc); }

          // ENFORCE the geofence — a guard can only clock in while physically at the post.
          if (site && hasCoords(site)) {
            const distance = Math.round(haversine(loc.lat, loc.lng, site.lat, site.lng));
            if (distance > (site.radius || 150) + grace(loc))
              return json({ error: 'outside-geofence', site: site.name, distance, radius: site.radius || 150 }, 403);
          }

          const entry = {
            id: uid(), empId: emp.id, in: now, out: null, breaks: [],
            inLoc: loc, outLoc: null, site: site ? site.name : null, shiftId,
            status: 'pending', flags: [], reviewNote: '',
          };
          // Can't enforce when a post isn't geocoded yet — allow but flag loudly so the admin fixes it.
          if (site && !hasCoords(site)) addFlag(entry, `Assigned post "${site.name}" has no geofence set`);
          else if (!geocoded.length) addFlag(entry, 'No geofenced posts configured — location not verified');
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
          if (!loc) return json({ error: 'location-required' }, 422);   // GPS mandatory on clock-out too
          // ENFORCE the geofence on clock-out as well.
          const site = d.sites.find((s) => s.name === active.site);
          if (site && hasCoords(site)) {
            const distance = Math.round(haversine(loc.lat, loc.lng, site.lat, site.lng));
            if (distance > (site.radius || 150) + grace(loc))
              return json({ error: 'outside-geofence', site: site.name, distance, radius: site.radius || 150 }, 403);
          }
          if (openBreak) openBreak.end = now; // auto-close a dangling break
          active.out = now;
          active.outLoc = loc;
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

function hasCoords(s) { return s && typeof s.lat === 'number' && typeof s.lng === 'number'; }
// GPS accuracy grace so a legit guard with a weak fix isn't wrongly blocked (capped at 100m).
function grace(loc) { return Math.min((loc && loc.acc) || 0, 100); }
// Nearest geocoded post to a location (or null if none are geocoded).
function nearestSite(geocoded, loc) {
  let best = null, bestDist = Infinity;
  for (const s of geocoded) {
    const dist = haversine(loc.lat, loc.lng, s.lat, s.lng);
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  return best;
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
