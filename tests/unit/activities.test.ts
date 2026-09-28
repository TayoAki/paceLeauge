import { formatDistanceShort, formatSpeed } from '@/domain/format';
import { activityCount, describeKinds, splitRunning } from '@/features/progress/activities';

describe('walks, hikes, rides and other workouts', () => {
  it('keeps running apart from everything else', () => {
    const split = splitRunning([
      { activity: 'run', runs: 8, distance_m: 63_340, active_ms: 22_372_000 },
      { activity: 'walk', runs: 2, distance_m: 8_400, active_ms: 6_000_000 },
      { activity: 'ride', runs: 1, distance_m: 24_000, active_ms: 4_200_000 },
      { activity: 'other', runs: 1, distance_m: 0, active_ms: 2_700_000 },
    ]);
    expect(split.running).toEqual({ count: 8, distanceM: 63_340, activeMs: 22_372_000 });
    expect(split.other).toEqual({ count: 4, distanceM: 32_400, activeMs: 12_900_000 });
    expect(describeKinds(split.otherKinds)).toBe('2 walks, 1 ride and 1 other workout');
    expect(splitRunning([]).other.count).toBe(0);
  });

  it('names counts in plain words', () => {
    expect(activityCount('run', 1)).toBe('1 run');
    expect(activityCount('hike', 3)).toBe('3 hikes');
    expect(describeKinds([{ activity: 'walk', count: 1 }])).toBe('1 walk');
    expect(describeKinds([])).toBe('');
  });

  it('shortens long distances and reads rides as speed', () => {
    expect(formatDistanceShort(103_040, 'metric')).toMatchObject({ value: '103', unit: 'km' });
    expect(formatDistanceShort(42_195, 'metric').value).toBe('42.19');
    expect(formatSpeed(4_200_000, 24_000, 'metric')).toMatchObject({ value: '20.6', unit: 'km/h' });
    expect(formatSpeed(3_600_000, 16_093.44, 'imperial')).toMatchObject({ value: '10.0', unit: 'mph' });
    expect(formatSpeed(0, 1_000, 'metric').value).toBe('--');
  });
});
