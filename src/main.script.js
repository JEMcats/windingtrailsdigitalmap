'use strict';

const SCRIPT_VERSION = 'v1.0.0-Indev10';

// ---------------------------------------------------------------------------
// DOM element cache — resolved once on startup to avoid repeated lookups
// ---------------------------------------------------------------------------
const DOM = {
    map:                    document.getElementById('map'),
    tooSmallWarn:           document.getElementById('toosmallwarn'),
    compassDir:             document.getElementById('compass-direction'),
    popupDiv:               document.getElementById('popup_div'),
    followToggle:           document.getElementById('FollowToggle'),
    compassModeButtonImage: document.getElementById('compassModeButtonImage'), // Cached — was re-queried on every compass event
    speedReading:           document.getElementById('speed_reading'),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REFERENCE_ZOOM       = 19;
const POI_TOOLTIP_BASE_FONT = 12;
const FOLLOW_SET_MIN_MS    = 500;
const FOLLOW_MIN_DIST_METERS = 3;

/** Tooltip pixel offsets [x, y] per zoom level */
const TOOLTIP_OFFSETS = { 19: [0, 20], 20: [-30, 30], 21: [-90, 50] };

const POI_TEXT_MAP = {
    all:        'All year',
    unknown:    'Unknown',
    conditions: 'If conditions permit',
    summer:     'Summer only',
    private:    'No public access',
    day_camp:   'Open to camps/events only',
    na:         'Not applicable',
    supervised: 'Under staff supervision only',
    campsites:  'May to October',
};

const TRAIL_TEXT_MAP = {
    purple: 'Paved road',
    green:  'Easy trail',
    blue:   'Moderate trail',
    black:  'Difficult trail',
};

const TRAIL_COLOR_MAP = {
    purple: '#8f408f',
    green:  '#408F58',
    blue:   '#286097',
    black:  '#1A1919',
};

const COMPASS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------
let rotatemapwithcompass = false; // Now a proper boolean — was a string "true"/"false"
let bottommenuopen       = false;
let currentOrientation   = 'N/A';
let rotationAngle        = 0;
let trailPolylines       = [];
let trailWhiteLines      = [];
let poiMarkers           = [];
let allUsersLocations    = {};
let lastLocalPosition    = null;
let lastFollowSetTime    = 0;
let suppressMoveendFetch = false;
let cachedMapData        = null;
let cachedIcons          = {};

// rAF compass throttle state — prevents deviceorientation lag
let compassRafPending = false;
let pendingHeading    = null;

// ---------------------------------------------------------------------------
// Compass mode toggle
// ---------------------------------------------------------------------------

/** Read stored compass mode from localStorage on startup */
rotatemapwithcompass = localStorage.getItem('rotatemapwithcompass') === 'true';
_applyCompassModeUI(rotatemapwithcompass);

/**
 * Toggle or set compass rotation mode.
 * @param {boolean|null} setValue - Pass a boolean to set explicitly, or omit/null to toggle.
 */
function toggleCompassMode(setValue = null) {
    rotatemapwithcompass = (setValue !== null) ? Boolean(setValue) : !rotatemapwithcompass;
    localStorage.setItem('rotatemapwithcompass', rotatemapwithcompass);
    _applyCompassModeUI(rotatemapwithcompass);
}

/** Update compass button image to reflect current mode. */
function _applyCompassModeUI(isLocked) {
    DOM.compassModeButtonImage.src = isLocked
        ? 'assets/location_arrow_locked.svg'
        : 'assets/location_arrow_north.svg';
}

// ---------------------------------------------------------------------------
// Bottom menu toggle
// ---------------------------------------------------------------------------

/**
 * Toggle or set the bottom menu open/closed state.
 * @param {boolean|null} setValue - Pass a boolean to set explicitly, or omit/null to toggle.
 */
function toggleMenuOpen(setValue = null) {
    bottommenuopen = (setValue !== null) ? Boolean(setValue) : !bottommenuopen;
    _applyMenuUI(bottommenuopen);
}

/** Apply bottom menu open/closed styles. */
function _applyMenuUI(isOpen) {
    const menu    = document.getElementById('bottommenu');
    const content = document.getElementById('menucontent');

    if (isOpen) {
        menu.style.height       = '70%';
        menu.style.minHeight    = '430px';
        content.style.height    = '100%';
        setTimeout(() => { content.style.contentVisibility = ''; }, 100);
    } else {
        menu.style.height       = '110px';
        menu.style.minHeight    = '0px';
        content.style.height    = '0%';
        setTimeout(() => { content.style.contentVisibility = 'hidden'; }, 900);
    }
}

// ---------------------------------------------------------------------------
// Direction icon — created once, rotation updated in-place via DOM
// ---------------------------------------------------------------------------

/**
 * Create the user direction marker icon (called once at marker creation).
 * Rotation is updated cheaply via updateMarkerRotation() instead of rebuilding the icon.
 */
function createDirectionIcon(rotationDeg = 0) {
    return L.divIcon({
        className: '',
        html: `
            <div style="
                position: relative;
                width: 24px;
                height: 24px;
                background-color: #007bff;
                border-radius: 50%;
                opacity: 0.8;
                display: flex;
                align-items: center;
                justify-content: center;
            ">
                <img
                    src="assets/uparrow.svg"
                    style="
                        width: 50px;
                        height: 50px;
                        transform: rotate(${rotationDeg}deg);
                        display: block;
                    "
                    alt="direction arrow"
                />
            </div>
        `,
        iconSize:    [24, 24],
        iconAnchor:  [12, 12],
        popupAnchor: [0, -14],
    });
}

/**
 * Update the user marker's arrow rotation directly in the DOM.
 * MUCH faster than calling setIcon() — avoids Leaflet tearing down/rebuilding the element.
 */
function updateMarkerRotation(degrees) {
    const markerEl = allUsersLocations.localUser?.getElement?.();
    if (!markerEl) return;
    const img = markerEl.querySelector('img');
    if (img) img.style.transform = `rotate(${degrees}deg)`;
}

// ---------------------------------------------------------------------------
// Screen-size warning — ResizeObserver fires only on actual resize (no polling)
// ---------------------------------------------------------------------------
const resizeObserver = new ResizeObserver(() => {
    const tooSmall = window.innerWidth < 385 || window.innerHeight < 245;
    DOM.tooSmallWarn.style.display = tooSmall ? 'flex' : 'none';
});
resizeObserver.observe(document.documentElement);

// ---------------------------------------------------------------------------
// Compass
// ---------------------------------------------------------------------------

/** Convert a heading in degrees to a compass direction abbreviation. */
function degreesToCompass(degrees) {
    const normalized = ((degrees % 360) + 360) % 360;
    return COMPASS_DIRS[Math.round(normalized / 45) % 8];
}

/**
 * Apply a pending compass heading update to the map and UI.
 * Called via requestAnimationFrame so multiple rapid events collapse into one paint.
 */
function _applyCompassUpdate() {
    compassRafPending = false;

    const heading = pendingHeading;
    if (heading === null) return;

    // Use textContent — faster than innerText for plain text
    DOM.compassDir.textContent = degreesToCompass(heading);
    currentOrientation = heading.toFixed(2);

    const followActive = rotatemapwithcompass && DOM.followToggle.checked;

    if (followActive) {
        // Map rotates with device — arrow stays visually upright (0°)
        updateMarkerRotation(0);
        map.setBearing(-heading);
        DOM.compassModeButtonImage.src = 'assets/location_arrow_locked.svg';
    } else {
        // Map stays north-up — arrow shows device heading
        updateMarkerRotation(heading);
        map.setBearing(0);
        DOM.compassModeButtonImage.src = 'assets/location_arrow_north.svg';
    }
}

function initCompass() {
    /**
     * Raw deviceorientation handler — intentionally minimal.
     * Heavy work is deferred to rAF so rapid-fire events don't lag the UI.
     */
    function handleOrientation(event) {
        let heading;

        if (event.webkitCompassHeading !== undefined) {
            heading = event.webkitCompassHeading; // iOS
        } else if (event.absolute && event.alpha !== null) {
            heading = 360 - event.alpha;           // Android / standard
        } else {
            console.warn('Compass heading unavailable on this device.');
            return;
        }

        pendingHeading = heading;

        // Collapse all queued events into a single rAF paint — eliminates compass lag
        if (!compassRafPending) {
            compassRafPending = true;
            requestAnimationFrame(_applyCompassUpdate);
        }
    }

    function dismissPopup() {
        DOM.popupDiv.style.display = 'none';
        DOM.popupDiv.innerHTML = '';
    }

    if (!window.DeviceOrientationEvent) {
        console.error('Device orientation not supported on this device.');
        dismissPopup();
        DOM.compassDir.textContent = 'NS';
        return;
    }

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit user permission
        DeviceOrientationEvent.requestPermission()
            .then(state => {
                dismissPopup();
                if (state === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation, true);
                } else {
                    console.error('Compass access denied by user.');
                    DOM.compassDir.textContent = 'AD';
                }
            })
            .catch(err => {
                console.error('Compass permission request failed:', err);
                dismissPopup();
                DOM.compassDir.textContent = 'PF';
            });
    } else {
        // Android and other standard-compliant devices — no permission needed
        window.addEventListener('deviceorientation', handleOrientation, true);
        dismissPopup();
    }
}

// Show compass permission prompt on load
DOM.popupDiv.innerHTML = `
    <h3>We need permission to access compass data. Press OK to continue.</h3>
    <button onclick="initCompass()">OK</button>
`;
DOM.popupDiv.style.display = 'flex';

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
const map = L.map('map', {
    center:           [41.746694, -72.846410],
    zoom:             19,
    scrollWheelZoom:  true,
    zoomControl:      true,
    bearing:          0,
    rotate:           true,
});

map.createPane('userPane');
map.getPane('userPane').style.zIndex = 650;

L.tileLayer('https://easy-map.mattheis.ddns.net/maps/winding_trails/{z}/{x}/{y}.png', {
    maxNativeZoom: 19,
    maxZoom:       21,
    minZoom:       15,
    minNativeZoom: 0,
    attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' +
        ' &amp; <a href="https://cyclosm.org/">CyclOSM</a>',
}).addTo(map);

// ---------------------------------------------------------------------------
// Trail text orientation helpers
// ---------------------------------------------------------------------------
function computePolylineOrientation(polyline) {
    if (!map || !polyline) return null;

    // Flatten nested LatLng arrays (handles MultiPolyline shapes)
    const flat = [];
    (function flatten(arr) {
        for (const item of arr) {
            Array.isArray(item) ? flatten(item) : flat.push(item);
        }
    })(polyline.getLatLngs());

    if (flat.length < 2) return null;

    const pts  = flat.map(ll => map.latLngToLayerPoint(ll));
    const dx   = pts[pts.length - 1].x - pts[0].x;
    const dy   = pts[pts.length - 1].y - pts[0].y;
    let angle  = Math.atan2(dy, dx) * 180 / Math.PI - (rotationAngle || 0);
    angle      = ((angle + 180) % 360) - 180;

    return (angle > 90 || angle < -90) ? 'flip' : null;
}

// ---------------------------------------------------------------------------
// Zoom-responsive adjustments — single zoomend handler
// ---------------------------------------------------------------------------
function adjustTrailWeights() {
    const weight = 12 * Math.pow(2, map.getZoom() - 19);
    trailPolylines.forEach(line => line.setStyle({ weight }));
    trailWhiteLines.forEach(line => line.setStyle({ weight }));
}

function updatePoiTooltips() {
    const zoom        = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const offset      = TOOLTIP_OFFSETS[zoom] ?? TOOLTIP_OFFSETS[REFERENCE_ZOOM];

    poiMarkers.forEach(marker => {
        try {
            const content = marker.tooltipContent;
            marker.unbindTooltip();

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(content || '', {
                    permanent:  true,
                    direction:  'center',
                    className:  'poiLabel',
                    offset,
                });
                const fontSize = Math.max(6, Math.round(POI_TOOLTIP_BASE_FONT * markerScale));
                const el = marker.getTooltip()?.getElement?.();
                if (el) el.style.fontSize = `${fontSize}px`;
            }
        } catch (e) {
            // Non-fatal: individual marker tooltip errors should not halt the loop
        }
    });
}

/**
 * Rebuild each POI marker's divIcon at the correct pixel size for the current zoom.
 * Must call setIcon() so Leaflet also updates its internal iconSize/iconAnchor.
 */
function updatePoiIconSizes() {
    const zoom        = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const BASE        = 32;

    poiMarkers.forEach(marker => {
        if (!marker.iconUrls?.length) return;

        const numIcons = marker.iconUrls.length;
        const perW     = Math.max(1, Math.round(BASE * markerScale));
        const totalW   = Math.max(1, Math.round(BASE * numIcons * markerScale));

        const html = marker.iconUrls
            .map(url => `<img src="${url}" style="width:${perW}px;height:${perW}px;float:left;">`)
            .join('');

        marker.setIcon(L.divIcon({
            html,
            iconSize:   [totalW, perW],
            iconAnchor: [Math.round(totalW / 2), Math.round(perW / 2)],
            className:  'custom-poi-icon',
        }));
    });
}

map.on('zoomend', () => {
    adjustTrailWeights();
    updatePoiIconSizes();
    updatePoiTooltips();
});

// ---------------------------------------------------------------------------
// Data loading — static and local, fetched once and cached
// ---------------------------------------------------------------------------
async function fetchData() {
    try {
        if (!cachedMapData) {
            const response = await fetch('assets/data.json');
            cachedMapData  = await response.json();
        }

        const data = cachedMapData;

        // Remove all non-tile, non-user layers before redrawing
        map.eachLayer(layer => {
            if (!(layer instanceof L.TileLayer) && layer.options?.pane !== 'userPane') {
                map.removeLayer(layer);
            }
        });

        poiMarkers    = [];
        trailPolylines = [];
        trailWhiteLines = [];

        // --- Trails ---
        data.trails.forEach(trail => {
            const latLngs = trail.coordinates.map(([lat, lng]) => L.latLng(lat, lng));

            const polyline = L.polyline(latLngs, {
                color:        'black',
                weight:       12,
                opacity:      1,
                smoothFactor: 1,
            }).addTo(map);
            trailPolylines.push(polyline);

            const whiteLine = L.polyline(latLngs, {
                color:        TRAIL_COLOR_MAP[trail.difficulty],
                weight:       12,
                opacity:      1,
                smoothFactor: 1,
            }).addTo(map);
            trailWhiteLines.push(whiteLine);

            polyline.setText(trail.name + '                                ', {
                repeat:     true,
                offset:     3,
                center:     true,
                attributes: {
                    fill:          'white',
                    'font-weight': 'bold',
                    'font-size':   '10px',
                },
            });

            whiteLine.on('click', e => {
                const { lat, lng } = e.latlng;
                L.popup()
                    .setLatLng(e.latlng)
                    .setContent(
                        `<h2 style="margin-bottom:0">${trail.name}</h2>` +
                        `<h4 style="margin:5px 0">${TRAIL_TEXT_MAP[trail.difficulty]}</h4>` +
                        `<p style="margin-bottom:0">Location: ${MAPLE.encodeCoords(lat, lng)}</p>` +
                        `<p style="margin-top:0">LATLNG: ${lat}, ${lng}</p>` +
                        `<button onclick="makeReport(${lat},${lng})">Make a report here</button>`
                    )
                    .openOn(map);
            });
        });

        adjustTrailWeights();

        // --- Points of Interest ---
        const zoom        = map.getZoom();
        const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
        const offset      = TOOLTIP_OFFSETS[zoom] ?? TOOLTIP_OFFSETS[REFERENCE_ZOOM];

        data.pointsOfInterest.forEach(poi => {
            const types    = poi.type.split(',').map(t => t.trim());
            const iconUrls = types.map(type => {
                const url        = `assets/poi_icons/${type}.png`;
                cachedIcons[url] = cachedIcons[url] || url;
                return cachedIcons[url];
            });

            const BASE_ICON_SIZE = 32;
            const totalW         = BASE_ICON_SIZE * types.length;
            const perIconW       = Math.max(1, Math.round(BASE_ICON_SIZE * markerScale));
            const scaledW        = Math.max(1, Math.round(totalW * markerScale));

            const iconHtml = iconUrls
                .map(url => `<img src="${url}" style="width:${perIconW}px;height:${perIconW}px;float:left;">`)
                .join('');

            const icon = L.divIcon({
                html:       iconHtml,
                iconSize:   [scaledW, perIconW],
                iconAnchor: [Math.round(scaledW / 2), Math.round(perIconW / 2)],
                className:  'custom-poi-icon',
            });

            const marker = L.marker(poi.coordinates, { icon }).addTo(map);
            marker.setZIndexOffset(2000);
            marker.tooltipContent = poi.name;
            marker.baseFont       = POI_TOOLTIP_BASE_FONT;
            marker.baseSize       = [totalW, BASE_ICON_SIZE];
            marker.iconUrls       = iconUrls;

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(poi.name, {
                    permanent:  true,
                    direction:  'center',
                    className:  'poiLabel',
                    offset,
                });
                setTimeout(() => {
                    const el = marker.getTooltip()?.getElement?.();
                    if (el) {
                        el.style.fontSize =
                            `${Math.max(6, Math.round(POI_TOOLTIP_BASE_FONT * markerScale))}px`;
                    }
                }, 50);
            }

            const typeLabel = types
                .map(t => t.charAt(0).toUpperCase() + t.slice(1))
                .join(', ');

            marker.bindPopup(
                L.popup({ autoClose: true, closeOnClick: false, closeButton: true, autoPan: true })
                    .setContent(
                        `<h2 style="margin-bottom:0">${poi.name}</h2>` +
                        `<h4 style="margin:5px 0">${typeLabel}</h4>` +
                        `<p style="margin-top:0">Open: ${POI_TEXT_MAP[poi.opperation_time] || poi.opperation_time}</p>` +
                        `<p style="margin-bottom:0">Location: ${MAPLE.encodeCoords(poi.coordinates[0], poi.coordinates[1])}</p>` +
                        `<p style="margin-top:0">LATLNG: ${poi.coordinates[0]}, ${poi.coordinates[1]}</p>` +
                        `<button onclick="makeReport(${poi.coordinates[0]},${poi.coordinates[1]})">Make a report here</button>`
                    )
            );

            poiMarkers.push(marker);
        });

        updatePoiTooltips();

    } catch (err) {
        console.error('fetchData error:', err);
    }
}

fetchData();

// ---------------------------------------------------------------------------
// Geolocation & user marker
// ---------------------------------------------------------------------------

/** Convert m/s to a formatted mph string, or null if unavailable. */
function formatSpeed(speedMps) {
    if (typeof speedMps !== 'number' || isNaN(speedMps)) return null;
    return (speedMps * 2.2369362920544).toFixed(1);
}

function updateLocalUserLocation(position) {
    if (!position?.coords) {
        console.error('Invalid position object:', position);
        return;
    }

    const { latitude: lat, longitude: lng, speed: gpsSpeed } = position.coords;

    // Prefer GPS-provided speed; fall back to computing from displacement
    let speedMps = null;
    if (typeof gpsSpeed === 'number' && !isNaN(gpsSpeed)) {
        speedMps = gpsSpeed;
    } else if (lastLocalPosition && typeof lastLocalPosition.time === 'number') {
        const distMeters = L.latLng(lat, lng).distanceTo(
            L.latLng(lastLocalPosition.lat, lastLocalPosition.lng)
        );
        const dtSeconds = (position.timestamp - lastLocalPosition.time) / 1000;
        if (dtSeconds > 0.5) speedMps = distMeters / dtSeconds;
    }

    const formattedSpeed = formatSpeed(speedMps) ?? '--.-';

    // Use cached DOM reference — was lazily created before
    if (DOM.speedReading) DOM.speedReading.textContent = formattedSpeed;

    const popupContent =
        `<h2 style="margin-bottom:5px">Your latest location</h2>` +
        `<p style="margin-bottom:0">Location: ${MAPLE.encodeCoords(lat, lng)}</p>` +
        `<p style="margin-top:0">LATLNG: ${lat}, ${lng}</p>` +
        `<p style="margin-bottom:0">Direction: ${degreesToCompass(currentOrientation)} / ${currentOrientation}</p>` +
        `<p style="margin-top:0">Speed: ${formattedSpeed}</p>` +
        `<button onclick="makeReport(${lat},${lng})">Make a report here</button>`;

    // Capture previous position BEFORE updating marker (avoids always-zero distance bug)
    const prevLatLng  = allUsersLocations.localUser?.getLatLng?.();
    const movedDist   = prevLatLng ? L.latLng(lat, lng).distanceTo(prevLatLng) : Infinity;

    if (allUsersLocations.localUser) {
        allUsersLocations.localUser.setLatLng([lat, lng]);
        allUsersLocations.localUser.getPopup()?.setContent(popupContent);
    } else {
        // Create marker once — rotation is updated cheaply via updateMarkerRotation()
        allUsersLocations.localUser = L.marker([lat, lng], {
            icon:  createDirectionIcon(0),
            pane:  'userPane',
        })
            .addTo(map)
            .bindPopup(
                L.popup({ autoClose: true, closeOnClick: false, closeButton: true, autoPan: true })
                    .setContent(popupContent)
            );
    }

    lastLocalPosition = { lat, lng, time: position.timestamp || Date.now() };

    // Follow mode: re-center map on user if enabled
    if (!DOM.followToggle.checked) return;

    const now     = Date.now();
    const tooSoon = (now - lastFollowSetTime) < FOLLOW_SET_MIN_MS;

    if (movedDist >= FOLLOW_MIN_DIST_METERS || !tooSoon) {
        suppressMoveendFetch = true;
        map.setView([lat, lng]);
        lastFollowSetTime = now;
        // Safety: clear suppress flag if moveend never fires
        setTimeout(() => { suppressMoveendFetch = false; }, 1000);
    }
}

function handleLocationError(error) {
    console.error('Geolocation error:', error);
    alert('Unable to retrieve your location.');
}

if (navigator.geolocation) {
    navigator.geolocation.watchPosition(updateLocalUserLocation, handleLocationError, {
        enableHighAccuracy: true,
        maximumAge:         500,
    });
} else {
    alert('Geolocation is not supported by your browser.');
}

// ---------------------------------------------------------------------------
// Popup persistence across map moves
// Track only layers that have open popups — avoids iterating all layers
// ---------------------------------------------------------------------------

/**
 * Layers with open popups at movestart, keyed by their popup content string.
 * Using a Set of layers is more direct than extracting names from HTML.
 */
let openPopupLayers = new Set();

map.on('movestart', () => {
    openPopupLayers.clear();

    // Only POI markers and user marker can have open popups — skip trail iteration
    [...poiMarkers, allUsersLocations.localUser].forEach(layer => {
        if (layer?.getPopup?.() && layer?.isPopupOpen?.()) {
            openPopupLayers.add(layer);
            layer.closePopup();
        }
    });
});

map.on('moveend', () => {
    if (suppressMoveendFetch) {
        suppressMoveendFetch = false;
        return;
    }

    if (!openPopupLayers.size) return;

    setTimeout(() => {
        openPopupLayers.forEach(layer => {
            if (layer?.getPopup?.() && !layer.isPopupOpen?.()) {
                layer.openPopup();
            }
        });
        openPopupLayers.clear();
    }, 250);
});

// ---------------------------------------------------------------------------
// Follow-mode toggle — persisted to localStorage
// ---------------------------------------------------------------------------
DOM.followToggle.checked = localStorage.getItem('FollowToggleState') === 'true';
DOM.followToggle.addEventListener('change', () => {
    localStorage.setItem('FollowToggleState', String(DOM.followToggle.checked));
});

// ---------------------------------------------------------------------------
// Coordinate popup — right-click (desktop) and triple-tap (touch)
// ---------------------------------------------------------------------------
function showMapPopup(latlng) {
    map.setView(latlng);
    setTimeout(() => {
        L.popup({ closeOnClick: true, autoClose: false, autoPan: false })
            .setLatLng(latlng)
            .setContent(                                    // Single setContent call (was called twice before, first was discarded)
                `<h2 style="margin-bottom:5px">You have selected:</h2>` +
                `<p style="margin-bottom:0">Location: ${MAPLE.encodeCoords(latlng.lat, latlng.lng)}</p>` +
                `<p style="margin-top:0">LATLNG: ${latlng.lat}, ${latlng.lng}</p>` +
                `<button onclick="makeReport(${latlng.lat},${latlng.lng})">Make a report here</button>`
            )
            .openOn(map);
    }, 400);
}

map.on('contextmenu', e => showMapPopup(e.latlng));

// Triple-tap detection for touch devices
let tapCount    = 0;
let lastTapTime = 0;

map.getContainer().addEventListener('touchend', e => {
    const now = Date.now();
    tapCount  = (now - lastTapTime <= 500) ? tapCount + 1 : 1;
    lastTapTime = now;

    if (tapCount === 3) {
        const rect  = map.getContainer().getBoundingClientRect();
        const touch = e.changedTouches[0];
        const latlng = map.containerPointToLatLng(
            L.point(touch.clientX - rect.left, touch.clientY - rect.top)
        );
        showMapPopup(latlng);
        e.preventDefault();
        tapCount = 0;
    }
});

// ---------------------------------------------------------------------------
// Report submission
// ---------------------------------------------------------------------------
function makeReport(lat, lng) {
    const location_name = prompt('Please give a name for this location.');
    if (location_name === null) return;

    const url     = 'https://easy-map.mattheis.ddns.net/windingtrails/makereport';
    const payload = { name: location_name, coords: [lat, lng] };

    (async () => {
        try {
            const resp = await fetch(url, {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });

            const ct  = resp.headers.get('content-type') || '';
            const out = ct.includes('application/json')
                ? JSON.stringify(await resp.json())
                : await resp.text();

            alert(out);
        } catch (err) {
            alert('Error sending report: ' + (err?.message ?? err));
        }
    })();
}