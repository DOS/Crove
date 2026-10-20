// Cropping a post image to a platform's frame (#636): the presets, the part of the image a frame keeps, and the size
// the cropped file is saved at. The crop runs in the browser; the result is uploaded as a new file.

export const CROP_PRESETS = [
  { id: 'square', ratio: 1, label: '1:1' },
  { id: 'portrait', ratio: 4 / 5, label: '4:5' },
  { id: 'landscape', ratio: 1.91, label: '1.91:1' },
  { id: 'story', ratio: 9 / 16, label: '9:16' },
] as const;
export type CropPreset = (typeof CROP_PRESETS)[number]['id'];

// The longest side of a saved crop: enough for every platform's feed, small enough to upload quickly.
export const CROP_MAX_SIDE = 2160;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The largest part of a width x height image with the given shape; at 0 it starts at the left (or top) edge, at 1 it
// ends at the right (or bottom) one, at 0.5 it is centred.
export function cropRect(width: number, height: number, ratio: number, at: number): Rect {
  const pos = Math.min(1, Math.max(0, at));
  if (width / height > ratio) {
    const w = Math.round(height * ratio);
    return { x: Math.round((width - w) * pos), y: 0, width: w, height };
  }
  const h = Math.round(width / ratio);
  return { x: 0, y: Math.round((height - h) * pos), width, height: h };
}

// The saved size of a crop: its own size, scaled down so the longest side is at most CROP_MAX_SIDE.
export function outputSize(rect: Pick<Rect, 'width' | 'height'>): { width: number; height: number } {
  const scale = Math.min(1, CROP_MAX_SIDE / Math.max(rect.width, rect.height));
  return { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
}

// Whether the crop moves across (the image is wider than the frame) or up and down.
export const cropAxis = (width: number, height: number, ratio: number): 'x' | 'y' => (width / height > ratio ? 'x' : 'y');

// A PNG stays a PNG (it may hold transparency); everything else is saved as JPEG.
export const cropType = (mime: string): 'image/png' | 'image/jpeg' => (mime === 'image/png' ? 'image/png' : 'image/jpeg');

// The cropped file's name: the original's, with the frame and the new extension.
export function cropName(original: string, preset: string, type: string): string {
  const base = original.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'anh';
  return `${base}-${preset}.${type === 'image/png' ? 'png' : 'jpg'}`;
}
