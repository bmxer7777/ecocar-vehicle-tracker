// Settings panel (the gear, top right).
//
// Where saves go:
//   ?demo           -> nowhere; changes apply to this page only so people can play with it
//   tracker Mac     -> the local tracker (http://localhost:8765), which publishes to GitHub
//   public page     -> straight to the repo's tracker-data branch, using a GitHub token that
//                      the person pastes once ("unlock editing"). Without a token it's view-only.

(function () {
    const T = window.Tracker;
    const LOCAL = T.local && !T.demo;   // running on the tracker Mac (demo mode never touches the tracker)
    const $ = id => document.getElementById(id);
    const esc = T.esc;
    const TOKEN_KEY = () => `tracker-token:${T.publishTarget?.repo || ''}`;

    let places = { places: [], events: [] };
    let draft = null;          // working copy of the config being edited
    let local = null;          // /api/state from the tracker Mac
    let pollTimer = null;
    let dirty = false;

    // ---------- token storage (public page only) ----------
    function getToken() {
        try { return sessionStorage.getItem(TOKEN_KEY()) || localStorage.getItem(TOKEN_KEY()) || ''; } catch (e) { return ''; }
    }
    function setToken(token, remember) {
        try {
            sessionStorage.removeItem(TOKEN_KEY());
            localStorage.removeItem(TOKEN_KEY());
            if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY(), token);
        } catch (e) { /* storage blocked: the token only lives until the page closes */ memToken = token; }
    }
    let memToken = '';
    const token = () => getToken() || memToken;
    const canEdit = () => T.demo || LOCAL || !!token();

    // ---------- GitHub (public page) ----------
    async function gh(method, path, body) {
        const res = await fetch('https://api.github.com' + path, {
            method,
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                Authorization: 'Bearer ' + token(),
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    }
    function ghError(r) {
        if (r.status === 401) return 'GitHub rejected the key (expired or mistyped). Lock, then unlock with a new one.';
        if (r.status === 403 || r.status === 404) return `This key can't write to ${T.publishTarget.repo}. It needs "Contents: Read and write" on that repository.`;
        return `GitHub error ${r.status}: ${r.data?.message || ''}`;
    }

    // Replace config.json on the tracker-data branch, keeping location_history.json as it is.
    async function saveToGitHub(config) {
        const { repo, branch } = T.publishTarget;
        const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${branch}`);
        let baseTree = null;
        if (ref.status === 200) {
            const c = await gh('GET', `/repos/${repo}/git/commits/${ref.data.object.sha}`);
            if (c.status !== 200) throw new Error(ghError(c));
            baseTree = c.data.tree.sha;
        } else if (ref.status !== 404 && ref.status !== 409) {
            throw new Error(ghError(ref));
        }
        const files = [{ path: 'config.json', mode: '100644', type: 'blob', content: JSON.stringify(config, null, 2) }];
        if (!baseTree) files.push({ path: 'location_history.json', mode: '100644', type: 'blob', content: JSON.stringify({ locations: [] }) });
        const tree = await gh('POST', `/repos/${repo}/git/trees`, baseTree ? { base_tree: baseTree, tree: files } : { tree: files });
        if (tree.status !== 201) throw new Error(ghError(tree));
        const commit = await gh('POST', `/repos/${repo}/git/commits`, { message: `Settings changed on the web: ${config.trip?.event || ''}`, tree: tree.data.sha, parents: [] });
        if (commit.status !== 201) throw new Error(ghError(commit));
        const upd = ref.status === 200
            ? await gh('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: true })
            : await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.data.sha });
        if (upd.status !== 200 && upd.status !== 201) throw new Error(ghError(upd));
    }

    // ---------- tracker Mac API ----------
    async function api(path, body) {
        const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    // ---------- drawer ----------
    function build() {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <div class="scrim" id="set-scrim" hidden></div>
        <aside class="settings" id="settings" role="dialog" aria-modal="true" aria-labelledby="set-title" hidden>
            <div class="settings-head">
                <h2 id="set-title">Settings</h2>
                <button class="icon-btn" id="set-close" title="Close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
            <div class="settings-body" id="set-body"></div>
            <div class="settings-foot">
                <button class="btn primary" id="set-save">Save changes</button>
                <button class="btn" id="set-cancel">Cancel</button>
                <span class="msg" id="set-msg"></span>
            </div>
        </aside>`;
        document.body.append(...wrap.children);
        $('set-close').addEventListener('click', close);
        $('set-cancel').addEventListener('click', close);
        $('set-scrim').addEventListener('click', close);
        $('set-save').addEventListener('click', save);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('settings').hidden) close(); });
    }

    async function open() {
        if (!$('settings')) build();
        if (!places.places.length) places = await fetch('data/places.json').then(r => r.json()).catch(() => ({ places: [], events: [] }));
        draft = structuredClone(T.data?.config || {});
        draft.trip ??= { mode: 'idle', stops: [] };
        draft.trip.stops ??= [];
        dirty = false;
        if (LOCAL) await refreshLocal();
        render();
        $('set-scrim').hidden = false;
        $('settings').hidden = false;
        $('set-close').focus();
        if (LOCAL) pollTimer = setInterval(async () => { await refreshLocal(); renderLocalStatus(); }, 10000);
    }

    function close() {
        if (dirty && !confirm('Discard your unsaved changes?')) return;
        $('settings').hidden = true;
        $('set-scrim').hidden = true;
        clearInterval(pollTimer);
        dirty = false;
        $('settings-btn').focus();
    }

    function say(text, kind = '') { const el = $('set-msg'); el.textContent = text; el.className = 'msg ' + kind; }
    function markDirty() { dirty = true; say(''); }

    // ---------- render ----------
    function render() {
        const body = $('set-body');
        body.innerHTML = '';
        if (T.demo) body.append(section('Demo mode', `<p class="hint" style="margin:0">Try anything. Changes apply to this page only and aren't saved.</p>`));
        else if (!LOCAL) body.append(accessSection());
        if (LOCAL) body.append(trackerSection());
        body.append(tripSection(), vehicleSection(), appearanceSection());
        if (LOCAL) body.append(publishSection());
        body.append(advancedSection());
        $('set-save').disabled = !canEdit();
        $('set-save').textContent = canEdit() ? 'Save changes' : 'Unlock editing to save';
        say('');
    }

    function section(title, html, badge = '') {
        const s = document.createElement('section');
        s.className = 'card';
        s.innerHTML = `<h3>${esc(title)}${badge}</h3>${html}`;
        return s;
    }

    function accessSection() {
        if (!T.publishTarget) {
            return section('Editing', `<p class="hint" style="margin:0">This copy isn't connected to a GitHub repo yet, so settings can only be changed from the tracker Mac.</p>`);
        }
        if (token()) {
            const s = section('Editing', `<p class="hint">Unlocked on this browser. Saves go straight to <b>${esc(T.publishTarget.repo)}</b>.</p>
                <button class="btn small" id="lock-btn">Lock (forget the key)</button>`, '<span class="badge on">Unlocked</span>');
            s.querySelector('#lock-btn').addEventListener('click', () => { setToken(''); memToken = ''; render(); });
            return s;
        }
        const s = section('Editing', `
            <div class="lock-note">Anyone can view this page. To change it, paste the team's GitHub key (a fine-grained token with <b>Contents: Read and write</b> on <b>${esc(T.publishTarget.repo)}</b>; see README step 3).</div>
            <label class="field" for="unlock-token">GitHub key</label>
            <input type="password" id="unlock-token" autocomplete="off" placeholder="github_pat_…">
            <label style="display:flex;gap:8px;align-items:center;font-size:.85rem;margin-top:8px"><input type="checkbox" id="unlock-remember"> Remember on this device (only on your own computer)</label>
            <div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn primary small" id="unlock-btn">Unlock editing</button><span class="msg" id="unlock-msg"></span></div>`,
            '<span class="badge">View only</span>');
        s.querySelector('#unlock-btn').addEventListener('click', async () => {
            const val = s.querySelector('#unlock-token').value.trim();
            const msg = s.querySelector('#unlock-msg');
            if (!val) return;
            memToken = val;
            setToken(val, s.querySelector('#unlock-remember').checked);
            msg.textContent = 'Checking…'; msg.className = 'msg';
            const r = await gh('GET', `/repos/${T.publishTarget.repo}`);
            if (r.status !== 200) { setToken(''); memToken = ''; msg.textContent = ghError(r); msg.className = 'msg err'; return; }
            render();
            say('Editing unlocked.', 'ok');
        });
        return s;
    }

    function tripSection() {
        const t = draft.trip;
        const events = places.events || [];
        const custom = t.event && !events.includes(t.event);
        const s = section('Trip', `
            <label class="field" for="f-event">Event</label>
            <div class="row">
                <select id="f-event">${events.map(e => `<option ${e === t.event ? 'selected' : ''}>${esc(e)}</option>`).join('')}<option value="__custom" ${custom ? 'selected' : ''}>Other…</option></select>
                <input type="text" id="f-event-custom" placeholder="Event name" value="${custom ? esc(t.event) : ''}" ${custom ? '' : 'hidden'}>
            </div>
            <label class="field">What is the vehicle doing?</label>
            <div class="segmented" role="radiogroup">
                ${[['driving', 'Driving'], ['parked', 'At the event'], ['idle', 'Not traveling']].map(([v, l]) =>
                    `<label><input type="radio" name="f-mode" value="${v}" ${t.mode === v ? 'checked' : ''}>${l}</label>`).join('')}
            </div>
            <div id="f-places"></div>
            <div id="f-addstop-row" style="margin-top:8px"><button class="btn small" id="f-addstop">+ Add a stop</button> <span class="hint">hotel, charging break, test site…</span></div>
            <div class="row">
                <div><label class="field" for="f-departure">Departure (your time)</label><input type="datetime-local" id="f-departure" value="${toLocalInput(t.departure)}"></div>
                <div><label class="field" for="f-radius">"Arrived" within (miles)</label><input type="number" id="f-radius" min="0.1" max="20" step="0.25" value="${t.arrival_radius_miles || 0.75}"></div>
            </div>
            ${LOCAL ? `<div style="margin-top:14px"><button class="btn small" id="f-newtrip">Start a new trip (clear the map's dots)</button></div>` : ''}`);
        const eventSel = s.querySelector('#f-event'), eventCustom = s.querySelector('#f-event-custom');
        const setEvent = () => { t.event = eventSel.value === '__custom' ? eventCustom.value.trim() : eventSel.value; markDirty(); };
        eventSel.addEventListener('change', () => { eventCustom.hidden = eventSel.value !== '__custom'; setEvent(); });
        eventCustom.addEventListener('input', setEvent);
        s.querySelectorAll('input[name=f-mode]').forEach(r => r.addEventListener('change', () => { t.mode = r.value; markDirty(); renderPlaces(s); }));
        s.querySelector('#f-addstop').addEventListener('click', () => { t.stops.push(null); markDirty(); renderPlaces(s); });
        s.querySelector('#f-departure').addEventListener('input', e => { t.departure = e.target.value ? new Date(e.target.value).toISOString() : ''; markDirty(); });
        s.querySelector('#f-radius').addEventListener('input', e => { t.arrival_radius_miles = parseFloat(e.target.value) || 0.75; markDirty(); });
        s.querySelector('#f-newtrip')?.addEventListener('click', async () => {
            if (!confirm('Start a new trip? Pings recorded so far are saved to tracker/archive/ on this Mac, then the map is cleared.')) return;
            await api('/api/new-trip', {});
            await T.refresh();
            say('New trip started.', 'ok');
        });
        renderPlaces(s);
        return s;
    }

    function toLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    function renderPlaces(s) {
        const t = draft.trip, wrap = s.querySelector('#f-places');
        wrap.innerHTML = '';
        const parked = t.mode === 'parked';
        if (!parked) wrap.append(placeCard('Start', () => t.origin, v => { t.origin = v; }));
        if (!parked) t.stops.forEach((_, i) => wrap.append(placeCard(`Stop ${i + 1}`, () => t.stops[i], v => { t.stops[i] = v; }, () => { t.stops.splice(i, 1); markDirty(); renderPlaces(s); })));
        wrap.append(placeCard(parked ? 'Venue' : 'Destination', () => t.destination, v => { t.destination = v; }));
        s.querySelector('#f-addstop-row').hidden = parked;
    }

    function placeCard(title, get, set, remove) {
        const div = document.createElement('div');
        div.className = 'place';
        const draw = () => {
            const p = get();
            div.innerHTML = `
                <div class="place-head"><span>${esc(title)}</span>${remove ? '<button class="btn link small" data-remove>Remove</button>' : ''}</div>
                <div class="place-chosen ${p ? '' : 'empty'}">${p ? esc(p.name) : 'Not set'}</div>
                <div class="place-pick">
                    <select data-saved aria-label="${esc(title)}: saved places"><option value="">Saved places…</option>${places.places.map((pl, i) => `<option value="${i}">${esc(pl.name)}</option>`).join('')}</select>
                    <input type="search" data-search aria-label="${esc(title)}: search an address" placeholder="Search address, press Enter">
                </div>
                <div class="results" data-results></div>`;
            div.querySelector('[data-remove]')?.addEventListener('click', remove);
            div.querySelector('[data-saved]').addEventListener('change', e => {
                if (e.target.value === '') return;
                set({ ...places.places[+e.target.value] }); markDirty(); draw();
            });
            const search = div.querySelector('[data-search]'), results = div.querySelector('[data-results]');
            search.addEventListener('keydown', async e => {
                if (e.key !== 'Enter' || !search.value.trim()) return;
                e.preventDefault();
                results.innerHTML = '<span class="hint">Searching…</span>';
                try {
                    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us,ca&q=${encodeURIComponent(search.value)}`);
                    const list = await r.json();
                    results.innerHTML = list.length ? '' : '<span class="hint">No matches. Try adding the city and state.</span>';
                    list.forEach(hit => {
                        const b = document.createElement('button');
                        b.className = 'btn small';
                        b.textContent = hit.display_name;
                        b.addEventListener('click', () => {
                            const typed = search.value.trim();
                            set({ name: typed.length > 3 ? typed : hit.display_name.split(',').slice(0, 3).join(','), lat: +(+hit.lat).toFixed(5), lng: +(+hit.lon).toFixed(5) });
                            markDirty(); draw();
                        });
                        results.appendChild(b);
                    });
                } catch (err) { results.innerHTML = '<span class="msg err">Address search failed. Are you online?</span>'; }
            });
        };
        draw();
        return div;
    }

    function vehicleSection() {
        draft.vehicle ??= {};
        draft.team ??= {};
        const v = draft.vehicle, tm = draft.team;
        const teams = T.teams.teams || [];
        const s = section('Vehicle & team', `
            <div class="row">
                <div><label class="field" for="f-vname">Short name</label><input type="text" id="f-vname" value="${esc(v.name || '')}" placeholder="Blazer"></div>
                <div><label class="field" for="f-vcolor">Map color</label><input type="color" id="f-vcolor" value="${esc(v.color || '#02539E')}"></div>
            </div>
            <label class="field" for="f-vfull">Full name</label><input type="text" id="f-vfull" value="${esc(v.full_name || '')}" placeholder="2026 Chevrolet Blazer EV">
            <label class="field" for="f-team">Home team</label>
            <select id="f-team">${teams.map(x => `<option value="${esc(x.id)}" ${x.id === tm.id ? 'selected' : ''}>${esc(x.short)} (${x.track === 'gm' ? 'GM' : 'Stellantis'} track)</option>`).join('')}<option value="" ${tm.id ? '' : 'selected'}>Other / not listed</option></select>
            <label class="field" for="f-logo">Header logo (optional)</label><input type="text" id="f-logo" value="${esc(tm.logo || '')}" placeholder="assets/team-logo.png">`);
        const bind = (id, fn) => s.querySelector(id).addEventListener('input', e => { fn(e.target.value); markDirty(); });
        bind('#f-vname', x => { v.name = x.trim(); });
        bind('#f-vcolor', x => { v.color = x; });
        bind('#f-vfull', x => { v.full_name = x.trim(); });
        bind('#f-logo', x => { tm.logo = x.trim(); });
        s.querySelector('#f-team').addEventListener('change', e => {
            const t = teams.find(x => x.id === e.target.value);
            tm.id = e.target.value;
            if (t) tm.name = t.name;
            markDirty();
        });
        return s;
    }

    function appearanceSection() {
        const cur = T.themeChoice();
        const s = section('Appearance', `
            <p class="hint">Just for you, on this device. Nothing to save.</p>
            <div class="segmented" role="radiogroup" aria-label="Theme">
                ${[['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<label><input type="radio" name="f-theme" value="${v}" ${cur === v ? 'checked' : ''}>${l}</label>`).join('')}
            </div>`);
        s.querySelectorAll('input[name=f-theme]').forEach(r => r.addEventListener('change', () => T.setTheme(r.value)));
        return s;
    }

    function advancedSection() {
        draft.map ??= {};
        const s = section('Map extras', `
            <label class="field" for="f-nrel">Charger lookup key (optional)</label>
            <input type="text" id="f-nrel" value="${esc(draft.map.nrel_api_key && draft.map.nrel_api_key !== 'DEMO_KEY' ? draft.map.nrel_api_key : '')}" placeholder="DEMO_KEY (shared, 10 lookups/hour)">
            <p class="hint" style="margin-top:6px">A free key from the DOE station locator lets many viewers load the ⚡ charger layer.</p>`);
        s.querySelector('#f-nrel').addEventListener('input', e => { draft.map.nrel_api_key = e.target.value.trim() || 'DEMO_KEY'; markDirty(); });
        return s;
    }

    // ---------- tracker Mac sections ----------
    async function refreshLocal() {
        try { local = await api('/api/state'); } catch (e) { local = null; }
    }

    function trackerSection() {
        const s = section('Tracker on this Mac', `
            <div class="switch-row">
                <label class="switch"><input type="checkbox" id="l-tracking"><span></span></label>
                <b id="l-tracking-label">Tracking is OFF</b>
                <button class="btn small" id="l-check" style="margin-left:auto">Check now</button>
            </div>
            <div class="mini-stats">
                <div><b>AirTag</b><span id="l-airtag">not chosen</span></div>
                <div><b>Last AirTag fix</b><span id="l-fix">--</span></div>
                <div><b>Last published</b><span id="l-pub">never</span></div>
                <div><b>Updates this trip</b><span id="l-pings">0</span></div>
            </div>
            <div class="msg err" id="l-error" style="margin-top:8px"></div>
            <label class="field">AirTag in the vehicle</label>
            <p class="hint">Lists this Mac's Find My items. The AirTag must belong to, or be shared with, this Mac's Apple ID.</p>
            <button class="btn primary small" id="l-find">Find AirTags</button>
            <div class="msg" id="l-items-msg" style="margin-top:8px"></div>
            <div class="items" id="l-items"></div>
            <details style="margin-top:12px"><summary class="hint" style="cursor:pointer">Activity log</summary><pre class="log" id="l-log"></pre></details>`);
        s.querySelector('#l-tracking').addEventListener('change', async e => {
            await api('/api/tracking', { on: e.target.checked });
            await refreshLocal(); renderLocalStatus();
        });
        s.querySelector('#l-check').addEventListener('click', async () => { await api('/api/check-now', {}); setTimeout(async () => { await refreshLocal(); renderLocalStatus(); T.refresh(); }, 8000); });
        s.querySelector('#l-find').addEventListener('click', () => findAirTags(s));
        queueMicrotask(renderLocalStatus);
        return s;
    }

    function renderLocalStatus() {
        if (!$('l-tracking')) return;
        if (!local) { $('l-error').textContent = 'Lost contact with the tracker. Is Start Tracker still running?'; return; }
        const st = local.settings, stat = local.status;
        $('l-tracking').checked = !!st.tracking;
        $('l-tracking-label').textContent = st.tracking ? 'Tracking is ON' : 'Tracking is OFF';
        $('l-airtag').textContent = st.airtag_name || 'not chosen';
        $('l-fix').textContent = stat.last_fix ? T.fmtAgo(Date.now() - stat.last_fix * 1000) : '--';
        $('l-pub').textContent = stat.last_publish ? T.fmtAgo(Date.now() - stat.last_publish * 1000) : 'never';
        $('l-pings').textContent = local.pings;
        $('l-error').textContent = stat.last_error || '';
        const log = $('l-log');
        log.textContent = local.log.join('\n');
        log.scrollTop = log.scrollHeight;
    }

    async function findAirTags(s) {
        const msg = s.querySelector('#l-items-msg'), list = s.querySelector('#l-items');
        msg.textContent = 'Reading Find My…'; msg.className = 'msg';
        list.innerHTML = '';
        try {
            const { items } = await api('/api/items');
            if (!items.length) { msg.textContent = 'Find My has no items on this Mac. Open the Find My app, check the Items tab, and try again.'; msg.className = 'msg warn'; return; }
            msg.textContent = 'Pick the one that is in the vehicle.';
            items.forEach(it => {
                const chosen = it.id === local?.settings.airtag_id;
                const where = [it.address?.locality, it.address?.administrativeArea].filter(Boolean).join(', ');
                const div = document.createElement('div');
                div.className = 'item' + (chosen ? ' chosen' : '');
                div.innerHTML = `<div class="emoji">${esc(it.emoji)}</div>
                    <div class="info"><div class="name">${esc(it.name)} <span class="badge">${it.kind === 'item' ? 'AirTag / item' : 'Apple device'}</span></div>
                    <div class="meta">${it.latitude == null ? 'No location right now' : esc(where || `${it.latitude.toFixed(4)}, ${it.longitude.toFixed(4)}`) + ' · seen ' + T.fmtAgo(Date.now() - it.timestamp * 1000)}</div></div>
                    <button class="btn small ${chosen ? '' : 'primary'}">${chosen ? 'Chosen ✓' : 'Use this'}</button>`;
                div.querySelector('button').addEventListener('click', async () => {
                    await api('/api/settings', { airtag_id: it.id, airtag_name: it.name });
                    await refreshLocal(); renderLocalStatus(); findAirTags(s);
                });
                list.appendChild(div);
            });
        } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
    }

    function publishSection() {
        const st = local?.settings || {};
        const s = section('Publishing to GitHub', `
            <p class="hint">Where the public page lives. The key is stored only on this Mac.</p>
            <label class="field" for="p-repo">Repository (owner/name)</label>
            <input type="text" id="p-repo" value="${esc(st.repo || '')}" placeholder="erau-ecocar/ecocar-vehicle-tracker">
            <label class="field" for="p-token">GitHub key</label>
            <input type="password" id="p-token" autocomplete="off" placeholder="${st.token_set ? '•••••••• saved (leave blank to keep)' : st.gh_cli ? 'optional: using your GitHub CLI login' : 'github_pat_…'}">
            <div class="row">
                <div><label class="field" for="p-interval">Check Find My every (min)</label><input type="number" id="p-interval" min="1" max="60" value="${st.interval_minutes || 2}"></div>
                <div></div>
            </div>
            <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <button class="btn primary small" id="p-save">Save & test connection</button>
                <a id="p-token-link" target="_blank" rel="noopener">Make a key on GitHub ↗</a>
            </div>
            <div class="msg" id="p-msg" style="margin-top:8px"></div>
            ${local?.public_url ? `<p class="hint" style="margin-top:8px">Public page: <a href="${esc(local.public_url)}" target="_blank" rel="noopener">${esc(local.public_url)}</a></p>` : ''}`);
        const link = s.querySelector('#p-token-link');
        const updateLink = () => {
            const owner = s.querySelector('#p-repo').value.trim().split('/')[0];
            const q = new URLSearchParams({ name: `EcoCAR tracker (${new Date().getFullYear()})`, description: 'Lets the vehicle tracker publish updates', expires_in: '366', contents: 'write' });
            if (owner) q.set('target_name', owner);
            link.href = 'https://github.com/settings/personal-access-tokens/new?' + q;
        };
        updateLink();
        s.querySelector('#p-repo').addEventListener('input', updateLink);
        s.querySelector('#p-save').addEventListener('click', async () => {
            const msg = s.querySelector('#p-msg');
            msg.textContent = 'Saving…'; msg.className = 'msg';
            try {
                const body = { repo: s.querySelector('#p-repo').value.trim(), interval_minutes: parseInt(s.querySelector('#p-interval').value, 10) || 2 };
                const tok = s.querySelector('#p-token').value.trim();
                if (tok) body.token = tok;
                await api('/api/settings', body);
                s.querySelector('#p-token').value = '';
                msg.textContent = 'Testing the connection to GitHub…';
                const r = await api('/api/test-publish', {});
                await refreshLocal(); renderLocalStatus();
                msg.textContent = r.ok ? 'Connected ✓ The public page picks up changes within a few minutes.' : r.error;
                msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
            } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
        });
        return s;
    }

    // ---------- save ----------
    async function save() {
        const t = draft.trip;
        if (t.mode !== 'idle' && !t.destination) return say(t.mode === 'parked' ? 'Set the venue first.' : 'Set a destination first.', 'err');
        if (t.mode === 'driving' && !t.origin) return say('Set where the trip starts.', 'err');
        if (!t.event) return say('Give the event a name.', 'err');
        t.stops = t.stops.filter(Boolean);
        draft.updated_at = new Date().toISOString();
        $('set-save').disabled = true;
        say('Saving…');
        try {
            if (T.demo) {
                T.configOverride = structuredClone(draft);
            } else if (LOCAL) {
                const r = await api('/api/config', { config: draft });
                if (local?.settings.repo && !r.published) say('Saved on this Mac, but publishing failed. See the error under "Tracker on this Mac".', 'warn');
            } else {
                draft.publish = { ...T.publishTarget };
                await saveToGitHub(draft);
                T.configOverride = structuredClone(draft);
            }
            dirty = false;
            await T.refresh();
            if (!$('set-msg').textContent.startsWith('Saved on this Mac')) {
                say(T.demo ? 'Applied (demo only, not saved).' : LOCAL ? 'Saved ✓' : 'Saved ✓ Everyone sees it within a few minutes.', 'ok');
            }
            draft = structuredClone(T.data.config);
            draft.trip.stops ??= [];
            if (LOCAL) { await refreshLocal(); renderLocalStatus(); }
        } catch (e) {
            say(e.message, 'err');
        } finally {
            $('set-save').disabled = !canEdit();
        }
    }

    // ---------- wire up ----------
    $('settings-btn').addEventListener('click', open);
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('tracker-ready', async () => {
        const want = new URLSearchParams(location.search).has('settings');
        let firstRun = false;
        if (LOCAL) { await refreshLocal(); firstRun = local && !local.settings.airtag_id; }
        if (want || firstRun) open();
    });
})();
