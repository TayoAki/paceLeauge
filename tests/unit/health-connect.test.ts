import { sleepMinutesByNight } from '@/domain/training';
import { HC_EXERCISE, hcActivity, hcAppName, hcExerciseType, hcHeartRate, hcPauses, hcRoute, hcSleep } from '@/features/health/health-connect';
import { importedRun, type HealthWorkout } from '@/features/health/health-import';

const at = (hhmm: string, day = '2026-10-06') => `${day}T${hhmm}:00.000Z`;

describe('Health Connect', () => {
  it('brings in runs, walks, hikes, rides and strength workouts, and knows treadmill and indoor bikes', () => {
    expect(hcActivity(HC_EXERCISE.RUNNING)).toEqual({ activity: 'run', indoor: false });
    expect(hcActivity(HC_EXERCISE.RUNNING_TREADMILL)).toEqual({ activity: 'run', indoor: true });
    expect(hcActivity(HC_EXERCISE.BIKING_STATIONARY)).toEqual({ activity: 'ride', indoor: true });
    expect(hcActivity(HC_EXERCISE.STRENGTH_TRAINING)?.activity).toBe('other');
    // Yoga (83) and swimming aren't brought in.
    expect(hcActivity(83)).toBeNull();
    expect(hcExerciseType('running')).toBe(HC_EXERCISE.RUNNING);
    expect(hcExerciseType('cycling')).toBe(HC_EXERCISE.BIKING);
  });

  it('reads pauses from pause segments only, and names common apps', () => {
    expect(
      hcPauses([
        { startTime: at('07:10'), endTime: at('07:12'), segmentType: 39 },
        { startTime: at('07:20'), endTime: at('07:21'), segmentType: 44 },
      ]),
    ).toEqual([{ from: Date.parse(at('07:10')), to: Date.parse(at('07:12')) }]);
    expect(hcAppName('com.sec.android.app.shealth')).toBe('Samsung Health');
    expect(hcAppName('com.example.tracker')).toBe('com.example.tracker');
    expect(hcAppName(null)).toBeNull();
  });

  it('takes a route only when Health Connect handed it over, and treats a zero accuracy as unknown', () => {
    const route = { type: 'DATA', route: [{ time: at('07:00'), latitude: 41.9, longitude: -87.6, horizontalAccuracy: { inMeters: 0 } }, { time: at('07:00'), latitude: 41.9, longitude: -87.6, horizontalAccuracy: { inMeters: 6 } }] };
    expect(hcRoute(route)?.map((p) => p.accuracyM)).toEqual([null, 6]);
    expect(hcRoute({ type: 'CONSENT_REQUIRED', route: [] })).toBeNull();
    expect(hcRoute(undefined)).toBeNull();
  });

  it('turns an imported session into the same run an Apple Health workout becomes', () => {
    const workout: HealthWorkout = {
      uuid: '9a8b7c6d-1111-4222-8333-944455556666',
      activity: 'run',
      start: Date.parse(at('07:00')),
      end: Date.parse(at('07:40')),
      pauses: hcPauses([{ startTime: at('07:10'), endTime: at('07:15'), segmentType: 39 }]),
      distanceM: 6000,
      sourceName: hcAppName('com.garmin.android.apps.connectmobile'),
      sourceBundleId: 'com.garmin.android.apps.connectmobile',
      deviceName: 'Garmin Forerunner',
      manualEntry: false,
      externalUuid: null,
      avgHeartRate: 150,
      maxHeartRate: 171,
      indoor: false,
      readRoute: async () => [],
    };
    const { draft, origin } = importedRun(workout, []);
    expect(draft.activeMs).toBe(35 * 60_000);
    expect(draft.distanceM).toBe(6000);
    expect(origin).toMatchObject({ source: 'health_import', sourceApp: 'Garmin Connect', avgHeartRate: 150, externalId: workout.uuid });
  });

  it('flattens heart-rate records and reads sleep stages the way Apple Health numbers them', () => {
    expect(
      hcHeartRate([
        { samples: [{ time: at('07:00'), beatsPerMinute: 120 }] },
        { samples: [{ time: at('06:59'), beatsPerMinute: 110 }] },
      ]),
    ).toEqual([
      { t: Date.parse(at('06:59')), bpm: 110 },
      { t: Date.parse(at('07:00')), bpm: 120 },
    ]);
    const samples = hcSleep([
      {
        startTime: at('23:00', '2026-10-05'),
        endTime: at('06:30'),
        stages: [
          { startTime: at('23:00', '2026-10-05'), endTime: at('03:00'), stage: 4 },
          { startTime: at('03:00'), endTime: at('03:30'), stage: 1 },
          { startTime: at('03:30'), endTime: at('06:00'), stage: 6 },
          { startTime: at('06:00'), endTime: at('06:30'), stage: 3 },
        ],
      },
      // A night without stages counts as asleep throughout.
      { startTime: at('23:00'), endTime: at('06:00', '2026-10-07') },
    ]);
    const nights = sleepMinutesByNight(samples, (t) => new Date(t).toISOString().slice(0, 10));
    expect(nights.get('2026-10-06')).toBe(4 * 60 + 150);
    expect(nights.get('2026-10-07')).toBe(7 * 60);
  });
});
