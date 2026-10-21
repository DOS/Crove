// The org's logo watermark on a post image (#834): where the logo goes and how large. The drawing runs in the browser
// and the result is uploaded as a new file, as a crop is.
import { cropType, outputSize, type Rect } from './social-crop.ts';

export const WATERMARK_CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
export type WatermarkCorner = (typeof WATERMARK_CORNERS)[number];
// The gap between the logo and the image's edges, as a share of the image's shorter side.
export const WATERMARK_MARGIN = 0.03;

// The logo's place on a width x height image: scalePercent of the image's width (never taller than the image allows),
// its own shape kept, in the corner with a margin.
export function watermarkRect(width: number, height: number, logo: { width: number; height: number }, corner: WatermarkCorner, scalePercent: number): Rect {
  const margin = Math.round(Math.min(width, height) * WATERMARK_MARGIN);
  const aspect = logo.height / Math.max(1, logo.width);
  let w = Math.max(1, Math.round((width * Math.min(100, Math.max(1, scalePercent))) / 100));
  let h = Math.max(1, Math.round(w * aspect));
  const tallest = Math.max(1, height - 2 * margin);
  if (h > tallest) {
    h = tallest;
    w = Math.max(1, Math.round(h / Math.max(aspect, 1e-6)));
  }
  const x = corner.endsWith('left') ? margin : Math.max(0, width - margin - w);
  const y = corner.startsWith('top') ? margin : Math.max(0, height - margin - h);
  return { x, y, width: w, height: h };
}

// The watermarked file's name: the original's, with -logo and the new extension.
export function watermarkName(original: string, type: string): string {
  const base = original.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'anh';
  return `${base}-logo.${type === 'image/png' ? 'png' : 'jpg'}`;
}

export interface WatermarkSettings {
  fileId: string;
  corner: WatermarkCorner;
  scalePercent: number;
  opacityPercent: number;
}

// Draws the logo on a copy of an image (turned the way its EXIF says, at most CROP_MAX_SIDE on its longest side) and
// returns the copy's bytes, PNG for a PNG, JPEG otherwise. Both bitmaps are closed before it returns.
export async function drawWatermark(image: Blob, imageMime: string, logo: Blob, settings: WatermarkSettings): Promise<{ blob: Blob; type: string; width: number; height: number }> {
  const [picture, mark] = await Promise.all([createImageBitmap(image, { imageOrientation: 'from-image' }), createImageBitmap(logo)]);
  try {
    const size = outputSize({ width: picture.width, height: picture.height });
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(picture, 0, 0, size.width, size.height);
    const rect = watermarkRect(size.width, size.height, { width: mark.width, height: mark.height }, settings.corner, settings.scalePercent);
    ctx.globalAlpha = settings.opacityPercent / 100;
    ctx.drawImage(mark, rect.x, rect.y, rect.width, rect.height);
    const type = cropType(imageMime);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error('canvas');
    return { blob, type, width: size.width, height: size.height };
  } finally {
    picture.close();
    mark.close();
  }
}
