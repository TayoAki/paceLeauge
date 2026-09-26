import {
  averagePaceSeconds,
  defaultUnitsForRegion,
  describeDistance,
  describeDuration,
  describePace,
  formatDistance,
  formatDuration,
  formatPace,
  formatXp,
  ordinal,
} from '../format';
import { chunk, encodeChunk, fromCompact, normalizeAccuracy, normalizeCoordinate, toCompact, toGpx } from '../route-codec';
import type { TrackPoint } from '../types';

describe('formatting', () => {
  it('formats the fixture run as 5.24 km, 31:28 and 6:00 /km', () => {
    expect(formatDistance(5240, 'metric')).toEqual({ value: '5.24', unit: 'km', unitLong: 'kilometers' });
    expect(formatDuration(1_888_000)).toBe('31:28');
    expect(formatPace(1_888_000, 5240, 'metric')).toEqual({ value: '6:00', unit: '/km', unitLong: 'per kilometer' });
    expect(formatDistance(6400, 'metric').value).toBe('6.40');
    expect(formatDuration(2_342_000)).toBe('39:02');
  });

  it('never overstates distance and shows hours when needed', () => {
    expect(formatDistance(5249.99, 'metric').value).toBe('5.24');
    expect(formatDistance(0, 'metric').value).toBe('0.00');
    expect(formatDuration(3_845_000)).toBe('1:04:05');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('converts to miles without changing stored metres', () => {
    expect(formatDistance(1609.344, 'imperial')).toEqual({ value: '1.00', unit: 'mi', unitLong: 'miles' });
    expect(formatPace(1_888_000, 5240, 'imperial').value).toBe('9:40');
    expect(averagePaceSeconds(600_000, 5, 'metric')).toBeNull();
    expect(formatPace(600_000, 5, 'metric').value).toBe('--:--');
  });

  it('describes values for screen readers', () => {
    expect(describeDuration(1_888_000)).toBe('31 minutes 28 seconds');
    expect(describeDuration(3_601_000)).toBe('1 hour 0 minutes 1 second');
    expect(describeDistance(5240, 'metric')).toBe('5.24 kilometers');
    expect(describePace(1_888_000, 5240, 'metric')).toBe('6 minutes 0 seconds per kilometer');
  });

  it('chooses default units by region and formats ordinals and XP', () => {
    expect(defaultUnitsForRegion('US')).toBe('imperial');
    expect(defaultUnitsForRegion('de')).toBe('metric');
    expect(defaultUnitsForRegion(null)).toBe('metric');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
    ]);
    expect(formatXp(12_345)).toBe('12,345');
  });
});

describe('route codec', () => {
  const point: TrackPoint = { seq: 7, segmentIndex: 1, t: 1_790_000_000_123, lat: 41.87811364999, lon: -87.62979821, accuracyM: 4.56 };

  it('normalizes coordinates to 7 decimals and accuracy to 0.1 m', () => {
    expect(normalizeCoordinate(point.lat)).toBe(41.8781136);
    expect(normalizeCoordinate(point.lon)).toBe(-87.6297982);
    expect(normalizeAccuracy(4.56)).toBe(4.6);
    expect(normalizeAccuracy(null)).toBeNull();
    expect(normalizeAccuracy(-1)).toBeNull();
    expect(normalizeAccuracy(Number.NaN)).toBeNull();
  });

  it('round-trips the compact wire format', () => {
    expect(fromCompact(toCompact(point))).toEqual(point);
    const normalized = { ...point, lat: 41.8781136, lon: -87.6297982, accuracyM: 4.6 };
    expect(encodeChunk([normalized])).toBe('[[7,1790000000123,41.8781136,-87.6297982,4.6,1]]');
  });

  it('chunks at 500 points', () => {
    const sizes = chunk(Array.from({ length: 1201 }, (_, i) => i)).map((c) => c.length);
    expect(sizes).toEqual([500, 500, 201]);
    expect(chunk([])).toEqual([]);
  });

  it('exports GPX with one track segment per active segment and escaped titles', () => {
    const gpx = toGpx(
      { title: 'Tom & Jerry <run>', startedAt: 0 },
      [
        { index: 0, startAt: 0, endAt: 10 },
        { index: 1, startAt: 20, endAt: 30 },
      ],
      [
        { ...point, segmentIndex: 0, t: 5 },
        { ...point, segmentIndex: 1, t: 25 },
      ],
    );
    expect(gpx).toContain('<name>Tom &amp; Jerry &lt;run&gt;</name>');
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx).toContain(`<trkpt lat="${point.lat}" lon="${point.lon}">`);
  });
});
