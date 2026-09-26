import type { ExportSharer, ExportWriter } from './export-data';

/**
 * Web development preview: there is no app file system or share sheet, so exported files are
 * in-memory blobs and "share" downloads the file. Blob URLs are revoked when cleared.
 */
export const EXPORT_FOLDER_PREFIX = 'paceleague-export-';
const names = new Map<string, string>();

export function clearExportFiles(): void {
  for (const url of names.keys()) URL.revokeObjectURL(url);
  names.clear();
}

export const deviceExportWriter: ExportWriter = {
  write(_folderName, files) {
    clearExportFiles();
    return files.map((file) => {
      const uri = URL.createObjectURL(new Blob([file.contents], { type: file.mimeType }));
      names.set(uri, file.name);
      return { ...file, uri };
    });
  },
};

export const deviceSharer: ExportSharer = {
  isAvailable: async () => typeof document !== 'undefined',
  async share(uri) {
    const link = document.createElement('a');
    link.href = uri;
    link.download = names.get(uri) ?? 'paceleague-export';
    link.click();
  },
};
