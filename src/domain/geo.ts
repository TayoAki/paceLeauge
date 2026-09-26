/**
 * Great-circle distance. The SQL backend (private.haversine_m) uses the identical formula,
 * radius and operation order so client estimates and server results agree.
 */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineM(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * DEG_TO_RAD;
  const phi2 = b.lat * DEG_TO_RAD;
  const dPhi = (b.lat - a.lat) * DEG_TO_RAD;
  const dLambda = (b.lon - a.lon) * DEG_TO_RAD;
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * Returns the point reached by travelling `distanceM` from `origin` on `bearingDeg`.
 * Used by synthetic route fixtures and the web location simulator — never by scoring.
 */
export function destinationPoint(origin: LatLon, bearingDeg: number, distanceM: number): LatLon {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = bearingDeg * DEG_TO_RAD;
  const phi1 = origin.lat * DEG_TO_RAD;
  const lambda1 = origin.lon * DEG_TO_RAD;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: phi2 / DEG_TO_RAD, lon: ((lambda2 / DEG_TO_RAD + 540) % 360) - 180 };
}
