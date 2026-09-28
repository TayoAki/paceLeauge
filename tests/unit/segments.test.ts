import { segmentListSchema, segmentSchema } from '@/api/segments-api';
import { effortPace, formatElapsed, myDaysLine, regularLine, segmentSummary } from '@/features/segments/segment-text';

/** Segment copy and the shapes the app accepts from the server (docs/ROADMAP.md 5.3). */
describe('segment text', () => {
  it('shows times to the nearest second, and the distance, surface and pace', () => {
    expect(formatElapsed(199_600)).toBe('3:20');
    expect(formatElapsed(200_400)).toBe('3:20');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(segmentSummary({ distance_m: 800, surface: 'path' }, 'metric')).toBe('0.8 km · Path');
    expect(segmentSummary({ distance_m: 1609, surface: 'track' }, 'imperial')).toBe('1.0 mi · Track');
    expect(effortPace(200_000, 800, 'metric')).toBe('4:10 /km');
  });

  it('names the local regular by different days, and the runner’s own days', () => {
    expect(regularLine(null)).toMatch(/^Nobody yet/);
    expect(regularLine({ alias: 'Priya', days: 4, is_me: false })).toBe('Priya: 4 different days in the last 90.');
    expect(regularLine({ alias: 'Priya', days: 1, is_me: true })).toBe('You are: 1 different day in the last 90.');
    expect(myDaysLine(2, { alias: 'Priya', days: 4, is_me: false })).toBe('You: 2 days.');
    expect(myDaysLine(4, { alias: 'Me', days: 4, is_me: true })).toBeNull();
    expect(myDaysLine(0, null)).toBeNull();
  });
});

describe('segment payloads', () => {
  it('reads the list and a segment as the server sends them', () => {
    const summary = {
      id: 's1',
      name: 'Park straight',
      surface: 'path',
      distance_m: 1000,
      status: 'active',
      start: { lat: 41.9, lon: -87.6 },
      end: { lat: 41.91, lon: -87.6 },
      runners: 3,
      my_best_ms: null,
      legend: { alias: 'Priya', days: 4, is_me: false },
      preview: [
        [41.9, -87.6],
        [41.91, -87.6],
      ],
    };
    expect(segmentListSchema.parse({ joined: false, banned: false, segments: [summary] }).segments[0]!.legend?.days).toBe(4);
    const full = segmentSchema.parse({
      ...summary,
      points: summary.preview,
      board: [{ place: 1, alias: 'Marco', elapsed_ms: 222_300, run_at_ms: 1, effort_id: 'e1', is_me: false }],
      my_efforts: [],
      my_days: 0,
      legend: null,
    });
    // Made by staff, a segment comes back without the viewer's membership.
    expect(full.joined).toBe(false);
    expect(full.board[0]!.alias).toBe('Marco');
    expect(() => segmentSchema.parse({ ...full, surface: 'road' })).toThrow();
  });
});
