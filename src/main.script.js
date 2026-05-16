'use strict';

//#region WINDING TRAILS DIGITAL MAP

const SCRIPT_VERSION = 'v1.0.1-Stable';

//#region INITIALIZATION: DOM Cache & Version Display

const DOM = {
    map: document.getElementById('map'),
    tooSmallWarn: document.getElementById('toosmallwarn'),
    compassDir: document.getElementById('compass-direction'),
    popupDiv: document.getElementById('popup_div'),
    followToggle: document.getElementById('FollowToggle'),
    compassModeButtonImage: document.getElementById('compassModeButtonImage'),
    speedReading: document.getElementById('speed_reading'),
    versionDisplay: document.getElementById('version_number_display'),
    menuContent: document.getElementById('menucontent'),
};

if (DOM.versionDisplay) DOM.versionDisplay.textContent = SCRIPT_VERSION;

//#endregion INITIALIZATION

//#region APPLICATION CONSTANTS
// Zoom reference level for marker scaling
const REFERENCE_ZOOM = 19;

// Tooltip and POI settings
const POI_TOOLTIP_BASE_FONT = 12;
const TOOLTIP_OFFSETS = { 19: [0, 20], 20: [-30, 30], 21: [-90, 50] };

// Follow mode debouncing
const FOLLOW_SET_MIN_MS = 500;
const FOLLOW_MIN_DIST_METERS = 3;

// POI accessibility and availability labels
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

// Trail difficulty level labels and colors
const TRAIL_TEXT_MAP = {
    purple: 'Paved surface',
    green: 'Easy trail',
    blue: 'Moderate trail',
    black: 'Difficult trail',
};

const TRAIL_COLOR_MAP = {
    purple: '#8f408f',
    green: '#408F58',
    blue: '#286097',
    black: '#1A1919',
    import: '#d63838'
};

// Compass direction abbreviations
const COMPASS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

//#endregion APPLICATION CONSTANTS

//#region APPLICATION STATE
// UI state
let rotatemapwithcompass = false;
let bottommenuopen = false;
let currentOrientation = 0;    // Device heading in degrees (from compass)
let rotationAngle = 0;    // Map rotation in degrees

// Map data and layers
let trailPolylines = [];
let trailWhiteLines = [];
let poiMarkers = [];
let cachedMapData = null;
let cachedIcons = {};

// User location tracking
let allUsersLocations = {};   // Holds localUser marker and others
let lastLocalPosition = null; // Previous GPS position for speed calculation
let lastFollowSetTime = 0;    // Timestamp of last follow-mode pan
let suppressMoveendFetch = false;// Flag to skip reload after programmatic pan

// GPS watch management
let gpsWatchId = null;
let wakeLockHandle = null;

// Compass and sensor fusion
let compassRafPending = false;    // rAF throttle for frequent orientation updates
let pendingHeading = null;     // Queued heading to apply in next paint
let fusedHeading = null;     // The filtered heading after gyro validation
let lastRawMagHeading = null;     // Previous raw magnetometer reading
let magJumpRate = 0;        // EMA of magnetometer jump magnitude
let gyroRotationRate = 0;        // EMA of total device rotation rate

// Menu animation
let menuAnimationTimer = null;

// Popup tracking — holds layer refs with open popups across a move event.
// IMPORTANT: cleared in fetchData() before layers are removed, so it never holds dead references.
let openPopupLayers = new Set();

//#endregion APPLICATION STATE

//#region FEATURE: Browser Capabilities

//#region Screen Wake Lock — Keep Display Active While Using Map
function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;

    navigator.wakeLock.request('screen')
        .then(function (lock) {
            wakeLockHandle = lock;
            console.log('Wake lock acquired.');
        })
        .catch(function (err) {
            console.warn('Wake lock request failed:', err.message);
        });
}

// Re-acquire wake lock and GPS when returning to the page
document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
        acquireWakeLock();
        restartGpsWatch();
    }
});

acquireWakeLock();

//#endregion Screen Wake Lock

//#region Responsive Layout — Monitor Screen Size

const resizeObserver = new ResizeObserver(function () {
    const tooSmall = window.innerWidth < 385 || window.innerHeight < 245;
    DOM.tooSmallWarn.style.display = tooSmall ? 'flex' : 'none';
});
resizeObserver.observe(document.documentElement);

//#endregion Responsive Layout

//#endregion FEATURE: Browser Capabilities

//#region FEATURE: User Interface Controls

//#region Compass Mode Toggle (North-Up vs Device-Rotation)

// Load compass mode preference from localStorage
rotatemapwithcompass = localStorage.getItem('rotatemapwithcompass') === 'true';
applyCompassModeUI(rotatemapwithcompass);

// Toggle compass mode between north-up and device-rotation
function toggleCompassMode(setValue) {
    if (setValue !== undefined && setValue !== null) {
        rotatemapwithcompass = Boolean(setValue);
    } else {
        rotatemapwithcompass = !rotatemapwithcompass;
    }
    localStorage.setItem('rotatemapwithcompass', String(rotatemapwithcompass));
    applyCompassModeUI(rotatemapwithcompass);
}

// Update the compass mode button icon (only place this should be changed)
function applyCompassModeUI(isLocked) {
    DOM.compassModeButtonImage.src = isLocked
        ? 'assets/icons/location_arrow_locked.svg'
        : 'assets/icons/location_arrow_north.svg';
}

//#endregion Compass Mode Toggle

//#region Bottom Menu Toggle (Slide Up/Down)

function toggleMenuOpen(setValue) {
    if (setValue !== undefined && setValue !== null) {
        bottommenuopen = Boolean(setValue);
    } else {
        bottommenuopen = !bottommenuopen;
    }
    applyMenuUI(bottommenuopen);
}

function applyMenuUI(isOpen) {
    const menu = document.getElementById('bottommenu');
    const content = document.getElementById('menucontent');

    // Cancel any in-flight animation timer from a rapid previous toggle
    if (menuAnimationTimer !== null) {
        clearTimeout(menuAnimationTimer);
        menuAnimationTimer = null;
    }

    if (isOpen) {
        menu.style.height = '70%';
        menu.style.minHeight = '430px';
        content.style.padding = '15px';
        content.style.height = '100%';
        menuAnimationTimer = setTimeout(function () {
            content.style.contentVisibility = '';
            menuAnimationTimer = null;
        }, 100);
    } else {
        menu.style.height = '75px';
        menu.style.minHeight = '0px';
        content.style.height = '0%';
        content.style.padding = '0px';
        menuAnimationTimer = setTimeout(function () {
            content.style.contentVisibility = 'hidden';
            menuAnimationTimer = null;
        }, 900);
    }
}

function showMenuContentPage(selectedpage, openmenu, extradata) {
    switch (selectedpage) {
        case 'info':
            DOM.menuContent.innerHTML = `
                    <h1>Map Info</h1>
                    <p>This page was last updated on: May 15th, 2026</p>
                    <h2>Color Key</h2>
                    <div style="width: 100%; height: 75px; display: flex; flex-direction: row; align-items: center;"><div style="margin-right: 15px; height: 90%; aspect-ratio: 1 / 1; background-color: ${TRAIL_COLOR_MAP.purple}"></div><h2>${TRAIL_TEXT_MAP.purple}</h2></div>
                    </br>
                    <div style="width: 100%; height: 75px; display: flex; flex-direction: row; align-items: center;"><div style="margin-right: 15px; height: 90%; border-radius: 50%; aspect-ratio: 1 / 1; background-color: ${TRAIL_COLOR_MAP.green}"></div><h2>${TRAIL_TEXT_MAP.green}</h2></div>
                    </br>
                    <div style="width: 100%; height: 75px; display: flex; flex-direction: row; align-items: center;"><div style="margin-right: 15px; height: 90%; aspect-ratio: 1 / 1; background-color: ${TRAIL_COLOR_MAP.blue}"></div><h2>${TRAIL_TEXT_MAP.blue}</h2></div>
                    </br>
                    <div style="width: 100%; height: 75px; display: flex; flex-direction: row; align-items: center;">
                        <!-- Footprint container: holds the space as if unrotated -->
                        <div style="
                            margin-right: 15px;
                            height: 90%;
                            aspect-ratio: 1 / 1;
                            flex-shrink: 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        ">
                            <!-- Inner square scaled to 1/√2 so diagonal = container size when rotated -->
                            <div style="
                            width: 70.7%;
                            height: 70.7%;
                            background-color: ${TRAIL_COLOR_MAP.black};
                            transform: rotate(45deg);
                            "></div>
                        </div>

                        <h2>${TRAIL_TEXT_MAP.black}</h2>
                    </div>
                    </br>
                    <h2>Icon Key</h2>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Attraction.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Attraction</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Building.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Building</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Campsite.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Campsite</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Land.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Land</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Landmark.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Landmark</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Parking.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Parking</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Restroom.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Restroom</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Signage.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Signage</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/poi_icons/Water.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Water</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/icons/location_arrow_north.svg" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Map facing north</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/icons/location_arrow_locked.svg" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Map locked to compass</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/icons/target.svg" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Follow location</h3></div>
                    <div style="width: 100%; height: 40px; display: flex; flex-direction: row; align-items: center;"><img src="assets/icons/Info.png" style="height: 90%; aspect-ratio: 1/1; margin-right: 10px;"><h3>Info</h3></div>
                    </br>
                    <p>Made with care by JEMcats and Github Contributors</p>
                    <p>${SCRIPT_VERSION}</p>
                `
            break;
    }

    if (openmenu == true) {
        toggleMenuOpen(true);
    }
}

//#endregion Bottom Menu Toggle

//#region User Location Marker — Direction Arrow

function createDirectionIcon(rotationDeg) {
    rotationDeg = rotationDeg || 0;
    return L.divIcon({
        className: '',
        html: '<div style="position:relative;width:24px;height:24px;background-color:#007bff;' +
            'border-radius:50%;opacity:0.8;display:flex;align-items:center;justify-content:center;">' +
            '<img src="assets/icons/uparrow.svg" style="width:50px;height:50px;' +
            'transform:rotate(' + rotationDeg + 'deg);display:block;" alt="direction arrow"/>' +
            '</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -14],
    });
}

// Rotate the arrow directly in DOM (faster than recreating the entire marker)
function updateMarkerRotation(degrees) {
    if (!allUsersLocations.localUser || !allUsersLocations.localUser.getElement) return;
    const markerEl = allUsersLocations.localUser.getElement();
    if (!markerEl) return;
    const img = markerEl.querySelector('img');
    if (img) img.style.transform = 'rotate(' + degrees + 'deg)';
}

//#endregion User Location Marker

//#endregion FEATURE: User Interface Controls

//#region FEATURE: Compass & Orientation Sensor

//#region Compass Heading — Convert Degrees to Cardinal Directions

function degreesToCompass(degrees) {
    const normalized = ((degrees % 360) + 360) % 360;
    return COMPASS_DIRS[Math.round(normalized / 45) % 8];
}

//#endregion Compass Heading

//#region Compass Display Update — Apply Fused Heading to Map & UI

function applyCompassUpdate() {
    compassRafPending = false;

    const heading = pendingHeading;
    if (heading === null) return;

    // Update UI
    currentOrientation = heading;
    DOM.compassDir.textContent = degreesToCompass(heading);

    // Update map and marker based on compass mode
    if (rotatemapwithcompass) {
        // Map rotates with device — arrow points forward
        updateMarkerRotation(0);
        map.setBearing(-heading);
    } else {
        // Map stays north-up — arrow rotates to show heading
        updateMarkerRotation(heading);
        map.setBearing(0);
    }
}

//#endregion Compass Display Update

//#region Gyroscope Sensor — Detect Device Rotation Rate
// it uses the gyroscope to VALIDATE magnetometer readings — if the mag says you turned
// 30° but the gyro says you barely moved, the OS ignores the mag reading.
//
// Solution: We do the same thing using DeviceMotionEvent.rotationRate.
//
// Key design choice — gyro as "lie detector", not for integration:
//   We use the MAGNITUDE of the total rotation rate vector (sqrt(α²+β²+γ²)).
//   This is sign-convention-independent and works regardless of how the phone is
//   mounted (face-up, face-forward, angled). We never try to integrate the gyro
//   into a heading, which avoids axis/tilt/sign ambiguity entirely.
// ─────────────────────────────────────────────────────────────────────────

// Called on every DeviceMotionEvent to update device rotation rate estimate
function handleGyroEvent(event) {
    if (!event.rotationRate) return;
    const rate = event.rotationRate;

    // All three axes must be available for a meaningful measurement
    if (rate.alpha === null || rate.beta === null || rate.gamma === null) return;

    // Total rotation speed in deg/s, magnitude across all axes
    const totalRate = Math.sqrt(
        rate.alpha * rate.alpha +
        rate.beta * rate.beta +
        rate.gamma * rate.gamma
    );

    // Exponential moving average for smooth readings
    gyroRotationRate = gyroRotationRate * 0.7 + totalRate * 0.3;
}

//#endregion Gyroscope Sensor

//#region Magnetometer & Sensor Fusion — Filter MagSafe Interference
function handleMagReading(rawHeading) {
    // Track consecutive magnetometer reading jumps (wrap-aware to handle 359°→1° boundary)
    if (lastRawMagHeading !== null) {
        let delta = rawHeading - lastRawMagHeading;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        magJumpRate = magJumpRate * 0.8 + Math.abs(delta) * 0.2;
    }
    lastRawMagHeading = rawHeading;

    // Initialize on first reading
    if (fusedHeading === null) {
        fusedHeading = rawHeading;
        pendingHeading = fusedHeading;
        return;
    }

    // Detect magnetic interference using gyro as validator
    const deviceIsStill = gyroRotationRate < 5;   // deg/s
    const magIsErratic = magJumpRate > 3;        // deg/update
    const interferenceDetected = deviceIsStill && magIsErratic;

    let magWeight;
    if (interferenceDetected) {
        // MagSafe or similar is disturbing the magnetometer while the device is stationary.
        // Use a very small weight — the fused heading barely drifts, not chase the interference.
        magWeight = 0.02;
    } else if (magJumpRate < 1) {
        // Clean, stable signal — converge quickly to the true heading.
        magWeight = 0.15;
    } else {
        // Moderate noise (normal rotation, slight vibration) — blend at a moderate rate.
        magWeight = 0.08;
    }

    // Wrap-aware blend: move fusedHeading toward the raw reading by magWeight
    let diff = rawHeading - fusedHeading;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    fusedHeading = ((fusedHeading + diff * magWeight) + 360) % 360;

    // Feed the fused result into the rAF compass update system
    pendingHeading = fusedHeading;
    if (!compassRafPending) {
        compassRafPending = true;
        requestAnimationFrame(applyCompassUpdate);
    }
}

//#endregion Magnetometer & Sensor Fusion

//#region Compass Initialization — Request Permissions & Attach Sensors
function initCompass() {
    // Extract a raw heading from each DeviceOrientationEvent and route it through the filter.
    function handleOrientation(event) {
        let rawHeading;

        if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
            // iOS: webkitCompassHeading is already true-north referenced (0–360°)
            rawHeading = event.webkitCompassHeading;

            // webkitCompassAccuracy = estimated error in degrees (lower is better).
            // Above 25° means the sensor is unreliable and needs a figure-8 calibration.
            if (typeof event.webkitCompassAccuracy === 'number' && event.webkitCompassAccuracy > 25) {
                console.warn(
                    'Low compass accuracy (' + event.webkitCompassAccuracy + '°). ' +
                    'Move the device in a figure-8 pattern to calibrate.'
                );
            }
        } else if (event.alpha !== null && event.alpha !== undefined) {
            // Android / standard DeviceOrientationEvent.
            // Per the W3C spec, alpha is in the OPPOSITE sense to a compass heading,
            // so we subtract from 360 to convert to a standard clockwise bearing.
            if (!event.absolute) {
                console.warn(
                    'Compass heading is relative, not referenced to magnetic north. ' +
                    'Move the device in a figure-8 pattern to calibrate.'
                );
            }
            rawHeading = 360 - event.alpha;
        } else {
            console.warn('Compass heading unavailable on this device.');
            return;
        }

        // Route the raw reading through the adaptive interference filter
        handleMagReading(rawHeading);
    }

    function dismissPermissionPopup() {
        DOM.popupDiv.style.display = 'none';
        DOM.popupDiv.innerHTML = '';
    }

    function attachListeners() {
        window.addEventListener('deviceorientation', handleOrientation, true);
        window.addEventListener('devicemotion', handleGyroEvent, true);
    }

    if (!window.DeviceOrientationEvent) {
        console.error('Device orientation is not supported on this device.');
        dismissPermissionPopup();
        DOM.compassDir.textContent = 'NS'; // "Not Supported"
        return;
    }

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires permission for BOTH DeviceOrientation and DeviceMotion.
        // Both must be requested from the same user-gesture call chain.
        // We chain them: orientation first, then motion in the .then() while still
        // inside the gesture handler — iOS requires this ordering.
        DeviceOrientationEvent.requestPermission()
            .then(function (orientationState) {
                if (orientationState !== 'granted') {
                    dismissPermissionPopup();
                    console.error('Compass access denied by the user.');
                    DOM.compassDir.textContent = 'AD'; // "Access Denied"
                    return Promise.reject('orientation denied');
                }

                // Still inside the gesture chain — request gyro permission now
                if (typeof DeviceMotionEvent.requestPermission === 'function') {
                    return DeviceMotionEvent.requestPermission();
                }
                return Promise.resolve('granted');
            })
            .then(function (motionState) {
                dismissPermissionPopup();
                window.addEventListener('deviceorientation', handleOrientation, true);
                if (motionState === 'granted') {
                    window.addEventListener('devicemotion', handleGyroEvent, true);
                } else {
                    // Compass still works without the gyro; interference detection is just disabled
                    console.warn('Gyro access denied. Compass works but MagSafe interference detection is off.');
                }
            })
            .catch(function (err) {
                // 'orientation denied' is handled above; anything else is an unexpected error
                if (err !== 'orientation denied') {
                    console.error('Permission request failed:', err);
                    dismissPermissionPopup();
                    DOM.compassDir.textContent = 'PF'; // "Permission Failed"
                }
            });
    } else {
        // Android and other standard browsers — no permission prompt needed
        attachListeners();
        dismissPermissionPopup();
    }
}

// Prompt for compass/gyro permissions and initialize sensor listeners
DOM.popupDiv.innerHTML =
    '<h3>We need permission to access compass data. Press OK to continue.</h3>' +
    '<button onclick="initCompass()">OK</button>';
DOM.popupDiv.style.display = 'flex';

//#endregion Compass Initialization

//#endregion FEATURE: Compass & Orientation Sensor

//#region FEATURE: Map Core

//#region Map Initialization — Leaflet Setup & Tile Layer

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

//#endregion Map Initialization

//#endregion FEATURE: Map Core

//#region FEATURE: Map Rendering

//#region Trail Polyline Orientation — Calculate Text Direction

function computePolylineOrientation(polyline) {
    if (!map || !polyline) return null;

    // Flatten nested LatLng arrays to handle MultiPolyline
    const flat = [];
    (function flatten(arr) {
        for (let i = 0; i < arr.length; i++) {
            if (Array.isArray(arr[i])) {
                flatten(arr[i]);
            } else {
                flat.push(arr[i]);
            }
        }
    })(polyline.getLatLngs());

    if (flat.length < 2) return null;

    const pts = flat.map(function (ll) { return map.latLngToLayerPoint(ll); });
    const dx = pts[pts.length - 1].x - pts[0].x;
    const dy = pts[pts.length - 1].y - pts[0].y;
    let angle = Math.atan2(dy, dx) * 180 / Math.PI - (rotationAngle || 0);
    angle = ((angle + 180) % 360) - 180;

    return (angle > 90 || angle < -90) ? 'flip' : null;
}

//#endregion Trail Polyline Orientation

//#region Zoom-Responsive Updates — Adjust Trail Weights & POI Sizes

function adjustTrailWeights() {
    const weight = 12 * Math.pow(2, map.getZoom() - 19);
    trailPolylines.forEach(function (line) { line.setStyle({ weight: weight }); });
    trailWhiteLines.forEach(function (line) { line.setStyle({ weight: weight }); });
}
function updatePoiTooltips() {
    const zoom = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const offset = TOOLTIP_OFFSETS[zoom] || TOOLTIP_OFFSETS[REFERENCE_ZOOM];

    poiMarkers.forEach(function (marker) {
        try {
            const content = marker.tooltipContent;
            marker.unbindTooltip();

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(content || '', {
                    permanent: true,
                    direction: 'center',
                    className: 'poiLabel',
                    offset: offset,
                });
                const fontSize = Math.max(6, Math.round(POI_TOOLTIP_BASE_FONT * markerScale));
                const tooltip = marker.getTooltip();
                const el = tooltip ? tooltip.getElement() : null;
                if (el) el.style.fontSize = fontSize + 'px';
            }
        } catch (e) {
            // Non-fatal — skip if marker has issues
        }
    });
}

function updatePoiIconSizes() {
    const zoom = map.getZoom();
    const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
    const BASE = 32;

    poiMarkers.forEach(function (marker) {
        if (!marker.iconUrls || !marker.iconUrls.length) return;

        const numIcons = marker.iconUrls.length;
        const perW = Math.max(1, Math.round(BASE * markerScale));
        const totalW = Math.max(1, Math.round(BASE * numIcons * markerScale));

        const html = marker.iconUrls.map(function (url) {
            return '<img src="' + url + '" style="width:' + perW + 'px;height:' + perW + 'px;float:left;">';
        }).join('');

        marker.setIcon(L.divIcon({
            html: html,
            iconSize: [totalW, perW],
            iconAnchor: [Math.round(totalW / 2), Math.round(perW / 2)],
            className: 'custom-poi-icon',
        }));
    });
}

// Listen for zoom changes and update all zoom-dependent elements
map.on('zoomend', function () {
    adjustTrailWeights();
    updatePoiIconSizes();
    updatePoiTooltips();
});

//#endregion Zoom-Responsive Updates

//#endregion FEATURE: Map Rendering

//#region FEATURE: Data Management

//#region Data Fetching & Caching — Load Trails and POI from JSON
async function fetchData() {
    try {
        if (!cachedMapData) {
            const response = await fetch('assets/data.json');
            cachedMapData = await response.json();
        }

        const data = cachedMapData;

        // Clear the open-popup tracking set BEFORE removing layers from the map.
        // If we don't do this, the Set holds references to dead layer objects (memory leak),
        // and the moveend handler may try to re-open popups on removed markers.
        openPopupLayers.clear();

        // Remove all non-tile, non-user layers before redrawing
        map.eachLayer(function (layer) {
            const isUserLayer = layer.options && layer.options.pane === 'userPane';
            if (!(layer instanceof L.TileLayer) && !isUserLayer) {
                map.removeLayer(layer);
            }
        });

        poiMarkers = [];
        trailPolylines = [];
        trailWhiteLines = [];

        // --- Trails ---
        data.trails.forEach(function (trail) {
            const latLngs = trail.coordinates.map(function (pair) {
                return L.latLng(pair[0], pair[1]);
            });

            const polyline = L.polyline(latLngs, {
                color: 'black',
                weight: 12,
                opacity: 1,
                smoothFactor: 1,
            }).addTo(map);
            trailPolylines.push(polyline);

            const whiteLine = L.polyline(latLngs, {
                color: TRAIL_COLOR_MAP[trail.difficulty],
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

            whiteLine.on('click', function (e) {
                const lat = e.latlng.lat;
                const lng = e.latlng.lng;
                L.popup()
                    .setLatLng(e.latlng)
                    .setContent(
                        '<h2 style="margin-bottom:0">' + trail.name + '</h2>' +
                        '<h4 style="margin:5px 0">' + TRAIL_TEXT_MAP[trail.difficulty] + '</h4>' +
                        '<p style="margin-bottom:0">Location: ' + MAPLE.encodeCoords(lat, lng) + '</p>' +
                        '<p style="margin-top:0">LATLNG: ' + lat + ', ' + lng + '</p>' +
                        '<button onclick="makeReport(' + lat + ',' + lng + ')">Make a report here</button>'
                    )
                    .openOn(map);
            });
        });

        adjustTrailWeights();

        // --- Points of Interest ---
        const zoom = map.getZoom();
        const markerScale = Math.pow(2, zoom - REFERENCE_ZOOM);
        const offset = TOOLTIP_OFFSETS[zoom] || TOOLTIP_OFFSETS[REFERENCE_ZOOM];

        data.pointsOfInterest.forEach(function (poi) {
            const types = poi.type.split(',').map(function (t) { return t.trim(); });
            const iconUrls = types.map(function (type) {
                const url = 'assets/poi_icons/' + type + '.png';
                cachedIcons[url] = cachedIcons[url] || url;
                return cachedIcons[url];
            });

            const BASE_ICON_SIZE = 32;
            const totalW = BASE_ICON_SIZE * types.length;
            const perIconW = Math.max(1, Math.round(BASE_ICON_SIZE * markerScale));
            const scaledW = Math.max(1, Math.round(totalW * markerScale));

            const iconHtml = iconUrls.map(function (url) {
                return '<img src="' + url + '" style="width:' + perIconW + 'px;height:' + perIconW + 'px;float:left;">';
            }).join('');

            const icon = L.divIcon({
                html: iconHtml,
                iconSize: [scaledW, perIconW],
                iconAnchor: [Math.round(scaledW / 2), Math.round(perIconW / 2)],
                className: 'custom-poi-icon',
            });

            const marker = L.marker(poi.coordinates, { icon: icon }).addTo(map);
            marker.setZIndexOffset(2000);
            marker.tooltipContent = poi.name;
            marker.baseFont = POI_TOOLTIP_BASE_FONT;
            marker.baseSize = [totalW, BASE_ICON_SIZE];
            marker.iconUrls = iconUrls;

            if (zoom >= REFERENCE_ZOOM) {
                marker.bindTooltip(poi.name, {
                    permanent: true,
                    direction: 'center',
                    className: 'poiLabel',
                    offset: offset,
                });
                setTimeout(function () {
                    const tooltip = marker.getTooltip();
                    const el = tooltip ? tooltip.getElement() : null;
                    if (el) {
                        el.style.fontSize =
                            Math.max(6, Math.round(POI_TOOLTIP_BASE_FONT * markerScale)) + 'px';
                    }
                }, 50);
            }

            const typeLabel = types.map(function (t) {
                return t.charAt(0).toUpperCase() + t.slice(1);
            }).join(', ');

            marker.bindPopup(
                L.popup({ autoClose: true, closeOnClick: false, closeButton: true, autoPan: true })
                    .setContent(
                        '<h2 style="margin-bottom:0">' + poi.name + '</h2>' +
                        '<h4 style="margin:5px 0">' + typeLabel + '</h4>' +
                        '<p style="margin-top:0">Open: ' + (POI_TEXT_MAP[poi.opperation_time] || poi.opperation_time) + '</p>' +
                        '<p style="margin-bottom:0">Location: ' + MAPLE.encodeCoords(poi.coordinates[0], poi.coordinates[1]) + '</p>' +
                        '<p style="margin-top:0">LATLNG: ' + poi.coordinates[0] + ', ' + poi.coordinates[1] + '</p>' +
                        '<button onclick="makeReport(' + poi.coordinates[0] + ',' + poi.coordinates[1] + ')">Make a report here</button>'
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

//#endregion Data Fetching & Caching

//#endregion FEATURE: Data Management

//#region FEATURE: User Location & Geolocation

//#region Speed Formatting — Convert m/s to mph

function formatSpeed(speedMps) {
    if (typeof speedMps !== 'number' || isNaN(speedMps)) return null;
    return (speedMps * 2.2369362920544).toFixed(1);
}

//#endregion Speed Formatting

//#region User Location Update — Marker Position, Speed Display, Follow Mode

// Move to follow view on timer
setInterval(() => {
    if (DOM.followToggle.checked && lastLocalPosition.lat && lastLocalPosition.lng && document.body.classList.contains('leaflet-dragging') == false) {
        map.setView([lastLocalPosition.lat, lastLocalPosition.lng]);
    }
}, 500);

function updateLocalUserLocation(position) {
    if (!position || !position.coords) {
        console.error('Invalid position object:', position);
        return;
    }

    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const gpsSpeed = position.coords.speed;

    // Use GPS-reported speed when available; fall back to calculating from displacement
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

    const formattedSpeed = formatSpeed(speedMps) || '--.-';
    if (DOM.speedReading) DOM.speedReading.textContent = formattedSpeed;

    // currentOrientation is set by the compass and read here for display only
    const popupContent =
        '<h2 style="margin-bottom:5px">Your latest location</h2>' +
        '<p style="margin-bottom:0">Location: ' + MAPLE.encodeCoords(lat, lng) + '</p>' +
        '<p style="margin-top:0">LATLNG: ' + lat + ', ' + lng + '</p>' +
        '<p style="margin-bottom:0">Direction: ' + degreesToCompass(currentOrientation) + ' / ' + currentOrientation.toFixed(2) + '</p>' +
        '<p style="margin-top:0">Speed: ' + formattedSpeed + '</p>' +
        '<button onclick="makeReport(' + lat + ',' + lng + ')">Make a report here</button>';

    // Capture previous position BEFORE updating the marker to get correct moved distance
    const prevLatLng = allUsersLocations.localUser ? allUsersLocations.localUser.getLatLng() : null;
    const movedDist = prevLatLng ? L.latLng(lat, lng).distanceTo(prevLatLng) : Infinity;

    if (allUsersLocations.localUser) {
        allUsersLocations.localUser.setLatLng([lat, lng]);
        const popup = allUsersLocations.localUser.getPopup();
        if (popup) popup.setContent(popupContent);
    } else {
        // Create the marker once — rotation is updated cheaply through updateMarkerRotation()
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

    lastLocalPosition = { lat: lat, lng: lng, time: position.timestamp || Date.now() };

    // Follow mode: re-center the map on the user's position when enabled
    if (!DOM.followToggle.checked) return;

    const now = Date.now();
    const tooSoon = (now - lastFollowSetTime) < FOLLOW_SET_MIN_MS;

    if (movedDist >= FOLLOW_MIN_DIST_METERS || !tooSoon) {
        suppressMoveendFetch = true;
        lastFollowSetTime = now;
        // Safety: clear the flag if moveend never fires (e.g. map was not actually moved)
        setTimeout(function () { suppressMoveendFetch = false; }, 1000);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Geolocation Error Handling
// ─────────────────────────────────────────────────────────────────────────

function handleLocationError(error) {
    console.error('Geolocation error (code ' + error.code + '):', error.message);

    if (error.code === error.TIMEOUT) {
        console.warn('GPS timed out — restarting watch.');
        restartGpsWatch();
    } else if (error.code === error.PERMISSION_DENIED) {
        alert('Location access was denied. Enable it in your browser settings to use the map.');
    } else if (error.code === error.POSITION_UNAVAILABLE) {
        console.warn('GPS position currently unavailable (poor signal). Waiting for fix...');
    }
}

// ─────────────────────────────────────────────────────────────────────────
// GPS Watch Management — Start, Stop & Restart Geolocation
// ─────────────────────────────────────────────────────────────────────────

function startGpsWatch() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }
    gpsWatchId = navigator.geolocation.watchPosition(
        updateLocalUserLocation,
        handleLocationError,
        {
            enableHighAccuracy: true,
            maximumAge: 500,
            timeout: 15000,
        }
    );
}

function restartGpsWatch() {
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    startGpsWatch();
}

// Initialize GPS watch on page load
startGpsWatch();

//#endregion GPS Watch Management

//#endregion FEATURE: User Location & Geolocation

//#region FEATURE: Map Interactions

//#region Popup Persistence — Reopen Popups After Map Movement

map.on('movestart', function () {
    openPopupLayers.clear();

    const candidates = poiMarkers.slice(); // copy so we don't mutate the original
    if (allUsersLocations.localUser) {
        candidates.push(allUsersLocations.localUser);
    }

    candidates.forEach(function (layer) {
        if (layer && layer.getPopup && layer.getPopup() && layer.isPopupOpen && layer.isPopupOpen()) {
            openPopupLayers.add(layer);
            layer.closePopup();
        }
    });
});

map.on('moveend', function () {
    if (suppressMoveendFetch) {
        suppressMoveendFetch = false;
        return;
    }

    if (!openPopupLayers.size) return;

    setTimeout(function () {
        openPopupLayers.forEach(function (layer) {
            if (layer && layer.getPopup && layer.getPopup() && layer.isPopupOpen && !layer.isPopupOpen()) {
                layer.openPopup();
            }
        });
        openPopupLayers.clear();
    }, 250);
});

// ─────────────────────────────────────────────────────────────────────────
// Follow Mode Toggle — Center Map on User Location
// ─────────────────────────────────────────────────────────────────────────

DOM.followToggle.checked = localStorage.getItem('FollowToggleState') === 'true';
DOM.followToggle.addEventListener('change', function () {
    localStorage.setItem('FollowToggleState', String(DOM.followToggle.checked));
});

//#endregion Follow Mode Toggle

//#region Coordinate Selection — Right-Click or Triple-Tap to Select Location

function showMapPopup(latlng) {
    map.setView(latlng);
    setTimeout(function () {
        L.popup({ closeOnClick: true, autoClose: false, autoPan: false })
            .setLatLng(latlng)
            .setContent(
                '<h2 style="margin-bottom:5px">You have selected:</h2>' +
                '<p style="margin-bottom:0">Location: ' + MAPLE.encodeCoords(latlng.lat, latlng.lng) + '</p>' +
                '<p style="margin-top:0">LATLNG: ' + latlng.lat + ', ' + latlng.lng + '</p>' +
                '<button onclick="makeReport(' + latlng.lat + ',' + latlng.lng + ')">Make a report here</button>'
            )
            .openOn(map);
    }, 400);
}

// Right-click (desktop) to select coordinate
map.on('contextmenu', function (e) { showMapPopup(e.latlng); });

// Triple-tap (touch) detection
let tapCount = 0;
let lastTapTime = 0;

map.getContainer().addEventListener('touchend', function (e) {
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
        e.preventDefault();
        tapCount = 0;
    }
});

//#region FEATURE: User Feedback

//#region Report Submission — Send Location Issues to Server

function makeReport(lat, lng) {
    const location_name = prompt('Please give a name for this location.');
    if (location_name === null) return;

    const url = 'https://easy-map.mattheis.ddns.net/windingtrails/makereport';
    const payload = { name: location_name, coords: [lat, lng] };

    fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
        .then(function (resp) {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                return resp.json().then(function (data) { return JSON.stringify(data); });
            }
            return resp.text();
        })
        .then(function (out) {
            alert(out);
        })
        .catch(function (err) {
            alert('Error sending report: ' + (err && err.message ? err.message : String(err)));
        });
}

//#endregion Report Submission

//#endregion FEATURE: User Feedback

//#endregion WINDING TRAILS DIGITAL MAP