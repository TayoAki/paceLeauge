import * as MediaLibrary from 'expo-media-library';

export const canSaveToPhotos = true;

/** Saves an image file to Photos with add-only access. Returns false when access is off. */
export async function saveImageToPhotos(uri: string): Promise<boolean> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) return false;
  await MediaLibrary.saveToLibraryAsync(uri);
  return true;
}
