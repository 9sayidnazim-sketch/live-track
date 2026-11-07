// Settings: manage the API key, the share link, and vehicle appearance for this device.
import { api, ApiError } from './api-client.js';
import { getSession, setSession, getMarkerColor, setMarkerColor, getMarkerType, setMarkerType } from './store.js';
import { COLOR_THEMES, getMarkerSvg } from './car.js';
import { $, $$, copyText } from './common.js';

const enc = encodeURIComponent;
const origin = location.origin;

const els = {
  badge: $('#key-badge'),
  keyStatus: $('#key-status'),
  sessionId: $('#session-id'),
  created: $('#session-created'),
  keyField: $('#key-field'),
  reveal: $('#reveal'),
  copyKey: $('#copy-key'),
  generate: $('#generate'),
  regenerate: $('#regenerate'),
  revoke: $('#revoke'),
  curlLatest: $('#curl-latest'),
  curlPost: $('#curl-post'),
  shareField: $('#share-field'),
  share: $('#share'),
  copyShare: $('#copy-share'),
  resetShare: $('#reset-share'),
  notice: $('#notice'),
  markerPreviewIcon: $('#marker-preview-icon'),
  btnSymbolCar: $('#set-symbol-car'),
  btnSymbolArrow: $('#set-symbol-arrow'),
  selectedThemeName: $('#selected-theme-name'),
  settingsSwatches: $$('#settings-swatches .color-swatch'),
};

// 'active' once the server confirms the key, 'revoked' if the server rejects it,
// 'unknown' if the check could not be made, and 'none' when this device has no session.
let verdict = 'none';
let revealed = false;

function notice(message, tone = 'info') {
  els.notice.textContent = message;
  els.notice.dataset.tone = tone;
}

const maskKey = (key) => `lt_${'•'.repeat(20)}${key.slice(-4)}`;

function shareUrl(session) {
  const color = getMarkerColor();
  const type = getMarkerType();
  return session ? `${origin}/live.html?session=${enc(session.id)}&share=${enc(session.shareToken)}&color=${enc(color)}&type=${enc(type)}` : '';
}

const STATUS = {
  active: ['Active', 'live'],
  revoked: ['Revoked on the server', 'off'],
  unknown: ['Could not check. The server may be offline.', 'off'],
  none: ['No key on this device', 'off'],
};

/** Redraws everything from the stored session. */
function render() {
  const session = getSession();
  const [text, tone] = STATUS[verdict];
  els.badge.dataset.tone = tone;
  els.keyStatus.textContent = text;

  els.sessionId.textContent = session?.id ?? 'None yet';
  els.created.textContent = session?.createdAt
    ? new Date(session.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '-';

  const key = session?.apiKey ?? '';
  els.keyField.value = key ? (revealed ? key : maskKey(key)) : '';
  els.reveal.textContent = revealed ? 'Hide' : 'Show';
  els.reveal.disabled = !key;
  els.copyKey.disabled = !key;

  // A key that the server rejected can only be replaced, not regenerated.
  const hasLiveKey = Boolean(session) && verdict !== 'revoked' && verdict !== 'none';
  els.generate.hidden = hasLiveKey;
  els.regenerate.hidden = !hasLiveKey;
  els.revoke.hidden = !hasLiveKey;
  els.resetShare.hidden = !hasLiveKey;
  els.shareField.value = session && verdict !== 'revoked' ? shareUrl(session) : '';

  const keyText = key || 'YOUR_API_KEY';
  const sessionText = session?.id ?? 'SESSION_ID';
  els.curlLatest.textContent =
    `curl -H "x-api-key: ${keyText}" \\\n` +
    `  "${origin}/api/location/latest?session_id=${sessionText}"`;
  els.curlPost.textContent =
    `curl -X POST "${origin}/api/location" \\\n` +
    `  -H "x-api-key: ${keyText}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"lat": 51.5007, "lng": -0.1246, "accuracy": 8, "speed": null}'`;
}

/** Asks the server whether this device's key still works. */
async function verify() {
  const session = getSession();
  if (!session) {
    verdict = 'none';
    return render();
  }
  try {
    await api(`/api/session/${enc(session.id)}`, { apiKey: session.apiKey });
    verdict = 'active';
  } catch (err) {
    verdict = err instanceof ApiError && err.status === 401 ? 'revoked' : 'unknown';
  }
  render();
}

// ---- Actions -------------------------------------------------------------------

els.generate.addEventListener('click', async () => {
  try {
    const created = await api('/api/sessions', { method: 'POST' });
    setSession({
      id: created.session_id,
      apiKey: created.api_key,
      shareToken: created.share_token,
      createdAt: created.created_at,
    });
    verdict = 'active';
    revealed = false;
    notice('A new key is saved on this device. Tracking uses it the next time you tap Allow GPS.', 'success');
    render();
  } catch (err) {
    notice(err.message, 'error');
  }
});

els.regenerate.addEventListener('click', async () => {
  const session = getSession();
  if (!session) return;
  if (!window.confirm('Regenerate the API key? The current key stops working straight away.')) return;
  try {
    const res = await api(`/api/session/${enc(session.id)}/key`, { method: 'POST', apiKey: session.apiKey });
    setSession({ ...session, apiKey: res.api_key });
    notice('New key saved on this device. The old key no longer works.', 'success');
    render();
  } catch (err) {
    notice(err.message, 'error');
    verify();
  }
});

els.revoke.addEventListener('click', async () => {
  const session = getSession();
  if (!session) return;
  const warning =
    'Revoke this key? Tracking stops on this device. Every app and share link that uses this session loses access. This cannot be undone.';
  if (!window.confirm(warning)) return;
  try {
    await api(`/api/session/${enc(session.id)}/key`, { method: 'DELETE', apiKey: session.apiKey });
    notice('Key revoked. Tracking has stopped, and the share link no longer works.', 'success');
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      notice(err.message, 'error');
      return;
    }
    notice('This key was already revoked.', 'info');
  }
  verdict = 'revoked';
  render();
});

els.reveal.addEventListener('click', () => {
  revealed = !revealed;
  render();
});

els.copyKey.addEventListener('click', async () => {
  const key = getSession()?.apiKey;
  if (!key) return;
  const ok = await copyText(key);
  notice(ok ? 'API key copied.' : 'Could not copy. Show the key and copy it by hand.', ok ? 'success' : 'error');
});

els.share.addEventListener('click', async () => {
  const session = getSession();
  if (!session || verdict === 'revoked') {
    notice('Generate a new key first. A share link needs an active session.', 'error');
    return;
  }
  // Open the link straight away, so the browser treats it as part of this click.
  window.open(shareUrl(session), '_blank', 'noopener');
  const ok = await copyText(shareUrl(session));
  notice(ok ? 'Share link opened in a new tab and copied.' : 'Share link opened in a new tab.', 'success');
});

els.copyShare.addEventListener('click', async () => {
  const url = shareUrl(getSession());
  if (!url) return notice('Generate a new key first.', 'error');
  const ok = await copyText(url);
  notice(ok ? 'Share link copied.' : 'Could not copy. Select the link and copy it by hand.', ok ? 'success' : 'error');
});

els.resetShare.addEventListener('click', async () => {
  const session = getSession();
  if (!session) return;
  if (!window.confirm('Reset the share link? The current link stops working straight away.')) return;
  try {
    const res = await api(`/api/session/${enc(session.id)}/share-link`, { method: 'POST', apiKey: session.apiKey });
    setSession({ ...session, shareToken: res.share_token });
    notice('Share link reset. Send the new link to anyone who needs it.', 'success');
    render();
  } catch (err) {
    notice(err.message, 'error');
  }
});

$$('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = $(`#${button.dataset.copy}`).textContent;
    const ok = await copyText(text);
    notice(ok ? 'Command copied.' : 'Could not copy. Select the command and copy it by hand.', ok ? 'success' : 'error');
  });
});

// ---- Vehicle & Pointer Customizer ---------------------------------------------

function renderCustomizer() {
  const color = getMarkerColor();
  const type = getMarkerType();

  if (els.markerPreviewIcon) {
    els.markerPreviewIcon.innerHTML = getMarkerSvg(type, color);
  }

  if (els.selectedThemeName) {
    els.selectedThemeName.textContent = COLOR_THEMES[color]?.name ?? color;
  }

  const isCar = type === 'car';
  if (els.btnSymbolCar) {
    els.btnSymbolCar.setAttribute('aria-pressed', String(isCar));
    els.btnSymbolCar.classList.toggle('active', isCar);
  }
  if (els.btnSymbolArrow) {
    els.btnSymbolArrow.setAttribute('aria-pressed', String(!isCar));
    els.btnSymbolArrow.classList.toggle('active', !isCar);
  }

  els.settingsSwatches.forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color === color);
  });
}

els.btnSymbolCar?.addEventListener('click', () => {
  setMarkerType('car');
  renderCustomizer();
  notice('Vehicle symbol updated to Car. The tracking map display has been updated.', 'success');
});

els.btnSymbolArrow?.addEventListener('click', () => {
  setMarkerType('arrow');
  renderCustomizer();
  notice('Vehicle symbol updated to Directional Pointer Arrow. The tracking map display has been updated.', 'success');
});

els.settingsSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    const color = swatch.dataset.color;
    if (color && COLOR_THEMES[color]) {
      setMarkerColor(color);
      renderCustomizer();
      notice(`Color theme updated to ${COLOR_THEMES[color].name}. The tracking map display has been updated.`, 'success');
    }
  });
});

// Keep the page current when the key changes in another tab, or the tracker changes it.
window.addEventListener('storage', () => {
  revealed = false;
  verify();
  renderCustomizer();
});

render();
renderCustomizer();
verify();
