import { Encoder, Profile } from '@garmin/fitsdk';

import { FileImportError, NOMINAL_FILE_ACCURACY_M, activityFromName, parseActivityFile, parseFit, parseGpx, parseTcx } from '../file-import';
import { steadyRun } from '../synthetic';

const T0 = Date.UTC(2026, 8, 20, 12);
const run = steadyRun(T0, 3_000, 900).points.filter((_, i) => i % 5 === 0);

function gpx(): string {
  const half = Math.floor(run.length / 2);
  const seg = (pts: typeof run) =>
    `<trkseg>${pts
      .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>180</ele><time>${new Date(p.t).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`)
      .join('')}</trkseg>`;
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Strava &amp; Co"><trk><name>Lunch Run</name><type>running</type>${seg(run.slice(0, half))}${seg(
    run.slice(half + 10),
  )}</trk></gpx>`;
}

function tcx(): string {
  return `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap StartTime="x"><DistanceMeters>3000.0</DistanceMeters><Track>${run
    .map(
      (p) =>
        `<Trackpoint><Time>${new Date(p.t).toISOString()}</Time><Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position><HeartRateBpm><Value>148</Value></HeartRateBpm></Trackpoint>`,
    )
    .join('')}</Track></Lap></Activity></Activities><Author><Name>ignored</Name></Author><Creator><Name>Forerunner 265</Name></Creator></TrainingCenterDatabase>`;
}

function fit(): Uint8Array {
  const encoder = new Encoder();
  // The SDK's message types are generated per message; a loose writer keeps the fixture short.
  const write = (mesg: Record<string, unknown>) => encoder.writeMesg(mesg as never);
  const deg = (d: number) => Math.round(d / (180 / 2 ** 31));
  write({ mesgNum: Profile.MesgNum.FILE_ID!, type: 'activity', manufacturer: 'garmin', product: 1, timeCreated: new Date(T0), serialNumber: 1 });
  write({ mesgNum: Profile.MesgNum.EVENT!, timestamp: new Date(T0), event: 'timer', eventType: 'start' });
  for (const p of run) {
    write({ mesgNum: Profile.MesgNum.RECORD!, timestamp: new Date(p.t), positionLat: deg(p.lat), positionLong: deg(p.lon), heartRate: 152 });
  }
  write({ mesgNum: Profile.MesgNum.EVENT!, timestamp: new Date(run[run.length - 1]!.t), event: 'timer', eventType: 'stopAll' });
  write({
    mesgNum: Profile.MesgNum.SESSION!,
    timestamp: new Date(run[run.length - 1]!.t),
    startTime: new Date(T0),
    sport: 'running',
    totalDistance: 2995,
    avgHeartRate: 151,
    maxHeartRate: 166,
  });
  return encoder.close();
}

describe('file import', () => {
  it('reads a GPX file: points, a pause between track segments, heart rate and type', () => {
    const parsed = parseGpx(gpx());
    expect(parsed).toMatchObject({ format: 'gpx', activity: 'run', creator: 'Strava & Co', name: 'Lunch Run', avgHeartRate: 150, maxHeartRate: 150 });
    expect(parsed.points).toHaveLength(run.length - 10);
    expect(parsed.points[0]).toMatchObject({ t: T0, accuracyM: NOMINAL_FILE_ACCURACY_M });
    expect(parsed.pauses).toHaveLength(1);
    expect(parsed.pauses[0]!.to - parsed.pauses[0]!.from).toBe(11 * 5_000);
  });

  it('reads a TCX file with its lap distance and creator', () => {
    const parsed = parseTcx(tcx());
    expect(parsed).toMatchObject({ format: 'tcx', activity: 'run', distanceM: 3000, creator: 'Forerunner 265', avgHeartRate: 148 });
    expect(parsed.points).toHaveLength(run.length);
    expect(parsed.end - parsed.start).toBe(run[run.length - 1]!.t - T0);
  });

  it('reads a FIT file: positions from semicircles, the session and timer events', () => {
    const parsed = parseFit(fit());
    expect(parsed).toMatchObject({ format: 'fit', activity: 'run', distanceM: 2995, avgHeartRate: 151, maxHeartRate: 166 });
    expect(parsed.points).toHaveLength(run.length);
    expect(parsed.points[0]!.lat).toBeCloseTo(run[0]!.lat, 6);
    expect(parsed.points[0]!.lon).toBeCloseTo(run[0]!.lon, 6);
  });

  it('detects the format and refuses what it can’t read', () => {
    expect(parseActivityFile('export.gpx', new TextEncoder().encode(gpx())).format).toBe('gpx');
    expect(parseActivityFile('activity', fit()).format).toBe('fit');
    expect(() => parseActivityFile('notes.txt', new TextEncoder().encode('hello'))).toThrow(FileImportError);
    expect(() => parseGpx('<gpx><trk><trkseg></trkseg></trk></gpx>')).toThrow('no_points');
    expect(activityFromName('cycling')).toBe('ride');
    expect(activityFromName('Evening Walk')).toBe('walk');
  });
});
