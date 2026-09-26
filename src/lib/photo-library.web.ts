/** The web preview has no photo library; the share screen offers a download instead. */
export const canSaveToPhotos = false;

export async function saveImageToPhotos(_uri: string): Promise<boolean> {
  return false;
}
