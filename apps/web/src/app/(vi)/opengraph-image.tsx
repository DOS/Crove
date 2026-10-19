import { OG_SIZE, renderOgImage } from '../../components/og-image';
import { vi } from '../../content/vi';

export const alt = vi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage(vi);
}
