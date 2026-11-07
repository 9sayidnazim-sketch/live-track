// The vehicle marker & glider. Supports custom colors (White, Orange, Teal, Green, Red, Purple, Black)
// and custom pointer types (Car vs Directional Navigation Arrow).
import { angleDelta, clamp, lerpPoint } from './geo.js';

export const COLOR_THEMES = {
  orange: {
    name: 'Sport Orange',
    primary: '#f97316',
    dark: '#ea580c',
    glow: 'rgba(249, 115, 22, 0.45)',
    wheels: '#1e293b',
  },
  white: {
    name: 'Pure White',
    primary: '#ffffff',
    dark: '#cbd5e1',
    glow: 'rgba(255, 255, 255, 0.65)',
    wheels: '#0f172a',
  },
  teal: {
    name: 'Teal Green',
    primary: '#0d9488',
    dark: '#0f766e',
    glow: 'rgba(13, 148, 136, 0.45)',
    wheels: '#1e293b',
  },
  green: {
    name: 'Emerald Green',
    primary: '#10b981',
    dark: '#059669',
    glow: 'rgba(16, 185, 129, 0.45)',
    wheels: '#1e293b',
  },
  red: {
    name: 'Crimson Red',
    primary: '#ef4444',
    dark: '#dc2626',
    glow: 'rgba(239, 68, 68, 0.45)',
    wheels: '#1e293b',
  },
  purple: {
    name: 'Royal Purple',
    primary: '#8b5cf6',
    dark: '#7c3aed',
    glow: 'rgba(139, 92, 246, 0.45)',
    wheels: '#1e293b',
  },
  black: {
    name: 'Stealth Black',
    primary: '#1e293b',
    dark: '#0f172a',
    glow: 'rgba(15, 23, 42, 0.5)',
    wheels: '#000000',
  },
};

export function getMarkerSvg(type = 'car', colorKey = 'orange') {
  const theme = COLOR_THEMES[colorKey] ?? COLOR_THEMES.orange;

  if (type === 'arrow') {
    return `
<svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true" focusable="false">
  <!-- Heading directional radar beam -->
  <path d="M26 26 L10 2 A24 24 0 0 1 42 2 Z" fill="${theme.glow}" opacity="0.4"/>
  <circle cx="26" cy="26" r="23" fill="none" stroke="${theme.primary}" stroke-width="1.8" opacity="0.45" stroke-dasharray="3 3"/>
  <circle cx="26" cy="26" r="16" fill="${theme.glow}" opacity="0.2"/>
  <!-- High-contrast Navigation Arrowhead -->
  <g filter="drop-shadow(0 4px 10px rgba(0,0,0,0.35))">
    <path d="M26 5 L42 43 L26 34 L10 43 Z" fill="${theme.primary}" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M26 7 L26 34 L10 43 Z" fill="${theme.dark}" opacity="0.45"/>
    <circle cx="26" cy="24" r="3.5" fill="#ffffff" filter="drop-shadow(0 1px 2px rgba(0,0,0,0.4))"/>
  </g>
</svg>`;
  }

  // Aerodynamic Car Marker
  return `
<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
  <!-- Subtle radar pulse halo -->
  <circle cx="24" cy="24" r="22" fill="none" stroke="${theme.primary}" stroke-width="1.6" opacity="0.4" stroke-dasharray="3 3"/>
  <circle cx="24" cy="24" r="15" fill="${theme.glow}" opacity="0.2"/>
  
  <!-- Wheels -->
  <rect x="8" y="9" width="6" height="9" rx="2" fill="${theme.wheels}" stroke="#64748b" stroke-width="0.8"/>
  <rect x="34" y="9" width="6" height="9" rx="2" fill="${theme.wheels}" stroke="#64748b" stroke-width="0.8"/>
  <rect x="8" y="30" width="6" height="9" rx="2" fill="${theme.wheels}" stroke="#64748b" stroke-width="0.8"/>
  <rect x="34" y="30" width="6" height="9" rx="2" fill="${theme.wheels}" stroke="#64748b" stroke-width="0.8"/>

  <!-- Vehicle Body -->
  <path d="M15 6h18a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z"
        fill="${theme.primary}" stroke="#ffffff" stroke-width="2.2"/>

  <!-- Front Windshield -->
  <path d="M15 14h18l1.4 7H13.6z" fill="#0f172a" opacity="0.88"/>

  <!-- Cabin Roof -->
  <rect x="15" y="22" width="18" height="9" rx="2" fill="${theme.dark}" stroke="#ffffff" stroke-width="0.8"/>

  <!-- Rear Windshield -->
  <path d="M16 33h16l-1 3.5H17z" fill="#0f172a" opacity="0.85"/>

  <!-- Front Headlights (white LED) -->
  <rect x="14" y="3.5" width="4" height="2" rx="1" fill="#ffffff" stroke="#94a3b8" stroke-width="0.5"/>
  <rect x="30" y="3.5" width="4" height="2" rx="1" fill="#ffffff" stroke="#94a3b8" stroke-width="0.5"/>
  
  <!-- Rear Brakelights (red LED) -->
  <rect x="15" y="41.5" width="18" height="1.8" rx="0.9" fill="#ef4444"/>
</svg>`;
}

export class Glider {
  constructor({ onFrame, clock = {} }) {
    this.onFrame = onFrame;
    this.raf = clock.raf ?? ((callback) => requestAnimationFrame(callback));
    this.caf = clock.caf ?? ((id) => cancelAnimationFrame(id));
    this.now = clock.now ?? (() => performance.now());
    this.current = null;
    this.from = null;
    this.to = null;
    this.startedAt = 0;
    this.duration = 0;
    this.frameId = null;
  }

  get position() {
    return this.current;
  }

  place(point) {
    this.stop();
    this.current = { lat: point.lat, lng: point.lng };
    this.onFrame(this.current, 1);
  }

  glideTo(target, duration) {
    if (!this.current) {
      this.place(target);
      return;
    }
    this.from = this.current;
    this.to = { lat: target.lat, lng: target.lng };
    this.startedAt = this.now();
    this.duration = duration;
    if (this.frameId === null) this.frameId = this.raf(this.tick);
  }

  stop() {
    if (this.frameId !== null) this.caf(this.frameId);
    this.frameId = null;
  }

  tick = () => {
    const t = this.duration > 0 ? clamp((this.now() - this.startedAt) / this.duration, 0, 1) : 1;
    this.current = lerpPoint(this.from, this.to, t);
    this.onFrame(this.current, t);
    this.frameId = t < 1 ? this.raf(this.tick) : null;
  };
}

export class CarMarker {
  constructor(map, start, { color = 'orange', type = 'car' } = {}) {
    this.heading = 0;
    this.color = color;
    this.type = type;
    this.marker = L.marker([start.lat, start.lng], {
      icon: L.divIcon({
        className: 'lt-car-icon',
        html: `<div class="lt-car">${getMarkerSvg(this.type, this.color)}</div>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);
    this.marker.on('add', () => this.paintHeading());
  }

  setLatLng(point) {
    this.marker.setLatLng([point.lat, point.lng]);
  }

  setHeading(bearing) {
    this.heading += angleDelta(this.heading, bearing);
    this.paintHeading();
  }

  paintHeading() {
    const el = this.marker.getElement()?.querySelector('.lt-car');
    if (el) el.style.transform = `rotate(${this.heading.toFixed(1)}deg)`;
  }

  setStyle({ color, type }) {
    if (color) this.color = color;
    if (type) this.type = type;
    const el = this.marker.getElement();
    if (el) {
      el.innerHTML = `<div class="lt-car">${getMarkerSvg(this.type, this.color)}</div>`;
      this.paintHeading();
    }
  }
}
