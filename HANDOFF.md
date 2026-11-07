# Columbus: Live GPS Tracking & Telemetry System — Handoff

Updated 2026-11-07.

## Live Deployment Links

- **GitHub Repository**: [https://github.com/9sayidnazim-sketch/live-track](https://github.com/9sayidnazim-sketch/live-track)
- **Vercel Production**: [https://live-track-phi.vercel.app](https://live-track-phi.vercel.app)
  - Settings: [https://live-track-phi.vercel.app/settings](https://live-track-phi.vercel.app/settings)
  - API Health: [https://live-track-phi.vercel.app/api/health](https://live-track-phi.vercel.app/api/health)
- **AWS Lambda (Function URL)**: [https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/](https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/)
  - Settings: [https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/settings](https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/settings)
  - API Health: [https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/api/health](https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/api/health)
- **Local Server**: [http://127.0.0.1:3000](http://127.0.0.1:3000)

---

## Completed Features

1. **Brand Identity: Columbus**:
   - Replaced all "Live Track" references with **Columbus**.
   - Custom compass and voyager star iconography for brand badge and favicon.

2. **Clean, Simpler Map & Roundish Design System (White, Gray, Teal-Green & Red)**:
   - Palette: Crisp white surfaces (`#ffffff`), soft slate gray cards (`#f1f5f9`), teal-green accents (`#0d9488`) for live status and start actions, and coral red (`#ef4444`) for destination and stop actions.
   - Simplified map tiles with clean contrast and uncluttered road geometry.
   - Soft roundish UI architecture: pill buttons, circular cockpit dials, rounded drawers, and smooth elevation.

3. **Removed Initial Gate Barrier**:
   - Deleted the blocking startup permission screen.
   - Columbus launches immediately into the live map view.
   - Seamless, non-intrusive floating permission banner only if GPS has not yet been granted.

4. **Vehicle & Pointer Customization (Settings Page Only with Instant Live Sync)**:
   - Vehicle Symbol options:
     - 🚗 Aerodynamic Car
     - 🧭 High-contrast Directional Navigation Pointer Arrow
   - 7 Custom Color Themes:
     - Pure White (`#ffffff`)
     - Sport Orange (`#f97316`)
     - Teal Green (`#0d9488`)
     - Emerald Green (`#10b981`)
     - Crimson Red (`#ef4444`)
     - Royal Purple (`#8b5cf6`)
     - Stealth Black (`#1e293b`)
   - Customizer lives exclusively in Settings (`settings.html`) to keep the main tracking map cockpit clean and uncluttered.
   - Immediate display synchronization: changing vehicle type or color in Settings instantly updates the live map on `index.html` and the shared viewer on `live.html` across tabs and upon return.

5. **Free Position Mode & Automatic Compass Movements**:
   - Free Position mode with one-tap Floating Round "Locate Me / Re-Center" button (`btn-locate-me`).
   - Circular automatic compass dial that rotates smoothly using shortest-angle delta accumulation, eliminating needle jerking/spinning across North (0°/360°).
   - Supports iOS Safari 13+ sensor permission requests and Android absolute orientation.
   - Tap compass dial anytime to re-center on vehicle and align map North-up.

6. **Search APIs & Place Suggestions Translated to English**:
   - Enforced English language across all backend search geocoding engines:
     - Komoot Photon (`&lang=en`)
     - Google Places Autocomplete & Details (`&language=en`)
     - OpenStreetMap Nominatim (`&accept-language=en` and header `'Accept-Language': 'en'`)
   - All place name suggestions and address subtexts return in English.

7. **Backend Map API Proxy**:
   - Nominatim and Photon search proxied via `/api/search` with custom caching, English translation, and timeout protection.
   - OSRM route calculations proxied via `/api/route` with straight-line fallback.

8. **Supabase Cloud Backend**:
   - Project URL: `https://fdupudjnsxrwldzsukfn.supabase.co`.
   - Tables with RLS enabled: `public.columbus_locations` and `public.columbus_sessions`.
   - Dual real-time synchronization writes every GPS telemetry ping.

9. **Verification**:
   - All 47 automated tests passing (`npm test`).
   - Verified live responses on both Vercel (`https://live-track-phi.vercel.app`) and AWS Lambda (`https://ev6xt4zg2cqw7fscat3mkpckzu0cloas.lambda-url.us-east-1.on.aws/`).
