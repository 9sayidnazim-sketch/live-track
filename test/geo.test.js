// Geometry and formatting rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../public/js/geo.js';

test('distance between London and Paris is about 344 km', () => {
  const metres = geo.distanceM({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
  assert.ok(Math.abs(metres - 343_550) < 1500, `got ${metres}`);
});

test('bearings point north, east, south and west', () => {
  const origin = { lat: 0, lng: 0 };
  assert.ok(Math.abs(geo.bearingDeg(origin, { lat: 1, lng: 0 }) - 0) < 0.01);
  assert.ok(Math.abs(geo.bearingDeg(origin, { lat: 0, lng: 1 }) - 90) < 0.01);
  assert.ok(Math.abs(geo.bearingDeg(origin, { lat: -1, lng: 0 }) - 180) < 0.01);
  assert.ok(Math.abs(geo.bearingDeg(origin, { lat: 0, lng: -1 }) - 270) < 0.01);
});

test('angleDelta takes the short way round', () => {
  assert.equal(geo.angleDelta(350, 10), 20);
  assert.equal(geo.angleDelta(10, 350), -20);
  assert.equal(Math.abs(geo.angleDelta(0, 180)), 180);
  assert.equal(geo.angleDelta(90, 90), 0);
});

test('speed between two fixes is distance over time', () => {
  const a = { lat: 51.5, lng: -0.1, time: new Date(0) };
  const b = { lat: 51.5 + 100 / 111_320, lng: -0.1, time: new Date(10_000) };
  assert.ok(Math.abs(geo.speedBetween(a, b) - 10) < 0.1);
  assert.equal(geo.speedBetween(a, { ...b, time: new Date(0) }), null);
});

test('nearest vertex and polyline length', () => {
  const coords = [
    [51.5, -0.1],
    [51.501, -0.1],
    [51.502, -0.1],
  ];
  assert.equal(geo.nearestVertex(coords, { lat: 51.5012, lng: -0.1 }).index, 1);
  assert.ok(Math.abs(geo.polylineLength(coords, 0) - 222.4) < 1);
  assert.ok(Math.abs(geo.polylineLength(coords, 1) - 111.2) < 1);
});

test('arrival uses the larger of 30 m and the fix accuracy, capped at 50 m', () => {
  const target = { lat: 51.5, lng: -0.12 };
  const at = (metres, accuracy) => ({ lat: target.lat + metres / 111_320, lng: target.lng, accuracy });
  assert.equal(geo.hasArrived(at(20, 5), target), true);
  assert.equal(geo.hasArrived(at(45, 5), target), false);
  assert.equal(geo.hasArrived(at(45, 40), target), false);
  assert.equal(geo.hasArrived(at(48, 60), target), true, 'the allowance is capped at 50 m');
});

test('readouts format the way the instrument panel shows them', () => {
  assert.equal(geo.formatDistance(850), '850 m');
  assert.equal(geo.formatDistance(4230), '4.2 km');
  assert.equal(geo.formatDistance(12_400), '12 km');
  assert.equal(geo.formatDuration(540), '9 min');
  assert.equal(geo.formatDuration(3600), '1 h');
  assert.equal(geo.formatDuration(4020), '1 h 7 min');
  assert.equal(geo.formatSpeedKmh(10), '36 km/h');
  assert.equal(geo.formatSpeedKmh(null), '-');
  assert.equal(geo.formatCoord(51.5), '51.500000');
  assert.equal(geo.formatAccuracy(7.6), '8 m');
  assert.equal(geo.formatClock(new Date(2026, 10, 6, 9, 5, 7)), '09:05:07');
});
