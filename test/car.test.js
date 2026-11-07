// The car glide, tested with a fake clock so no real time passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Glider, COLOR_THEMES, getMarkerSvg } from '../public/js/car.js';

/** A clock you move by hand. Frames scheduled with raf run only when frame() is called. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const frames = new Map();
  return {
    clock: {
      now: () => now,
      raf: (callback) => {
        const id = nextId;
        nextId += 1;
        frames.set(id, callback);
        return id;
      },
      caf: (id) => frames.delete(id),
    },
    advance(ms) {
      now += ms;
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    get pending() {
      return frames.size;
    },
  };
}

test('the first fix is placed at once, with no animation', () => {
  const clock = fakeClock();
  const glider = new Glider({ onFrame: () => {}, clock: clock.clock });
  glider.glideTo({ lat: 1, lng: 1 }, 10_000);
  assert.deepEqual(glider.position, { lat: 1, lng: 1 });
  assert.equal(clock.pending, 0);
});

test('a glide moves in steps over 10 seconds and stops at the target', () => {
  const clock = fakeClock();
  const frames = [];
  const glider = new Glider({ onFrame: (point, t) => frames.push({ ...point, t }), clock: clock.clock });
  glider.place({ lat: 0, lng: 0 });
  frames.length = 0; // ignore the placement frame
  glider.glideTo({ lat: 0.001, lng: 0.002 }, 10_000);
  for (let step = 1; step <= 10; step += 1) {
    clock.advance(1000);
    clock.frame();
  }
  const progress = frames.map((frame) => frame.t);
  assert.ok(progress.every((t, i) => i === 0 || t >= progress[i - 1]), 'progress never goes backwards');
  assert.equal(frames.at(-1).t, 1);
  assert.ok(Math.abs(frames.at(-1).lat - 0.001) < 1e-12);
  const halfway = frames.find((frame) => frame.t === 0.5);
  assert.ok(halfway, 'there is a frame at 50 percent');
  assert.ok(Math.abs(halfway.lat - 0.0005) < 1e-12);
  assert.equal(clock.pending, 0, 'no frames are scheduled after the car arrives');
});

test('a new fix during a glide restarts from where the car is now', () => {
  const clock = fakeClock();
  const glider = new Glider({ onFrame: () => {}, clock: clock.clock });
  glider.place({ lat: 0, lng: 0 });
  glider.glideTo({ lat: 1, lng: 0 }, 10_000);
  clock.advance(5000);
  clock.frame();
  assert.ok(Math.abs(glider.position.lat - 0.5) < 1e-9);
  glider.glideTo({ lat: 2, lng: 0 }, 10_000);
  clock.advance(1000);
  clock.frame();
  assert.ok(Math.abs(glider.position.lat - 0.65) < 1e-9, `got ${glider.position.lat}`);
});

test('stop cancels the glide and leaves the car where it is', () => {
  const clock = fakeClock();
  const glider = new Glider({ onFrame: () => {}, clock: clock.clock });
  glider.place({ lat: 0, lng: 0 });
  glider.glideTo({ lat: 1, lng: 0 }, 10_000);
  clock.advance(2000);
  clock.frame();
  const stoppedAt = glider.position.lat;
  glider.stop();
  assert.equal(clock.pending, 0);
  clock.advance(5000);
  clock.frame();
  assert.equal(glider.position.lat, stoppedAt);
});

test('COLOR_THEMES defines 7 color palettes including white and orange', () => {
  const expectedColors = ['white', 'orange', 'teal', 'green', 'red', 'purple', 'black'];
  for (const color of expectedColors) {
    assert.ok(COLOR_THEMES[color], `missing color theme: ${color}`);
    assert.ok(COLOR_THEMES[color].primary, `missing primary color for: ${color}`);
    assert.ok(COLOR_THEMES[color].glow, `missing glow color for: ${color}`);
  }
});

test('getMarkerSvg renders car and arrow SVG for all themes', () => {
  const carSvg = getMarkerSvg('car', 'orange');
  assert.match(carSvg, /<svg/);
  assert.match(carSvg, /<!-- Vehicle Body -->/);

  const arrowSvg = getMarkerSvg('arrow', 'teal');
  assert.match(arrowSvg, /<svg/);
  assert.match(arrowSvg, /<!-- High-contrast Navigation Arrowhead -->/);

  const whiteCarSvg = getMarkerSvg('car', 'white');
  assert.match(whiteCarSvg, /#ffffff/);
});
