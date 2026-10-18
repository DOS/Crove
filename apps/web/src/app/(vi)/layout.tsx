import type { ReactNode } from 'react';
import { landingMetadata, landingViewport, RootDocument } from '../../components/root-document';
import { vi } from '../../content/vi';

export const metadata = landingMetadata(vi, '/');
export const viewport = landingViewport;

export default function VietnameseLayout({ children }: { children: ReactNode }) {
  return <RootDocument lang="vi">{children}</RootDocument>;
}
