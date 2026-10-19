import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { en } from '../../../content/en';

export const alt = en.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage(en);
}
