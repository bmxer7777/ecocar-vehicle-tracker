// EcoCAR Vehicle Tracker - public page
//
// Everything trip-specific comes from config.json, edited through the Settings panel (settings.js).
// Where the data is read from:
//   ?demo                     -> data/demo/ (made-up trip, for trying it out)
//   localhost / 127.0.0.1     -> data/live/ (the tracker Mac's working files)
//   GitHub Pages              -> the repo's "tracker-data" branch via raw.githubusercontent.com,
//                                so location updates never trigger a Pages rebuild.

const REFRESH_MS = 60 * 1000;
const STOP_RADIUS_MILES = 2;
const DEFAULT_COLOR = '#02539E';
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const STATES = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
    'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'District of Columbia': 'DC',
    'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL',
    'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA',
    'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
    'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR',
    'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
    'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA',
    'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
    'Ontario': 'ON', 'Quebec': 'QC'
};
const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));
const MODE_LABELS = { driving: 'En route', parked: 'At the event', idle: 'Not traveling' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let map, baseLayer, labelLayer;
const layers = {};
let lastRouteKey = null;
let plannedRoute = null;
let chargersLoadedFor = null;
let lastHomeId;
let lastFitKey = null;

// Shared with settings.js
const Tracker = window.Tracker = {
    demo: DEMO,
    local: IS_LOCAL,
    teams: { tracks: {}, teams: [] },
    data: null,              // last loaded { config, locations, source }
    configOverride: null,    // a just-saved (or demo-edited) config, used until the published copy catches up
    refresh: null,
    publishTarget: null,     // { repo, branch } for the public page
};

// ---------- data loading ----------

async function getJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

function repoFromPagesUrl() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const first = location.pathname.split('/').filter(Boolean)[0];
    return first ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
}

async function fetchTripData() {
    if (DEMO) {
        const [config, history] = await Promise.all([getJSON('data/demo/config.json'), getJSON('data/demo/location_history.json')]);
        return { config, locations: shiftDemoTimes(config, history.locations || []), source: 'demo' };
    }
    if (IS_LOCAL) {
        try {
            const [config, history] = await Promise.all([getJSON('data/live/config.json'), getJSON('data/live/location_history.json')]);
            return { config, locations: history.locations || [], source: 'live' };
        } catch (e) { /* tracker not set up yet: fall through to the template */ }
    }
    const siteConfig = await getJSON('data/config.json');
    if (!IS_LOCAL) {
        const repo = siteConfig.publish?.repo || repoFromPagesUrl();
        const branch = siteConfig.publish?.branch || 'tracker-data';
        Tracker.publishTarget = repo ? { repo, branch } : null;
        if (repo) {
            const base = `https://raw.githubusercontent.com/${repo}/${branch}/`;
            try {
                const [config, history] = await Promise.all([getJSON(base + 'config.json'), getJSON(base + 'location_history.json')]);
                return { config, locations: history.locations || [], source: 'github' };
            } catch (e) {
                console.warn('No published tracker data yet, using the settings bundled with the site.', e);
            }
        }
    }
    return { config: siteConfig, locations: [], source: 'template' };
}

async function loadTripData() {
    const data = await fetchTripData();
    // GitHub's raw file cache can lag a few minutes behind a save; keep showing the saved version until it catches up.
    const o = Tracker.configOverride;
    if (o && (DEMO || !data.config.updated_at || Date.parse(data.config.updated_at) < Date.parse(o.updated_at))) {
        data.config = structuredClone(o);
    } else {
        Tracker.configOverride = null;
    }
    return data;
}

// The demo file has fixed timestamps; slide them so the trip looks "live" right now.
function shiftDemoTimes(config, locations) {
    if (!locations.length) return locations;
    const shift = (Date.now() / 1000 - 240) - locations[locations.length - 1].timestamp;
    if (config.trip?.departure) {
        config.trip.departure = new Date((Date.parse(config.trip.departure) / 1000 + shift) * 1000).toISOString();
    }
    return locations.map(l => ({ ...l, timestamp: l.timestamp + shift }));
}

// ---------- geometry / routing ----------

function miles(a, b) {
    const R = 3958.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

const pt = l => ({ lat: l.latitude, lng: l.longitude });
const validPlace = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

const routeCache = new Map();
async function osrmRoute(points) {
    if (points.length < 2) return null;
    const key = points.map(p => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    if (routeCache.has(key)) return routeCache.get(key);
    try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.code === 'Ok' && data.routes?.[0]) {
            const r = data.routes[0];
            const out = { geometry: r.geometry.coordinates.map(c => [c[1], c[0]]), miles: r.distance / 1609.34, seconds: r.duration };
            routeCache.set(key, out);
            return out;
        }
    } catch (e) {
        console.warn('Routing failed', e);
    }
    return null;
}

// Keep pings at least `spacing` miles apart (and at most `max` of them) so the routing URL stays small.
function thin(points, spacing, max) {
    if (points.length <= 2) return points;
    let out = [points[0]];
    for (const p of points.slice(1)) if (miles(out[out.length - 1], p) >= spacing) out.push(p);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    while (out.length > max) out = out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
    return out;
}

function straightMiles(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += miles(points[i - 1], points[i]);
    return d;
}

// ---------- formatting ----------

const fmtDate = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = ms => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function fmtSpan(ms) {
    const mins = Math.max(0, Math.floor(ms / 60000));
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return { value: `${d}d ${h}h`, sub: `${m} min` };
    if (h > 0) return { value: `${h}h ${m}m`, sub: '' };
    return { value: `${m} min`, sub: '' };
}

function fmtAgo(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    if (h < 48) return `${h}h ${mins % 60}m ago`;
    return `${Math.floor(h / 24)} days ago`;
}
Object.assign(Tracker, { fmtAgo, fmtShort, esc });

function stateOf(loc) {
    const a = loc.address || {};
    const s = a.stateCode || a.administrativeArea;
    return STATES[s] || s || null;
}

function placeLabel(loc) {
    const a = loc.address || {};
    return { main: a.locality || a.subAdministrativeArea || `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`, sub: a.administrativeArea || '' };
}

// ---------- theme ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function themeChoice() {
    try { return localStorage.getItem('tracker-theme') || 'auto'; } catch (e) { return 'auto'; }
}
function isDark() {
    const t = themeChoice();
    return t === 'dark' || (t === 'auto' && darkQuery.matches);
}
function setTheme(choice) {
    try { choice === 'auto' ? localStorage.removeItem('tracker-theme') : localStorage.setItem('tracker-theme', choice); } catch (e) { /* private mode */ }
    if (choice === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    applyTheme();
}
Tracker.setTheme = setTheme;
Tracker.themeChoice = themeChoice;

function applyTheme() {
    const dark = isDark();
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    $('theme-icon').innerHTML = dark
        ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
        : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
    if (!map) return;
    // Esri's canvas basemaps need no API key. Base and labels are separate tile sets.
    const style = dark ? 'Dark_Gray' : 'Light_Gray';
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    baseLayer?.remove();
    labelLayer?.remove();
    baseLayer = L.tileLayer(`${esri}World_${style}_Base/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16
    }).addTo(map);
    labelLayer = L.tileLayer(`${esri}World_${style}_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: 'labels' }).addTo(map);
    if (Tracker.data) redrawRouteStyles();
}

// ---------- map ----------

function initMap() {
    map = L.map('map', { zoomControl: true, maxZoom: 16 }).setView([37.5, -92], 4);
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;          // above routes, below markers
    map.getPane('labels').style.pointerEvents = 'none';

    for (const name of ['route', 'traveled', 'trail', 'places', 'gm', 'stellantis', 'home', 'chargers', 'current']) {
        layers[name] = L.layerGroup();
    }
    for (const name of ['route', 'traveled', 'trail', 'places', 'gm', 'stellantis', 'home', 'current']) layers[name].addTo(map);

    const bind = (id, layer, onEnable) => $(id).addEventListener('change', e => {
        if (e.target.checked) { layer.addTo(map); onEnable?.(); } else map.removeLayer(layer);
    });
    bind('layer-route', layers.route);
    bind('layer-trail', layers.trail);
    bind('layer-gm', layers.gm);
    bind('layer-stellantis', layers.stellantis);
    bind('layer-chargers', layers.chargers, () => loadChargers());

    $('layers-toggle').addEventListener('click', () => {
        const body = $('layers-body');
        body.hidden = !body.hidden;
        $('layers-toggle').setAttribute('aria-expanded', String(!body.hidden));
    });
    if (window.innerWidth < 760) $('layers-body').hidden = true;
    new ResizeObserver(() => map.invalidateSize()).observe($('map'));
}

function teamIcon(team, size) {
    const [primary, secondary] = team.colors || ['#888', '#fff'];
    const inner = team.logo ? `<img src="${esc(team.logo)}" alt="">` : '';
    return L.divIcon({
        className: '',
        html: `<div class="team-marker ${esc(team.track)}" style="width:${size}px;height:${size}px;background:${esc(primary)};border-color:${esc(secondary)}">${inner}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

function drawTeams(homeId) {
    for (const k of ['gm', 'stellantis', 'home']) layers[k].clearLayers();
    for (const team of Tracker.teams.teams) {
        const isHome = team.id === homeId;
        const track = Tracker.teams.tracks[team.track];
        L.marker([team.lat, team.lng], { icon: teamIcon(team, isHome ? 26 : team.logo ? 24 : 16), zIndexOffset: isHome ? 500 : 0 })
            .bindTooltip(`<b>${esc(team.name)}</b>${isHome ? ' (home team)' : ''}<br>${esc(team.city)}<br>` +
                `<span style="opacity:.7">${esc(track?.name || team.track)}${track ? ' · ' + esc(track.vehicle) : ''}</span>`,
                { direction: 'top', className: 'map-tooltip', offset: [0, -6] })
            .addTo(isHome ? layers.home : (layers[team.track] || layers.gm));
    }
}

function emojiIcon(emoji) {
    return L.divIcon({ className: '', html: `<div class="pin-marker">${emoji}</div>`, iconSize: [24, 24], iconAnchor: [12, 20] });
}

function drawPlaces(trip, stopStatus) {
    layers.places.clearLayers();
    if (validPlace(trip.origin) && trip.mode !== 'parked') {
        L.marker([trip.origin.lat, trip.origin.lng], { icon: emojiIcon('📍') }).bindPopup(`<b>Start</b><br>${esc(trip.origin.name)}`).addTo(layers.places);
    }
    (trip.stops || []).filter(validPlace).forEach((s, i) => {
        const done = stopStatus[i]?.arrived;
        L.circleMarker([s.lat, s.lng], { radius: 7, color: '#fff', weight: 2, fillColor: done ? '#02539E' : '#8A94A6', fillOpacity: 1 })
            .bindTooltip(`<b>Stop ${i + 1}</b><br>${esc(s.name)}`, { direction: 'top', className: 'map-tooltip' })
            .addTo(layers.places);
    });
    if (validPlace(trip.destination)) {
        const label = trip.mode === 'parked' ? 'Venue' : 'Destination';
        L.marker([trip.destination.lat, trip.destination.lng], { icon: emojiIcon('🏁') })
            .bindPopup(`<b>${label}</b><br>${esc(trip.destination.name)}`).addTo(layers.places);
        L.circle([trip.destination.lat, trip.destination.lng], { radius: (trip.arrival_radius_miles || 0.75) * 1609, color: '#FFCB06', weight: 2, fillOpacity: 0.08 }).addTo(layers.places);
    }
}

function drawVehicle(config, locations) {
    layers.trail.clearLayers();
    layers.current.clearLayers();
    const color = config.vehicle?.color || DEFAULT_COLOR;
    locations.slice(0, -1).forEach(l => {
        L.circleMarker([l.latitude, l.longitude], { radius: 3, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 })
            .bindTooltip(fmtShort(l.timestamp * 1000), { className: 'map-tooltip' })
            .addTo(layers.trail);
    });
    const cur = locations[locations.length - 1];
    if (!cur) return;
    const icon = L.divIcon({
        className: '',
        html: `<div style="background:${esc(color)};border:3px solid #fff;border-radius:50%;width:22px;height:22px;box-shadow:0 0 0 4px rgba(255,203,6,.55),0 1px 4px rgba(0,0,0,.5);"></div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
    });
    const where = placeLabel(cur);
    L.marker([cur.latitude, cur.longitude], { icon, zIndexOffset: 1000 })
        .bindPopup(`<b>${esc(config.vehicle?.name || 'Vehicle')}</b><br>${esc(where.main)}${where.sub ? ', ' + esc(where.sub) : ''}<br>` +
            `<span style="opacity:.7">Seen ${esc(fmtAgo(Date.now() - cur.timestamp * 1000))}` +
            `${cur.accuracy ? ` · ±${Math.round(cur.accuracy)} m` : ''}</span>`)
        .addTo(layers.current);
}

let lastTraveledGeometry = null, lastPlannedGeometry = null;
function redrawRouteStyles() {
    layers.route.clearLayers();
    if (lastPlannedGeometry) L.polyline(lastPlannedGeometry, { color: cssVar('--route-planned'), weight: 3, opacity: 0.8, dashArray: '6 8' }).addTo(layers.route);
    layers.traveled.clearLayers();
    if (lastTraveledGeometry) {
        const color = Tracker.data?.config?.vehicle?.color || DEFAULT_COLOR;
        L.polyline(lastTraveledGeometry, { color: '#fff', weight: 8, opacity: 0.9 }).addTo(layers.traveled);   // casing keeps it readable on any map
        L.polyline(lastTraveledGeometry, { color, weight: 5, opacity: 1 }).addTo(layers.traveled);
    }
}

// DC fast chargers along the planned route, from the DOE Alternative Fuels Station Locator.
const CONNECTORS = { J1772COMBO: 'CCS', TESLA: 'NACS (Tesla)', CHADEMO: 'CHAdeMO', J1772: 'J1772' };
async function loadChargers() {
    const cfg = Tracker.data?.config || {};
    const note = $('chargers-note');
    if (!plannedRoute) { note.textContent = 'Needs a planned route (start + destination).'; return; }
    if (chargersLoadedFor === lastRouteKey) return;
    note.textContent = 'Loading chargers…';
    layers.chargers.clearLayers();
    const pts = plannedRoute.geometry.filter((_, i, a) => i % Math.ceil(a.length / 150) === 0 || i === a.length - 1);
    const body = new URLSearchParams({
        route: 'LINESTRING(' + pts.map(p => `${p[1].toFixed(4)} ${p[0].toFixed(4)}`).join(', ') + ')',
        distance: '2', fuel_type: 'ELEC', ev_charging_level: 'dc_fast', status: 'E', access: 'public', limit: '400'
    });
    try {
        const key = cfg.map?.nrel_api_key || 'DEMO_KEY';
        const res = await fetch(`https://developer.nrel.gov/api/alt-fuel-stations/v1/nearby-route.json?api_key=${encodeURIComponent(key)}`, { method: 'POST', body });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        for (const s of data.fuel_stations || []) {
            L.circleMarker([s.latitude, s.longitude], { radius: 4, color: '#1C2B57', weight: 1, fillColor: '#FFCB06', fillOpacity: 0.95 })
                .bindPopup(`<b>⚡ ${esc(s.station_name)}</b><br>${esc(s.ev_network || '')}<br>` +
                    `${esc(s.street_address)}, ${esc(s.city)}, ${esc(s.state)}<br>` +
                    `<span style="opacity:.7">${s.ev_dc_fast_num || '?'} DC fast · ${esc((s.ev_connector_types || []).map(c => CONNECTORS[c] || c).join(', '))}</span>`)
                .addTo(layers.chargers);
        }
        chargersLoadedFor = lastRouteKey;
        note.textContent = `${(data.fuel_stations || []).length} stations within 2 mi of the route`;
    } catch (e) {
        note.textContent = 'Could not load chargers (the free DEMO_KEY is rate-limited; see README).';
    }
}

// ---------- trip logic ----------

// For each stop (and the destination last), when did the vehicle first get within range after the previous one?
function computeStopStatus(trip, locations) {
    const targets = [...(trip.stops || []).filter(validPlace).map(s => ({ ...s, r: STOP_RADIUS_MILES })),
        ...(validPlace(trip.destination) ? [{ ...trip.destination, r: trip.arrival_radius_miles || 0.75 }] : [])];
    const out = [];
    let from = 0;
    for (const t of targets) {
        const idx = locations.findIndex((l, i) => i >= from && miles(pt(l), t) <= t.r);
        if (idx === -1) { out.push({ arrived: null }); from = Infinity; continue; }
        out.push({ arrived: locations[idx].timestamp * 1000, index: idx });
        from = idx;
    }
    return out;
}

function tripLocations(trip, all) {
    if (trip.mode === 'driving' && trip.departure) {
        const dep = Date.parse(trip.departure) / 1000;
        return all.filter(l => l.timestamp >= dep - 3600);
    }
    return all;
}

function computeSplits(locations) {
    const splits = [];
    for (const l of locations) {
        const s = stateOf(l);
        if (!s) continue;
        const last = splits[splits.length - 1];
        if (last && last.code === s) continue;
        if (last) last.exit = l.timestamp;
        splits.push({ code: s, name: STATE_NAMES[s] || s, entry: l.timestamp, exit: null });
    }
    return splits;
}

// ---------- render ----------

function setHeadline(label, value) {
    $('headline-label').textContent = label;
    $('headline-value').textContent = value;
}

function setFreshness(trip, cur) {
    const dot = $('status-dot'), text = $('status-text'), fix = $('last-fix');
    dot.className = 'dot';
    if (!cur) {
        fix.textContent = '';
        text.textContent = trip.mode === 'idle' ? 'Tracker off' : 'Waiting for the first AirTag update';
        return;
    }
    const age = Date.now() - cur.timestamp * 1000;
    fix.textContent = `· last AirTag fix ${fmtAgo(age)}`;
    fix.title = fmtDate(cur.timestamp * 1000);
    if (trip.mode === 'idle') { text.textContent = 'Tracker off'; return; }
    if (age < 20 * 60e3) { dot.classList.add('live'); text.textContent = 'Tracking live'; }
    else if (age < 90 * 60e3) { dot.classList.add('warn'); text.textContent = 'AirTag update delayed'; }
    else { dot.classList.add('bad'); text.textContent = 'No recent AirTag update'; }
}

async function render({ config, locations: all }) {
    const trip = config.trip || {};
    const vehicle = config.vehicle || {};
    const team = Tracker.teams.teams.find(t => t.id === config.team?.id);
    document.title = `${vehicle.name || 'Vehicle'} Tracker · ${config.team?.name || 'EcoCAR'}`;
    $('vehicle-name').textContent = vehicle.name || 'Vehicle';
    $('subtitle').textContent = config.team?.name || 'EcoCAR Innovation Challenge';
    $('team-logo').hidden = !config.team?.logo;
    if (config.team?.logo) $('team-logo').src = config.team.logo;
    $('eyebrow').textContent = [trip.event, MODE_LABELS[trip.mode]].filter(Boolean).join(' · ');
    $('hero-vehicle').innerHTML = vehicle.full_name || team
        ? `<b>${esc(vehicle.full_name || vehicle.name || '')}</b>${esc(team ? `${team.short} · ${Tracker.teams.tracks[team.track]?.name || ''}` : '')}`
        : '';

    if (config.team?.id !== lastHomeId) { drawTeams(config.team?.id); lastHomeId = config.team?.id; }

    const locations = tripLocations(trip, all);
    const cur = locations[locations.length - 1];
    const stopStatus = computeStopStatus(trip, locations);
    const destStatus = stopStatus[stopStatus.length - 1];
    const now = Date.now();
    const depMs = trip.departure ? Date.parse(trip.departure) : (locations[0]?.timestamp ?? now / 1000) * 1000;

    drawPlaces(trip, stopStatus);
    drawVehicle(config, trip.mode === 'idle' ? all.slice(-1) : locations);
    setFreshness(trip, trip.mode === 'idle' ? all[all.length - 1] : cur);

    // Planned route: origin -> stops -> destination (not in parked mode).
    const planned = [trip.origin, ...(trip.stops || []), trip.destination].filter(validPlace);
    const routeKey = trip.mode + '|' + planned.map(p => `${p.lat},${p.lng}`).join('|');
    if (routeKey !== lastRouteKey) {
        plannedRoute = trip.mode !== 'parked' && planned.length >= 2 ? await osrmRoute(planned) : null;
        lastRouteKey = routeKey;
        lastPlannedGeometry = plannedRoute?.geometry || null;
        if ($('layer-chargers').checked) loadChargers();
    }

    // Path actually driven so far.
    let traveled = 0;
    lastTraveledGeometry = null;
    if (trip.mode === 'driving' && locations.length) {
        const pts = [...(validPlace(trip.origin) ? [trip.origin] : []), ...locations.map(pt)];
        const snapped = await osrmRoute(thin(pts, 3, 80));
        traveled = snapped ? snapped.miles : straightMiles(pts);
        lastTraveledGeometry = snapped ? snapped.geometry : pts.map(p => [p.lat, p.lng]);
    }
    redrawRouteStyles();

    // Remaining: current position -> stops not reached yet -> destination.
    let remaining = null;
    if (trip.mode === 'driving' && cur && validPlace(trip.destination) && !destStatus?.arrived) {
        const upcoming = (trip.stops || []).filter(validPlace).filter((_, i) => !stopStatus[i]?.arrived);
        remaining = await osrmRoute([pt(cur), ...upcoming, trip.destination]);
    }

    // Headline + progress
    $('progress-container').hidden = true;
    const destName = trip.destination?.name || 'destination';
    const radius = trip.arrival_radius_miles || 0.75;
    if (trip.mode === 'idle') {
        const future = trip.departure && Date.parse(trip.departure) > now;
        setHeadline(future ? `Next trip to ${destName} departs ` : '', future ? fmtDate(Date.parse(trip.departure)) : 'Not currently traveling');
    } else if (trip.mode === 'parked') {
        if (cur && validPlace(trip.destination) && miles(pt(cur), trip.destination) <= radius) {
            let i = locations.length - 1;
            while (i > 0 && miles(pt(locations[i - 1]), trip.destination) <= radius) i--;
            setHeadline(`At ${destName} since `, fmtDate(locations[i].timestamp * 1000));
        } else if (cur) {
            const w = placeLabel(cur);
            setHeadline('Away from the venue, near ', `${w.main}${w.sub ? ', ' + w.sub : ''}`);
        } else {
            setHeadline('Event venue: ', destName);
        }
    } else if (destStatus?.arrived) {
        setHeadline(`Arrived at ${destName} `, fmtDate(destStatus.arrived));
        showProgress(100);
    } else if (!cur) {
        setHeadline(depMs > now ? `Departs for ${destName} ` : 'Waiting for the first AirTag update', depMs > now ? fmtDate(depMs) : '');
    } else if (remaining) {
        setHeadline(`ETA to ${destName}: `, fmtDate(now + remaining.seconds * 1000));
        showProgress(traveled / (traveled + remaining.miles) * 100);
    } else {
        setHeadline('En route to ', destName);
    }

    // Bottom stats
    const moving = trip.mode === 'driving';
    $('distance').textContent = moving && traveled ? Math.round(traveled).toLocaleString() : '--';
    if (cur) {
        const w = placeLabel(cur);
        $('location').textContent = w.main;
        $('location-sub').textContent = w.sub;
    } else {
        $('location').textContent = '--';
        $('location-sub').textContent = '';
    }
    if (remaining) {
        $('remaining').textContent = Math.round(remaining.miles).toLocaleString();
        $('remaining-sub').textContent = `miles · ~${fmtSpan(remaining.seconds * 1000).value} driving`;
    } else {
        $('remaining').textContent = moving && destStatus?.arrived ? '0' : '--';
        $('remaining-sub').textContent = trip.mode === 'parked' ? 'parked at event' : 'miles';
    }
    renderRecentSpeed(locations);
    const splits = computeSplits(locations);
    $('states').textContent = splits.length ? new Set(splits.map(s => s.code)).size : '--';
    $('states-list').textContent = splits.map(s => s.code).filter((c, i, a) => a.indexOf(c) === i).join(' → ');
    if (moving && locations.length) {
        const end = destStatus?.arrived || now;
        const span = fmtSpan(end - depMs);
        $('time').textContent = span.value;
        $('time-sub').textContent = destStatus?.arrived ? 'total' : span.sub;
    } else {
        $('time').textContent = '--';
        $('time-sub').textContent = '';
    }

    renderTimeline(trip, stopStatus, locations, depMs);
    renderSplits(splits);
    renderStats(locations);

    // Re-frame the map when the trip itself changes (first load, or after editing settings).
    const fitKey = routeKey;
    if (fitKey !== lastFitKey) {
        const b = L.latLngBounds([]);
        if (plannedRoute) b.extend(plannedRoute.geometry);
        if (trip.mode === 'parked') { if (validPlace(trip.destination)) b.extend([trip.destination.lat, trip.destination.lng]); }
        else planned.forEach(p => b.extend([p.lat, p.lng]));
        if (cur) b.extend([cur.latitude, cur.longitude]);
        if (b.isValid()) map.fitBounds(b, { padding: [50, 50], maxZoom: trip.mode === 'parked' ? 14 : 12 });
        lastFitKey = fitKey;
    }
}

function showProgress(pct) {
    pct = Math.max(0, Math.min(100, pct));
    $('progress-container').hidden = false;
    $('progress-fill').style.width = pct + '%';
    $('progress-text').textContent = Math.round(pct) + '% of the way';
}

function renderRecentSpeed(locations) {
    $('speed-recent').textContent = '--';
    $('speed-recent-sub').textContent = 'mph';
    if (locations.length < 2) return;
    const a = locations[locations.length - 2], b = locations[locations.length - 1];
    const hrs = (b.timestamp - a.timestamp) / 3600;
    if (hrs <= 0.005) return;
    const mph = miles(pt(a), pt(b)) / hrs;
    if (mph < 120) {
        $('speed-recent').textContent = Math.round(mph);
        $('speed-recent-sub').textContent = `mph over last ${fmtSpan(hrs * 3600e3).value}`;
    }
}

function renderTimeline(trip, stopStatus, locations, depMs) {
    const ol = $('timeline');
    ol.innerHTML = '';
    const add = (kind, name, time, cls) => {
        const li = document.createElement('li');
        if (cls) li.className = cls;
        li.innerHTML = `<div class="t-kind">${esc(kind)}</div><div class="t-name">${esc(name)}</div><div class="t-time">${esc(time)}</div>`;
        ol.appendChild(li);
    };
    if (trip.mode === 'parked') {
        add(trip.event || 'Event', trip.destination?.name || '', locations.length ? `Last seen ${fmtAgo(Date.now() - locations[locations.length - 1].timestamp * 1000)}` : '', 'current');
        return;
    }
    const started = locations.length > 0 && trip.mode === 'driving';
    if (validPlace(trip.origin)) add('Start', trip.origin.name, trip.departure ? (started ? 'Departed ' : 'Departs ') + fmtShort(depMs) : '', started ? 'done' : '');
    const stops = (trip.stops || []).filter(validPlace);
    const nextIdx = stopStatus.findIndex(s => !s.arrived);
    stops.forEach((s, i) => {
        const st = stopStatus[i];
        add(`Stop ${i + 1}`, s.name, st.arrived ? 'Reached ' + fmtShort(st.arrived) : 'Not reached yet', st.arrived ? 'done' : (started && nextIdx === i ? 'current' : ''));
    });
    if (validPlace(trip.destination)) {
        const st = stopStatus[stopStatus.length - 1];
        add('Destination', trip.destination.name, st?.arrived ? 'Arrived ' + fmtShort(st.arrived) : 'Not arrived yet', st?.arrived ? 'done' : (started && nextIdx === stopStatus.length - 1 ? 'current' : ''));
    }
    if (!ol.children.length) ol.innerHTML = '<li class="empty-note">No trip set up yet. Open Settings (gear, top right) to add one.</li>';
}

function renderSplits(splits) {
    const tbody = $('splits-body');
    tbody.innerHTML = '';
    if (!splits.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty-note">No state data yet.</td></tr>';
        return;
    }
    splits.forEach((s, i) => {
        const current = i === splits.length - 1;
        const tr = document.createElement('tr');
        if (current) tr.className = 'current';
        const dur = s.exit ? fmtSpan((s.exit - s.entry) * 1000).value : 'in progress';
        tr.innerHTML = `<td>${esc(s.name)}${current ? ' 📍' : ''}</td><td>${esc(dur)}</td><td>${esc(fmtShort(s.entry * 1000))}</td>`;
        tbody.appendChild(tr);
    });
}

function renderStats(locations) {
    const cards = [];
    const card = (label, value, detail = '') => cards.push(`<div class="journey-stat-card card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="detail">${esc(detail)}</div></div>`);
    card('AirTag updates', locations.length, 'locations recorded this trip');
    let gaps = [], maxMph = 0, maxAt = '', movingMiles = 0, movingHrs = 0;
    for (let i = 1; i < locations.length; i++) {
        const a = locations[i - 1], b = locations[i];
        const sec = b.timestamp - a.timestamp;
        if (sec <= 0) continue;
        gaps.push(sec);
        const d = miles(pt(a), pt(b)), mph = d / (sec / 3600);
        if (sec < 3600 && sec > 30 && mph < 120) {
            if (mph > maxMph) { maxMph = mph; maxAt = placeLabel(b).main; }
            if (mph > 5) { movingMiles += d; movingHrs += sec / 3600; }
        }
    }
    const typical = gaps.filter(g => g < 4 * 3600);
    card('Typical update interval', typical.length ? `${Math.round(typical.reduce((a, b) => a + b, 0) / typical.length / 60)} min` : '--', 'AirTags update when an iPhone passes nearby');
    card('Longest gap', gaps.length ? fmtSpan(Math.max(...gaps) * 1000).value : '--', 'between two updates');
    card('Top speed seen', maxMph ? `${Math.round(maxMph)} mph` : '--', maxAt ? `near ${maxAt}` : '');
    card('Average moving speed', movingHrs ? `${Math.round(movingMiles / movingHrs)} mph` : '--', 'ignores stops');
    $('journey-stats').innerHTML = cards.join('');
}

// ---------- boot ----------

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'map') map.invalidateSize();
}));
$('theme-btn').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));
darkQuery.addEventListener('change', () => { if (themeChoice() === 'auto') applyTheme(); });

let refreshing = null;
async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        try {
            Tracker.data = await loadTripData();
            await render(Tracker.data);
            $('page-refresh').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            console.error(e);
            $('status-dot').className = 'dot bad';
            $('status-text').textContent = location.protocol === 'file:'
                ? 'Open this through the tracker app or GitHub Pages, not by double-clicking the file'
                : 'Could not load tracker data';
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}
Tracker.refresh = refresh;

(async function main() {
    $('demo-banner').hidden = !DEMO;
    initMap();
    applyTheme();
    try { Tracker.teams = await getJSON('data/teams.json'); } catch (e) { console.warn('No teams.json', e); }
    await refresh();
    setInterval(refresh, REFRESH_MS);
    document.dispatchEvent(new Event('tracker-ready'));
})();
