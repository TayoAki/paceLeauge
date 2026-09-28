import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * A route as a GPX file for other apps and watches (docs/ROADMAP.md 5.1): written to the cache and
 * handed to the share sheet, from which Garmin Connect, COROS and others import it as a course.
 * Only the newest is kept.
 */
export async function shareRouteFile(fileName: string, gpx: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const folder = new Directory(Paths.cache, 'routes');
  try {
    if (folder.exists) folder.delete();
  } catch {
    // Nothing to remove.
  }
  folder.create({ intermediates: true, idempotent: true });
  const file = new File(folder, fileName);
  file.write(gpx);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/gpx+xml', UTI: 'com.topografix.gpx', dialogTitle: 'Send route' });
  return true;
}
