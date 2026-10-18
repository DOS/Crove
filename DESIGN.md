# Crove design system and UI/UX guidelines

Version 3.0 (2026-10-18). Applies to the marketing site (`apps/web`), the web app (`apps/app`) and the component package (`packages/ui`). Written for engineers, designers and coding agents.

Version 2 described a glow-and-gradient landing style and an older stack (SWR, Next.js links in the app). Both are gone: this version replaces it entirely. The research behind each rule, with sources and measurements, is summarized in [docs/design/ui-ux-research-2026-10.vi.html](docs/design/ui-ux-research-2026-10.vi.html).

**Visual direction (picked 2026-10-18).** Of the five mockups in [docs/design/mockups/](docs/design/mockups/), the owner picked a composition: the frame of B (Bàn điều khiển: the product UI is the hero, keyboard-first, graphite neutrals), the agents section of E (org chart and R0 to R3 matrix), the phone section of D, the routing slip of C and the ledger of A. Crove violet is the single, restrained accent; controls use a 6px radius. Type: Archivo for display headings, Be Vietnam Pro for body and UI, JetBrains Mono for amounts and codes. The marketing site implements it in `apps/web` (tokens in `apps/web/src/app/globals.css`); bringing the web app's `packages/ui` tokens and radius in line is a separate change.

---

## 1. What we are designing

Crove is an open-source, AI-native Business OS for solo founders and SMEs, Vietnam first. The first job it does well: purchase invoices come in, Crove reads and checks them, proposes a TT133 journal entry, and a person approves it. Modules (finance, tasks, agents, social) share one kernel, one approval model and one audit log.

The people using it:

- **Owners of small companies and shops.** Not accountants. Often on a phone. They need to know what needs them today and to trust what the system did.
- **Accountants and bookkeepers** (in-house or at a service firm). Daily, heavy use, keyboard-first, many organizations. They need density, exact numbers and fast review.
- **Technical founders** who self-host. They need to see that it runs with `docker compose up` and that the code is open.

## 2. Principles

1. **Show the product working.** Every important claim on the marketing site is backed by a visualization of the real product with real-looking Vietnamese data (an invoice, its checks, the journal entry it becomes). Text explains what the picture cannot. A section that is only an icon, a heading and two sentences is not finished.
2. **A proposal looks like a proposal.** AI output is tainted until a person approves it. Proposed data is visually distinct from posted data everywhere (state chip, outline style, the word "Đề xuất"), and the approve action states exactly what it will post.
3. **Calm density.** Accountants scan hundreds of rows. Prefer compact rows, aligned numbers and quiet chrome over big cards and whitespace for its own sake. Density comes from alignment and hierarchy, not from smaller text.
4. **Vietnamese first.** Copy, typography, number and date formats are designed for Vietnamese and then translated to English, never the other way round.
5. **Exact numbers.** Money is never rounded for display unless the label says so, digits are tabular, amounts are right-aligned, and totals visibly reconcile.
6. **One bold thing per view.** One accent color, one primary action, one memorable visual per page. Everything around it stays quiet.
7. **Accessible by default.** WCAG 2.2 AA is the floor, not a later task.

## 3. Foundations

### 3.1 Color

All colors are tokens in [packages/ui/src/styles/globals.css](packages/ui/src/styles/globals.css) (OKLCH, light on `:root`, dark on `.dark`). Components use token classes only; `pnpm lint` rejects palette classes and literal colors in `apps/app` and `packages/ui` ([tools/ui-colors.mjs](tools/ui-colors.mjs)). `apps/web` follows the same rule by convention until it moves onto `@crove/ui`.

Roles:

| Token | Role |
| :--- | :--- |
| `background`, `card`, `popover` | Page canvas, raised panels, overlays. Three surface levels at most per screen. |
| `foreground`, `muted-foreground`, `subtle-foreground` | Primary text, secondary text, captions. `subtle-foreground` only for text that may be skipped, and only where it still reaches 4.5:1. |
| `border`, `input`, `ring` | Hairlines, field borders, focus ring. |
| `primary` | The one accent: the primary action, focus, current selection. Never decoration. |
| `brand` | The logo mark only. |
| `success`, `warning`, `destructive` | Semantic states (balanced/approved, needs review, error/reject). Separate from the accent; never used for decoration. |
| `chart-1..5` | Data series. Sequential ramp for one measure; use semantic tokens for good/bad. |

Rules:

- About 90 percent of any screen is neutral. The accent marks what to do next; semantic colors mark state.
- Neutrals carry a slight hue bias toward the accent. No pure mid-grey.
- No gradients on text, buttons or backgrounds. No radial glows, no glass blur as decoration, no colored shadows.
- Both themes are designed, not inverted: check contrast and the accent separately in each. The app defaults to dark today (`class="dark"` on `<html>`); the marketing site follows `prefers-color-scheme` with a manual toggle.
- Planned token (added in the implementation PR): `proposal` for AI-proposed, not yet approved data (outline and chip color), so principle 2 has one consistent look.

### 3.2 Typography

- **Every font must ship the Vietnamese subset** and render stacked diacritics (`Ở`, `ữ`, `ặ`) cleanly at all weights. Test with "Hoá đơn giá trị gia tăng, Thuế GTGT được khấu trừ, Người mua hàng" before adopting a face.
- At most two families: one for display and UI, an optional second for display or for numbers. Monospace only for amounts in dense tables, account numbers, codes (MST, mã CQT, invoice numbers) and keyboard keys, never for decorative labels.
- Use variable fonts, subset to latin, latin-ext and vietnamese, `font-display: swap`, self-hosted in production (no third-party font requests from the app).
- Line height: body at least 1.55, headings at least 1.12. Letter spacing on headings no tighter than -0.025em, or diacritics collide. No all-caps on Vietnamese phrases longer than two words; uppercase labels get +0.04em tracking.
- Line length 60 to 75 characters for running text.
- Numbers: `font-variant-numeric: tabular-nums` wherever digits line up.

Scale (rem at 16px root):

| Role | Marketing | App |
| :--- | :--- | :--- |
| Display / hero | 3.25 to 4 (clamp), weight 600 | n/a |
| H1 | 2.25 to 2.75 | 1.5 |
| H2 | 1.75 to 2 | 1.25 |
| H3 | 1.25 | 1 (weight 600) |
| Body | 1.0625 to 1.125 | 0.875 |
| Small / caption | 0.875 | 0.75 |

Weights: 400 body, 500 UI labels, 600 headings. 800 is not used; size and spacing make hierarchy, not extreme weight.

### 3.3 Shape (radius)

Feedback on v2 was that controls looked dated because they were too round. Measured on 2026-10-18: Stripe primary buttons 4px, Raycast 6px, Attio 10px, Linear and Vercel pill only for small marketing nav buttons. A July 2026 survey of 514 design systems found pills most common overall (32 percent) but concentrated in consumer products; finance and B2B tools sit at 4 to 12px. Crove is a finance tool.

| Element | Radius |
| :--- | :--- |
| Buttons, inputs, selects, segmented controls | 6px (target `--radius: 0.5rem`, buttons use `rounded-md`) |
| Cards, panels, table containers | 8px |
| Dialogs, sheets, large marketing tiles | 12px maximum |
| Chips, status badges, avatars, toggles | Full round allowed; these are small and not actions |
| Table cells, dividers | 0 |

Never more than 12px on a container, never pill on a primary action. Radius follows hierarchy: a smaller element inside a larger one gets the same or a smaller radius.

### 3.4 Space and layout

- 4px base unit. Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128.
- Related items sit close; groups are separated by at least twice the inner spacing. Equal spacing everywhere flattens hierarchy.
- Use `gap` in flex and grid, not per-element margins.
- Marketing: max content width 1200px, 12-column grid, left-aligned text by default. Section padding 96 to 128px desktop, 64px phone.
- App: sidebar (collapsible) plus content; list and detail as a split view on wide screens, stacked on phones.
- Breakpoints tested: 360, 768, 1280, 1920px. No horizontal page scroll at 360px; wide tables scroll inside their own container.
- Separate sections with space and typography first, hairlines second, boxes last. Do not nest cards.

### 3.5 Elevation

- Hairline borders define surfaces. Shadows are reserved for things that float: popovers, menus, dialogs, toasts, the command palette. One shadow style per level, neutral, never colored.
- Never combine a hairline border with a wide soft shadow on the same element.

### 3.6 Motion

- Durations: 120ms (hover, press), 200ms (open, close, expand), 320ms (page-level transitions). Easing: `cubic-bezier(0.2, 0, 0, 1)` for entrances, `cubic-bezier(0.4, 0, 1, 1)` for exits. No bounce or elastic on routine UI.
- Motion answers an action or shows what changed (a row moving to "Đã duyệt", a total reconciling). Status that is not changing does not pulse or blink.
- Marketing pages get at most one orchestrated moment (for example the invoice becoming a balanced entry). Content is fully visible at rest; nothing waits at `opacity: 0` for a scroll observer.
- Everything non-essential sits inside `@media (prefers-reduced-motion: no-preference)`.
- No marquees, no auto-advancing carousels, no hover zoom on images, no scale-on-hover buttons.

### 3.7 Icons

- `lucide-react`, stroke 1.5, 16px in dense UI and 20px elsewhere, colored with `currentColor`.
- An icon sits beside its label. No icons inside colored rounded tiles above headings. No emoji as icons.

## 4. Components (`packages/ui`)

Components come from shadcn (base-nova style on Base UI) and are themed only through tokens. Add new ones with `pnpm dlx shadcn@latest add <name>` in `packages/ui`.

### 4.1 Buttons

- Sizes: 28px (`sm`, toolbars and table rows), 32px (`default`, app), 36px (`lg`, forms and dialogs), 40 to 44px (marketing CTAs and touch-first screens). Hit target never below 24x24px.
- Variants: `default` (primary, one per view), `outline` / `secondary`, `ghost` (toolbars), `destructive` (tinted, not solid red, unless it is the confirm step of a destructive dialog), `link`.
- Labels are verbs in sentence case that say what happens: "Duyệt bút toán", "Xuất Excel", "Gửi lời mời". The resulting toast uses the same verb: "Đã duyệt bút toán".
- No arrow appended by default, no gradient, no glow shadow, no scale on hover. Press feedback is the existing 1px translate.
- Loading keeps the label and width, adds a spinner, and disables the button.

### 4.2 Forms

- Label above the field, always visible; placeholder is an example, never the label.
- Validate on blur and on submit, not on every keystroke. The error says what is wrong and how to fix it ("MST phải có 10 hoặc 13 chữ số"), sits under the field and is linked with `aria-describedby`.
- Do not ask for the same information twice in one flow (WCAG 3.3.7). Allow paste into one-time-code fields and let password managers fill credentials (WCAG 3.3.8).
- Money inputs accept "32832000", "32.832.000" and "32,832,000" and display Vietnamese grouping on blur. Values travel as decimal strings (see AGENTS.md).

### 4.3 Tables

- Row height 36px (compact) or 44px (comfortable, default on touch). Sticky header. Zebra striping off; hover row tint on.
- Amounts right-aligned, tabular, same number of decimals in a column; codes and account numbers in the numeric face; text left-aligned.
- Totals row visually separated by a stronger rule, never by color alone.
- Empty, loading (skeleton rows of the right height) and error states are designed for every table.

### 4.4 Status chips

- Small, full-round, text plus a semantic color, never color alone: "Đề xuất", "Cần xem", "Đã duyệt", "Từ chối", "Lỗi".
- One chip vocabulary across modules (finance, agents, social) so the same state always looks the same.

### 4.5 Overlays

- Dialog for decisions that block (approve with step-up, destructive confirm). Sheet for side detail on narrow screens. Popover for small pickers. Toast for results, with an undo where the action allows it.
- Focus moves into the overlay and returns to the trigger on close. Overlays never cover the focused element (WCAG 2.4.11).

## 5. Interaction patterns

### 5.1 Human approval of AI proposals (AI Inbox, agent proposals)

Every proposal screen answers, in this order:

1. **What is proposed**: the exact entry or action, in the form it will be posted (Nợ / Có lines, amounts, accounts).
2. **Why**: the evidence (the source document side by side) and the deterministic checks with their results (tổng dòng, thuế suất, MST, mã CQT, trùng lặp). A failed check is shown first and blocks approval or requires an explicit override with a reason.
3. **Who proposed it**: the agent or rule, its confidence signal in plain words ("Tài khoản 152 đã dùng 6 lần cho nhà cung cấp này"), never a bare percentage.
4. **What happens next**: the approve button names the outcome ("Duyệt và ghi sổ"); step-up two-factor appears inline when the risk requires it.

Approve, edit and reject have equal visual access (reject is not hidden in a menu). Bulk approval exists only for items whose checks all passed and is limited to what fits on one screen. Every decision links to its audit log entry.

### 5.2 Keyboard

- `⌘K` / `Ctrl K` opens the command palette everywhere in the app.
- Lists: `J` / `K` move, `Enter` opens, `A` approves, `E` edits, `R` rejects, `Esc` closes. Shortcuts are shown in menus and tooltips, and every one has a pointer equivalent.
- Drag interactions always have a non-drag alternative (WCAG 2.5.7).

### 5.3 Empty, loading and error states

- Empty states say what will appear and give the one action that fills them ("Chuyển tiếp hoá đơn tới địa chỉ này hoặc tải file XML lên").
- Loading uses skeletons shaped like the content; spinners only inside buttons and small regions.
- Errors say what happened and what to do, in the product's voice, without apology. Kernel error codes map to messages in the i18n catalog.

### 5.4 Data visualization

- Draw to scale with one axis scale per chart; label values directly when there are few series; legends only when direct labels do not fit.
- Chart text and gridlines use theme tokens; series use `chart-*`; good and bad use semantic tokens.
- Sparklines: thin line, light area fill, emphasized last point, no axes.
- Prefer a table when exact values matter more than the shape.
- Every chart has a text alternative (a caption with the key number, or an accessible table).

### 5.5 Formats

- Money: `32.832.000 ₫` in Vietnamese (`vi-VN`), `₫32,832,000` in English (`en-GB`). Never rounded to whole đồng when the ledger holds decimals. Format through `apps/app/src/lib/format.ts` from decimal strings, never JS number arithmetic.
- Dates: `dd/mm/yyyy`, times 24-hour (`16:05`). Relative time ("2 phút trước") only for activity feeds, with the absolute time in a tooltip.
- Tax and document codes keep their official formatting (MST, ký hiệu `1C26TPT`, số `00001284`).

## 6. Marketing site (`apps/web`)

### 6.1 Page anatomy

1. Header: logo, at most four links, "Đăng nhập", one primary CTA, theme and language toggles.
2. Hero: one-sentence thesis, one supporting sentence, primary and secondary action, and the product working (a live HTML rendering, not a screenshot with fake browser chrome).
3. How it works: the real sequence (receive, check, propose, approve), each step with a fragment of real UI.
4. Modules: varied layouts chosen by content, each with a real fragment. Not a grid of identical icon cards.
5. Trust: AI proposes and people approve, the audit log, tenant isolation, open source with the `docker compose up` command.
6. Pricing: only what is decided. No invented prices or discounts.
7. FAQ (three to six questions), footer with license and repository link.

### 6.2 Claims and content

- No invented statistics, customer counts, logos, ratings or testimonials. Social proof appears only when it is real and consented.
- The marketing site in this repository describes the open-source core. DOS-only services (for example DOS ID single sign-on) belong to the private Crove Cloud layer and are not promised here.
- Name what the product does today; label future work as such ("sắp ra mắt").
- Product visuals use clearly fictional example companies and mark the data as example data once.

### 6.3 Performance budget

- Core Web Vitals at the 75th percentile: LCP under 2.5s, INP under 200ms, CLS under 0.1.
- Static sections render on the server with no client JavaScript; interactive pieces hydrate on their own.
- Two font families at most, preloaded, subset; no layout shift on font swap (matched fallback metrics).
- Product visuals are HTML and SVG, not large images. Any raster image is AVIF or WebP with explicit dimensions.

## 7. Accessibility (WCAG 2.2 AA)

- Contrast: 4.5:1 for body text, 3:1 for large text, icons and meaningful borders, in both themes.
- Visible `:focus-visible` ring on every interactive element, never hidden behind sticky headers or banners (2.4.11).
- Targets at least 24x24px (2.5.8); 44px on touch-first screens.
- Semantic landmarks and heading order; icon-only buttons have `aria-label`; tables use real `<table>` markup.
- Color is never the only signal (chips have text, charts have labels).
- Help is in the same place on every screen (3.2.6): the "Góp ý / Hỗ trợ" link.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.
- Test with keyboard only and with a screen reader (NVDA or VoiceOver) on the approval flow before release.

## 8. Internationalization

- Vietnamese is the default locale; English is the second (`apps/app/src/i18n/locale.ts`).
- App: `use-intl`, messages in `apps/app/src/i18n/messages/vi.ts` and `en.ts`; every visible string, including toasts, errors and aria labels, has a key in both.
- Marketing site: one route per language (`/` Vietnamese, `/en` English), copy in `apps/web/src/content/vi.ts` and `en.ts`; the `Dictionary` type keeps them in step, so a missing English string fails typecheck. A page never mixes languages (no Vietnamese button in the English page); example company names and documents stay Vietnamese in both.
- Vietnamese text runs about 10 to 30 percent longer than English: layouts must not depend on English string lengths.

## 9. App engineering notes

- Routing: TanStack Router. Server state: TanStack Query through the oRPC client (`apps/app/src/lib/api.ts`); realtime invalidation comes from the SSE stream (`apps/app/src/lib/stream.ts`), not polling.
- Every write goes through a kernel command (`Runtime.execute()`); the UI updates optimistically only where the command is idempotent and the rollback is visible.
- Modules contribute their own menu items and routes (ADR-0031); the shell does not hardcode module navigation.

## 10. Do not

- Gradient text, gradient buttons, purple-to-pink or purple-to-blue washes, radial glow blobs, decorative glassmorphism.
- Pill badges above headlines, tracked all-caps eyebrows above every heading, emoji icons, icon tiles over headings.
- Identical card grids, nested cards, a border plus a wide shadow on the same element, radius above 12px on containers.
- Fake browser chrome, fake metrics, fake testimonials, marquees, auto carousels, pulsing static status.
- Raw palette classes or literal colors in components; colors live in the token file.
- Fonts without the Vietnamese subset, headings tracked tighter than -0.025em, all-caps Vietnamese sentences.
- Hype copy ("siêu", "đột phá", "supercharge"), "not X but Y" slogans, em dashes.
- Heavy UI kits (Material UI, Ant Design). Build on `@crove/ui`.
- Shipping a screen that has not been checked at 360px, in both themes, and with the keyboard.

## 11. References

Measured on 2026-10-18 from the live sites (computed styles of the hero heading and primary buttons):

| Site | Body / heading face | Hero heading | Primary button |
| :--- | :--- | :--- | :--- |
| Stripe | Söhne | weight 300, -0.01em | 4px radius, 44px tall |
| Raycast | Inter | weight 600 | 6px radius |
| Attio | Inter / Inter Display | 64px, weight 600, -0.02em | 10px radius, 40px tall, near-black |
| Linear | Inter Variable | weight 510, -0.022em | pill, 32px tall, near-white on dark (nav size) |
| Vercel | Geist | weight 400, -0.04em | pill (nav size) |

Sources:

- [What corner radius do modern products use for primary buttons?](https://www.lazyweb.com/research/what-button-corner-radius-is-standard), Lazyweb Research, July 2026 (514 design systems).
- [The visible tells of AI design](https://www.impeccable.style/slop), Impeccable (catalog of generated-UI patterns and alternatives).
- [10 trends creatives are so over in 2026](https://creativeboom.com/insight/10-trends-creatives-are-so-over-in-2026/), Creative Boom.
- [10 SaaS landing page trends for 2026](https://www.saasframe.io/blog/10-saas-landing-page-trends-for-2026-with-real-examples), SaaSFrame.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), W3C (ISO/IEC 40500:2025).
- [Designing for AI agents: 8 UX patterns that build trust in 2026](https://pub.towardsai.net/designing-for-ai-agents-8-ux-patterns-that-build-trust-in-2026-713a0c926933), Towards AI.
- [Human-in-the-loop patterns: approval, input and escalation](https://understandingdata.com/posts/human-in-the-loop-patterns/), Understanding Data.
- [Web typography trends 2026](https://madegooddesigns.com/web-typography-trends-2026/), Made Good Designs.
