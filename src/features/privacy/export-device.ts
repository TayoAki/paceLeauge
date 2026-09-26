import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { ExportSharer, ExportWriter } from './export-data';

/** Exported files live in a folder in the app cache; only the newest export is kept. */
export const EXPORT_FOLDER_PREFIX = 'paceleague-export-';

/** Removes exported files from this phone's cache (they contain private routes). Best effort. */
export function clearExportFiles(): void {
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      if (entry instanceof Directory && entry.name.startsWith(EXPORT_FOLDER_PREFIX)) entry.delete();
    }
  } catch {
    // Nothing to remove, or the system already purged the cache.
  }
}

/** Writes into a fresh folder in the cache directory; only the newest export is kept. */
export const deviceExportWriter: ExportWriter = {
  write(folderName, files) {
    clearExportFiles();
    const folder = new Directory(Paths.cache, folderName);
    folder.create({ intermediates: true, idempotent: true });
    return files.map((file) => {
      const target = new File(folder, file.name);
      target.write(file.contents);
      return { ...file, uri: target.uri };
    });
  },
};

export const deviceSharer: ExportSharer = {
  isAvailable: () => Sharing.isAvailableAsync(),
  share: (uri, options) => Sharing.shareAsync(uri, options),
};
