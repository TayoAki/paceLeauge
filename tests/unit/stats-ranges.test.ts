import { addMonths, bucketForSpan, bucketLabel, isIsoDate, monthGrid, rangeFor } from '@/features/progress/stats-ranges';

describe('stats ranges', () => {
  const today = '2026-09-28'; // a Monday

  it('builds the preset ranges', () => {
    expect(rangeFor('12w', today)).toEqual({ from: '2026-07-13', to: today, bucket: 'week' });
    expect(rangeFor('12m', today)).toEqual({ from: '2025-10-01', to: today, bucket: 'month' });
    expect(rangeFor('ytd', today)).toEqual({ from: '2026-01-01', to: today, bucket: 'month' });
    expect(rangeFor('5y', today)).toEqual({ from: '2022-01-01', to: today, bucket: 'year' });
  });

  it('validates a custom range and picks a readable bucket', () => {
    expect(rangeFor('custom', today, { from: '2026-08-01', to: '2026-09-15' })).toMatchObject({ bucket: 'week' });
    expect(rangeFor('custom', today, { from: '2025-01-01', to: '2026-06-30' })).toMatchObject({ bucket: 'month' });
    expect(rangeFor('custom', today, { from: '2019-01-01', to: '2026-06-30' })).toMatchObject({ bucket: 'year' });
    expect(rangeFor('custom', today, { from: '2026-02-30', to: '2026-03-01' })).toBeNull();
    expect(rangeFor('custom', today, { from: '2026-05-01', to: '2026-04-01' })).toBeNull();
    expect(rangeFor('custom', today, { from: '2010-01-01', to: '2026-01-01' })).toBeNull();
    expect(bucketForSpan('2026-01-01', '2026-01-01')).toBe('week');
    expect(isIsoDate('2026-9-1')).toBe(false);
  });

  it('labels buckets and steps months across years', () => {
    expect(bucketLabel('2026-09-21', 'week')).toBe('Sep 21');
    expect(bucketLabel('2026-09-01', 'month')).toBe('Sep');
    expect(bucketLabel('2026-01-01', 'year')).toBe('2026');
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('lays out a month Monday first', () => {
    const grid = monthGrid(2026, 9); // 1 September 2026 is a Tuesday
    expect(grid[0]).toEqual([null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(grid.flat().filter(Boolean)).toHaveLength(30);
    expect(grid.every((w) => w.length === 7)).toBe(true);
  });
});
