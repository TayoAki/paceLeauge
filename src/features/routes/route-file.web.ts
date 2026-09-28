/** The web app downloads the route's GPX file. */
export async function shareRouteFile(fileName: string, gpx: string): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
