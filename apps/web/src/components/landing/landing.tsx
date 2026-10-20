import type { Dictionary } from '../../content/vi';
import { Agents } from './agents';
import { Faq } from './faq';
import { Hero } from './hero';
import { HowItWorks } from './how-it-works';
import { Modules } from './modules';
import { OwnerPhone } from './owner-phone';
import { Pricing } from './pricing';
import { ProductTour } from './product-tour';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { Trust } from './trust';

// The landing page (DESIGN.md 6.1). Server-rendered; only the app shell, the org chart, the copy button and the theme
// toggle run on the client.
export function Landing({ dict }: { dict: Dictionary }) {
  return (
    <>
      <SiteHeader dict={dict} />
      <main id="main">
        <Hero dict={dict} />
        <ProductTour dict={dict} />
        <HowItWorks dict={dict} />
        <Agents dict={dict} />
        <OwnerPhone dict={dict} />
        <Modules dict={dict} />
        <Trust dict={dict} />
        <Pricing dict={dict} />
        <Faq dict={dict} />
      </main>
      <SiteFooter dict={dict} />
    </>
  );
}
