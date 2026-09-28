import { cToF, dewPointC, fToC, heatAdvice, heatZones } from '../heat';
import { paceZones } from '../plans/paces';

describe('heat', () => {
  it('works out the dew point from temperature and humidity', () => {
    expect(dewPointC(30, 50)).toBeCloseTo(18.4, 1);
    expect(dewPointC(20, 100)).toBeCloseTo(20, 5);
    expect(fToC(cToF(27))).toBeCloseTo(27, 9);
  });

  it('slows paces more as it gets hotter and more humid, and advises against hard running at the extreme', () => {
    expect(heatAdvice({ tempC: 15, humidity: 50 }).slowdown).toBe(0);
    expect(heatAdvice({ tempC: 30, humidity: 50 })).toEqual({ dewPointC: 18.4, slowdown: 0.06 });
    expect(heatAdvice({ tempC: 38, humidity: 80 }).slowdown).toBeNull();
  });

  it('slows every pace range by the same share', () => {
    const zones = paceZones(1500, 300);
    const hot = heatZones(zones, 0.05);
    expect(hot.easy.fastSPerKm).toBe(Math.round(zones.easy.fastSPerKm * 1.05));
    expect(hot.interval.slowSPerKm).toBe(Math.round(zones.interval.slowSPerKm * 1.05));
  });
});
