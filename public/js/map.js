// Shared Leaflet setup for Columbus: OpenStreetMap tiles with attribution, and the A and B pins.

export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export function createMap(elementId, { zoomControl = true, attributionPosition = 'bottomright' } = {}) {
  const map = L.map(elementId, { zoomControl: false, attributionControl: false }).setView([20, 0], 2);
  if (zoomControl) L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer(TILE_URL, { maxZoom: 19, className: 'lt-tiles' }).addTo(map);
  L.control.attribution({ position: attributionPosition, prefix: false }).addTo(map).addAttribution(ATTRIBUTION);
  return map;
}

export function centreOn(map, point, { cover = null, animate = false } = {}) {
  const zoom = map.getZoom();
  let shift = 0;
  if (cover && cover.offsetHeight) {
    const mapTop = map.getContainer().getBoundingClientRect().top;
    const coverTop = cover.getBoundingClientRect().top - mapTop;
    shift = (map.getSize().y - coverTop) / 2;
  }
  const centre = map.unproject(map.project([point.lat, point.lng], zoom).add([0, shift]), zoom);
  map.setView(centre, zoom, { animate });
}

export function pinIcon(letter, variant) {
  return L.divIcon({
    className: 'lt-pin-icon',
    html: `<div class="lt-pin lt-pin--${variant}"><span>${letter}</span><div class="lt-pin-pulse"></div></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 44],
  });
}
