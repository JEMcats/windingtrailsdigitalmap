'use strict';

// ---------------------------------------------------------------------------
// DOM element cache — resolved once on startup to avoid repeated lookups
// ---------------------------------------------------------------------------
const DOM = {
    map: document.getElementById('map'),
    tooSmallWarn: document.getElementById('toosmallwarn'),
    compassDir: document.getElementById('compass-direction'),
    popupDiv: document.getElementById('popup_div'),
    followToggle: document.getElementById('FollowToggle'),
};

let rotatemapwithcompass = false;

if (localStorage.getItem('rotatemapwithcompass')) {
    toggleCompassMode(localStorage.getItem('rotatemapwithcompass'))
} else {
    toggleCompassMode(false)
}

function toggleCompassMode(setValue) {
    if (setValue) {
        rotatemapwithcompass = setValue;
        if (rotatemapwithcompass == "true") {
            document.getElementById('compassModeButtonImage').src = "assets/location_arrow_locked.svg"
            localStorage.setItem('rotatemapwithcompass', "true")
            rotatemapwithcompass = "true";
        } else {
            document.getElementById('compassModeButtonImage').src = "assets/location_arrow_north.svg"
            localStorage.setItem('rotatemapwithcompass', "false")
            rotatemapwithcompass = "false";
        }
    } else {
        if (rotatemapwithcompass == "true") {
            document.getElementById('compassModeButtonImage').src = "assets/location_arrow_north.svg"
            rotatemapwithcompass = "false";
            localStorage.setItem('rotatemapwithcompass', "false")
        } else {
            document.getElementById('compassModeButtonImage').src = "assets/location_arrow_locked.svg"
            rotatemapwithcompass = "true";
            localStorage.setItem('rotatemapwithcompass', "true")
        }
    }
}

function createDirectionIcon(rotationDeg = 0) {
    return L.divIcon({
        className: '',  // Suppress Leaflet's default white box styling
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
        iconSize: [24, 24],
        iconAnchor: [12, 12],   // Center the icon on the coordinate
        popupAnchor: [0, -14],  // Position popup above the marker
    });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REFERENCE_ZOOM = 19;
const POI_TOOLTIP_BASE_FONT = 12;
// Tooltip pixel offsets [x, y] per zoom level
const TOOLTIP_OFFSETS = { 19: [0, 20], 20: [-30, 30], 21: [-90, 50] };
const FOLLOW_SET_MIN_MS = 500;
const FOLLOW_MIN_DIST_METERS = 3;

const POI_TEXT_MAP = {
    all: 'All year',
    unknown: 'Unknown',
    conditions: 'If conditions permit',
    summer: 'Summer only',
    private: 'No public access',
    day_camp: 'Open to camps/events only',
    na: 'Not applicable',
    supervised: 'Under staff supervision only',
    campsites: 'May to October',
};

const TRAIL_TEXT_MAP = {
    purple: 'Paved road',
    green: 'Easy trail',
    blue: 'Moderate trail',
    black: 'Difficult trail',
};

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------
let currentOrientation = 'N/A';
let rotationAngle = 0;
let trailPolylines = [];
let trailWhiteLines = [];
let poiMarkers = [];
let allUsersLocations = {};
let lastLocalPosition = null;
let lastFollowSetTime = 0;
let suppressMoveendFetch = false;
let cachedMapData = null;
let cachedIcons = {};
let speedElement = null;

// ---------------------------------------------------------------------------
// Screen-size warning
// Replace setInterval polling with ResizeObserver — fires only on actual resize
// ---------------------------------------------------------------------------
const resizeObserver = new ResizeObserver(() => {
    const tooSmall = window.innerWidth < 385 || window.innerHeight < 245;
    DOM.tooSmallWarn.style.display = tooSmall ? 'flex' : 'none';
});
resizeObserver.observe(document.documentElement);

// ---------------------------------------------------------------------------
// Compass
// ---------------------------------------------------------------------------
function degreesToCompass(degrees) {
    const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const normalized = ((degrees % 360) + 360) % 360;
    return DIRS[Math.round(normalized / 45) % 8];
}

function initCompass() {
    function handleOrientation(event) {
        let heading;
        if (event.webkitCompassHeading !== undefined) {
            // iOS non-standard API
            heading = event.webkitCompassHeading;
        } else if (event.absolute && event.alpha !== null) {
            // Standard API (Android, etc.)
            heading = 360 - event.alpha;
        } else {
            heading = null;
        }

        if (heading !== null) {

            if (rotatemapwithcompass == "true" && DOM.followToggle.checked == true) {
                allUsersLocations.localUser.setIcon(createDirectionIcon(0))
                map.setBearing(-heading);
                document.getElementById('compassModeButtonImage').src = "assets/location_arrow_locked.svg"
            } else {
                allUsersLocations.localUser.setIcon(createDirectionIcon(heading))
                map.setBearing(0);
                document.getElementById('compassModeButtonImage').src = "assets/location_arrow_north.svg"
            }

            DOM.compassDir.innerText = degreesToCompass(heading.toFixed(2));
            currentOrientation = heading.toFixed(2);
        } else {
            console.warn('Compass heading not available on this device.');
        }
    }

    function dismissPopup() {
        DOM.popupDiv.style.display = 'none';
        DOM.popupDiv.innerHTML = '';
    }

    if (!window.DeviceOrientationEvent) {
        console.error('Device orientation is not supported on this device.');
        dismissPopup();
        DOM.compassDir.innerText = 'NS';
        return;
    }

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit permission
        DeviceOrientationEvent.requestPermission()
            .then(state => {
                dismissPopup();
                if (state === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation, true);
                } else {
                    console.error('Compass access denied by user.');
                    DOM.compassDir.innerText = 'AD';
                }
            })
            .catch(err => {
                console.error('Compass permission request failed:', err);
                dismissPopup();
                DOM.compassDir.innerText = 'PF';
            });
    } else {
        // Android and other standard-compliant devices
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
    center: [41.746694, -72.846410],
    zoom: 19,
    scrollWheelZoom: true,
    zoomControl: true,
    bearing: 0,
    rotate: true,
});

map.createPane('userPane');
map.getPane('userPane').style.zIndex = 650;

L.tileLayer('https://easy-map.mattheis.ddns.net/maps/winding_trails/{z}/{x}/{y}.png', {
    maxNativeZoom: 19,
    maxZoom: 21,
    minZoom: 15,
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

    const pts = flat.map(ll => map.latLngToLayerPoint(ll));
    const dx = pts[pts.length - 1].x - pts[0].x;
    const dy = pts[pts.length - 1].y - pts[0].y;

    // Subtract any CSS rotation so text stays visually upright
    let angle = Math.atan2(dy, dx) * 180 / Math.PI - (rotationAngle || 0);
    angle = ((angle + 180) % 360) - 180;

    return (angle > 90 || angle < -90) ? 'flip' : null;
}

// ---------------------------------------------------------------------------
// Zoom-responsive adjustments (combined into a single zoomend handler)
// ---------------------------------------------------------------------------
function adjustTrailWeights() {
    const weight = 12 * Math.pow(2, map.getZoom() - 19);
    trailPolylines.forEach(line => line.setStyle({ weight }));
    trailWhiteLines.forEach(line => line.setStyle({ weight }));
}

function updatePoiTooltips() {
    const zoom = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const offset = TOOLTIP_OFFSETS[zoom] ?? TOOLTIP_OFFSETS[REFERENCE_ZOOM];

    poiMarkers.forEach(marker => {
        try {
            const content = marker.tooltipContent;
            marker.unbindTooltip();

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(content || '', {
                    permanent: true,
                    direction: 'center',
                    className: 'poiLabel',
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
 * Rebuild each POI marker's divIcon at the correct pixel size for the
 * current zoom level. Must call setIcon() so Leaflet also updates its
 * internal iconSize/iconAnchor used for positioning.
 */
function updatePoiIconSizes() {
    const zoom = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const BASE = 32;

    poiMarkers.forEach(marker => {
        if (!marker.iconUrls?.length) return;

        const numIcons = marker.iconUrls.length;
        const perW = Math.max(1, Math.round(BASE * markerScale));
        const totalW = Math.max(1, Math.round(BASE * numIcons * markerScale));

        const html = marker.iconUrls
            .map(url => `<img src="${url}" style="width:${perW}px;height:${perW}px;float:left;">`)
            .join('');

        marker.setIcon(L.divIcon({
            html,
            iconSize: [totalW, perW],
            iconAnchor: [Math.round(totalW / 2), Math.round(perW / 2)],
            className: 'custom-poi-icon',
        }));
    });
}

// Single handler for all zoom-dependent updates
map.on('zoomend', () => {
    adjustTrailWeights();
    updatePoiIconSizes();
    updatePoiTooltips();
});

// ---------------------------------------------------------------------------
// Data loading
// Data is fully static and local — load once, never rebuild on pan/zoom.
// ---------------------------------------------------------------------------
async function fetchData() {
    try {
        if (!cachedMapData) {
            const response = await fetch('assets/data.json');
            cachedMapData = await response.json();
        }

        const data = cachedMapData;

        // Remove all non-tile, non-user layers before redrawing
        map.eachLayer(layer => {
            if (!(layer instanceof L.TileLayer) && layer.options?.pane !== 'userPane') {
                map.removeLayer(layer);
            }
        });

        // Reset layer arrays
        poiMarkers = [];
        trailPolylines = [];
        trailWhiteLines = [];

        // --- Trails ---
        data.trails.forEach(trail => {
            const latLngs = trail.coordinates.map(([lat, lng]) => L.latLng(lat, lng));

            const polyline = L.polyline(latLngs, {
                color: 'black',
                weight: 12,
                opacity: 1,
                smoothFactor: 1,
            }).addTo(map);
            trailPolylines.push(polyline);

            const whiteLine = L.polyline(latLngs, {
                color: trail.difficulty,
                weight: 12,
                opacity: 1,
                smoothFactor: 1,
            }).addTo(map);
            trailWhiteLines.push(whiteLine);

            polyline.setText(trail.name + '                                ', {
                repeat: true,
                offset: 3,
                center: true,
                attributes: {
                    fill: 'white',
                    'font-weight': 'bold',
                    'font-size': '10px',
                },
            });

            whiteLine.on('click', e => {
                const { lat, lng } = e.latlng;
                L.popup()
                    .setLatLng(e.latlng)
                    .setContent(
                        `<h2 style="margin-bottom:0">${trail.name}</h2>` +
                        `<h4 style="margin:5px 0">${TRAIL_TEXT_MAP[trail.difficulty]}</h4>` +
                        `<p style="margin-bottom: 0px;" >Location: ${MAPLE.encodeCoords(lat, lng)}</p>` +
                        `<p style="margin-top: 0px;" >LATLNG: ${lat}, ${lng}</p>`
                    )
                    .openOn(map);
            });
        });

        adjustTrailWeights();

        // --- Points of Interest ---
        const zoom = map.getZoom();
        const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
        const offset = TOOLTIP_OFFSETS[zoom] ?? TOOLTIP_OFFSETS[REFERENCE_ZOOM];

        data.pointsOfInterest.forEach(poi => {
            const types = poi.type.split(',').map(t => t.trim());
            const iconUrls = types.map(type => {
                const url = `assets/poi_icons/${type}.png`;
                cachedIcons[url] = cachedIcons[url] || url;
                return cachedIcons[url];
            });

            const BASE_ICON_SIZE = 32;
            const totalW = BASE_ICON_SIZE * types.length;
            const perIconW = Math.max(1, Math.round(BASE_ICON_SIZE * markerScale));
            const perIconH = perIconW;
            const scaledW = Math.max(1, Math.round(totalW * markerScale));
            const scaledH = perIconH;

            const iconHtml = iconUrls
                .map(url => `<img src="${url}" style="width:${perIconW}px;height:${perIconH}px;float:left;">`)
                .join('');

            const icon = L.divIcon({
                html: iconHtml,
                iconSize: [scaledW, scaledH],
                iconAnchor: [Math.round(scaledW / 2), Math.round(scaledH / 2)],
                className: 'custom-poi-icon',
            });

            const marker = L.marker(poi.coordinates, { icon }).addTo(map);
            marker.setZIndexOffset(2000);
            marker.tooltipContent = poi.name;
            marker.baseFont = POI_TOOLTIP_BASE_FONT;
            marker.baseSize = [totalW, BASE_ICON_SIZE];
            marker.iconUrls = iconUrls;       // stored so zoom can rebuild the icon

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(poi.name, {
                    permanent: true,
                    direction: 'center',
                    className: 'poiLabel',
                    offset,
                });
                // Apply font size after element renders
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
                        `<p style="margin-bottom: 0px;" >Location: ${MAPLE.encodeCoords(poi.coordinates[0], poi.coordinates[1])}</p>` +
                        `<p style="margin-top: 0px;" >LATLNG: ${poi.coordinates[0]}, ${poi.coordinates[1]}</p>`
                    )
            );

            poiMarkers.push(marker);
        });

        updatePoiTooltips();

    } catch (err) {
        console.error('fetchData error:', err);
    }
}

// Load map data once on startup — all data is static and local
fetchData();

// ---------------------------------------------------------------------------
// Geolocation & user marker
// ---------------------------------------------------------------------------

/** Lazily create or retrieve the speed display element. */
function getSpeedElement() {
    if (speedElement) return speedElement;

    speedElement = document.getElementById('speed_reading');
    if (!speedElement) {
        speedElement = document.createElement('h2');
        speedElement.id = 'speed_reading';
        Object.assign(speedElement.style, {
            position: 'absolute',
            top: '10px',
            right: '10px',
            margin: '0',
            padding: '4px 8px',
            background: 'rgba(255,255,255,0.8)',
            borderRadius: '4px',
            zIndex: '1001',
        });
        speedElement.innerText = '--.-';
        document.body.appendChild(speedElement);
    }
    return speedElement;
}

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
    getSpeedElement().innerText = formattedSpeed;

    const popupContent =
        `Your latest location.<br>` +
        `${MAPLE.encodeCoords(lat, lng)}<br>` +
        `Direction: ${degreesToCompass(currentOrientation)} / ${currentOrientation}<br>` +
        `Speed: ${formattedSpeed}`;

    // --- Update or create the local user marker ---
    // Capture distance BEFORE updating the marker position (fixes a bug where
    // comparing against the already-moved marker always returned 0).
    const prevLatLng = allUsersLocations.localUser?.getLatLng?.();
    const movedDist = prevLatLng ? L.latLng(lat, lng).distanceTo(prevLatLng) : Infinity;

    if (allUsersLocations.localUser) {
        allUsersLocations.localUser.setLatLng([lat, lng]);
        allUsersLocations.localUser.getPopup()?.setContent(popupContent);
    } else {
        allUsersLocations.localUser = L.marker([lat, lng], {
            icon: createDirectionIcon(0),
            pane: 'userPane',
        })
            .addTo(map)
            .bindPopup(
                L.popup({ autoClose: true, closeOnClick: false, closeButton: true, autoPan: true })
                    .setContent(popupContent)
            );
    }

    // Save current position for the next speed calculation
    lastLocalPosition = { lat, lng, time: position.timestamp || Date.now() };

    // --- Follow mode: re-center map on user if enabled ---
    if (!DOM.followToggle.checked) return;

    const now = Date.now();
    const tooSoon = (now - lastFollowSetTime) < FOLLOW_SET_MIN_MS;

    if (movedDist >= FOLLOW_MIN_DIST_METERS || !tooSoon) {
        suppressMoveendFetch = true;
        map.setView([lat, lng]);
        lastFollowSetTime = now;
        // Safety: clear the suppress flag if moveend never fires
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
        maximumAge: 500,
    });
} else {
    alert('Geolocation is not supported by your browser.');
}

// ---------------------------------------------------------------------------
// Popup persistence across map moves
// ---------------------------------------------------------------------------
let openPopupNames = [];

function extractNameFromPopupContent(content) {
    if (!content) return null;
    const match = content.match(/^([^<]*)<br/i);
    return match?.[1]?.trim() ?? content.trim();
}

map.on('movestart', () => {
    openPopupNames = [];
    map.eachLayer(layer => {
        if (layer.getPopup?.() && layer.isPopupOpen?.()) {
            const name = extractNameFromPopupContent(layer.getPopup().getContent());
            if (name) openPopupNames.push(name);
            layer.closePopup();
        }
    });
});

map.on('moveend', () => {
    // Skip popup restore and suppress flag for follow-mode programmatic pans
    if (suppressMoveendFetch) {
        suppressMoveendFetch = false;
        return;
    }

    if (!openPopupNames.length) return;

    // Layers are stable (no rebuild on pan), so one timeout is sufficient
    setTimeout(() => {
        map.eachLayer(layer => {
            if (!layer.getPopup?.()) return;
            const name = extractNameFromPopupContent(layer.getPopup().getContent());
            if (openPopupNames.includes(name)) layer.openPopup();
        });

        poiMarkers.forEach(marker => {
            if (!marker.getPopup?.()) return;
            const name = extractNameFromPopupContent(marker.getPopup().getContent());
            if (openPopupNames.includes(name) && !marker.isPopupOpen()) {
                marker.openPopup();
            }
        });

        openPopupNames = [];
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
            .setContent(
                `You have selected:<br>` +
                `${MAPLE.encodeCoords(latlng.lat, latlng.lng)}<br>` +
                `${latlng.lat}, ${latlng.lng}`
            )
            .setContent(
                `<h2 style="margin-bottom:5px">You have selected:</h2>` +
                `<p style="margin-bottom: 0px;" >Location: ${MAPLE.encodeCoords(latlng.lat, latlng.lng)}</p>` +
                `<p style="margin-top: 0px;" >LATLNG: ${latlng.lat}, ${latlng.lng}</p>` +
                `<button onclick="makeReport(${latlng.lat},${latlng.lng})">Make a report here</button>`
            )
            .openOn(map);
    }, 400);
}

map.on('contextmenu', e => showMapPopup(e.latlng));

// Triple-tap detection for touch devices
let tapCount = 0;
let lastTapTime = 0;

map.getContainer().addEventListener('touchend', e => {
    const now = Date.now();
    tapCount = (now - lastTapTime <= 500) ? tapCount + 1 : 1;
    lastTapTime = now;

    if (tapCount === 3) {
        const rect = map.getContainer().getBoundingClientRect();
        const touch = e.changedTouches[0];
        const latlng = map.containerPointToLatLng(
            L.point(touch.clientX - rect.left, touch.clientY - rect.top)
        );
        showMapPopup(latlng);
        e.preventDefault(); // Prevent default triple-tap zoom
        tapCount = 0;
    }
});

function makeReport(lat, lng) {
    const location_name = prompt("Please give a name for this location.");
    if (location_name === null) return;

    const url = 'https://easy-map.mattheis.ddns.net/windingtrails/makereport';
    const payload = { name: location_name, coords: [lat, lng] };

    (async () => {
        try {
            const resp = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const ct = resp.headers.get('content-type') || '';
            let out;
            if (ct.includes('application/json')) {
                const json = await resp.json();
                out = JSON.stringify(json);
            } else {
                out = await resp.text();
            }

            alert(out);
        } catch (err) {
            alert('Error sending report: ' + (err && err.message ? err.message : err));
        }
    })();
}