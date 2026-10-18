import type { ReactNode } from 'react';
import { landingMetadata, landingViewport, RootDocument } from '../../components/root-document';
import { en } from '../../content/en';

export const metadata = landingMetadata(en, '/en');
export const viewport = landingViewport;

export default function EnglishLayout({ children }: { children: ReactNode }) {
  return <RootDocument lang="en">{children}</RootDocument>;
}
