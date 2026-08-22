# 🎨 Crove Design System & Frontend Engineering Guidelines (DESIGN.md)

> **Version:** 2.0.0  
> **Target Audience:** Frontend Engineers, UI/UX Designers, AI Coding Agents  
> **Core Concept:** *The Modern Business OS for Solo Founders & SMEs*  
> **Aesthetic DNA:** Linear-clean • Raycast-dense • Supabase-developer-friendly • Vercel-fluid

---

## 1. 🌟 Design Philosophy & Brand Identity

Crove is the **All-in-One Business Operating System (OS)** designed specifically for **Solo Founders, Creators, Indie Hackers, and SMEs**. It consolidates essential business operations—Distribution & Social, Workflow Automation, CRM & Audience, Digital Asset Management, and Growth Analytics—into a cohesive, unified workspace.

### Core Design Principles
1. **Zero Clutter, Maximum Density (SaaS Power User UX):** Information density is high but never overwhelming. Use subtle borders (`1px border-zinc-200/80` or `border-zinc-800/80`), clear visual hierarchies, and collapsible sidebars.
2. **Speed & Perceived Performance:** Instant feedback, optimistic UI updates, subtle skeleton loaders, smooth state transitions (\(\le 200\text{ms}\)).
3. **True Dual-Theme (Dark by Default, Polished Light):**
   - **Dark Mode:** Obsidian background (`#08080f`), elevated glass cards (`#0f0f1c` / `#121224`), deep violet glows.
   - **Light Mode:** Crisp pearl background (`#faf9fe`), clean white elevated cards (`#ffffff`), subtle purple-tinted borders (`#e8e5f2`).
4. **Dominant Royal Purple & Ambient Glows:** Royal Purple (`#612BD3` / `#7c3aed`) as primary accent, paired with neon micro-accents for telemetry and status indicators.
5. **Universal Accessibility (WCAG 2.1 AA):** All interactive elements must maintain a minimum contrast ratio of 4.5:1, include explicit `focus-visible` rings, and provide accessible labels.

---

## 2. 🎨 Color Tokens & Palette

All frontend code must rely exclusively on CSS variables and Tailwind theme tokens. **Never hardcode hex values directly into component styles.**

### 2.1 Brand Tokens
| Token | Hex | Dark Mode Usage | Light Mode Usage |
| :--- | :--- | :--- | :--- |
| `brand.50` | `#f5f3ff` | Subtle badge bg (darkened) | Hover highlights, pill bgs |
| `brand.100` | `#ede9fe` | Card border highlights | Active tab backgrounds |
| `brand.300` | `#c4b5fd` | Secondary typography | Muted icons |
| `brand.500` | `#8b5cf6` | Ambient radial glows | Interactive states |
| `brand.600` | `#7c3aed` | **Primary CTA Buttons**, Active states | **Primary Buttons & Active Links** |
| `brand.700` | `#6d28d9` | Button hover states | Deep accent badges |
| `brand.crove`| `#612BD3` | Core Crove Brand Mark | Core Crove Brand Mark |

### 2.2 Surface & Neutral Tokens
| Role | Dark Theme (`.dark`) | Light Theme (`.light`) |
| :--- | :--- | :--- |
| **Page Canvas (`bg-main`)** | `#08080f` (Obsidian Base) | `#faf9fe` (Off-white Pearl) |
| **Elevated Surface (Card)** | `#0f0f1c` / `#121224` (80% Glass) | `#ffffff` (95% Glass) |
| **Borders & Dividers** | `rgba(255, 255, 255, 0.08)` / `#1e1e2f` | `rgba(0, 0, 0, 0.08)` / `#e8e5f2` |
| **Text - Primary** | `#ffffff` / `text-white` | `#09090b` / `text-zinc-900` |
| **Text - Secondary** | `#a1a1aa` / `text-zinc-400` | `#52525b` / `text-zinc-600` |
| **Text - Muted / Micro** | `#71717a` / `text-zinc-500` | `#a1a1aa` / `text-zinc-400` |

### 2.3 Semantic & Functional Accents
- **Success / Online:** Emerald (`#10b981` / `text-emerald-500`, `bg-emerald-500/10`)
- **Warning / Pending:** Amber (`#f59e0b` / `text-amber-500`, `bg-amber-500/10`)
- **Danger / Error:** Rose (`#f43f5e` / `text-rose-500`, `bg-rose-500/10`)
- **AI Copilot / Magic Glow:** Fuchsia & Violet Gradient (`from-brand-600 via-purple-500 to-pink-500`)

---

## 3. 📐 Typography & Hierarchy

### Font Family
- **Primary Body & Headings:** `Inter`, `Geist`, or System Sans-Serif (`font-sans`).
- **Code, Metrics & Telemetry:** `JetBrains Mono`, `Fira Code`, or System Monospace (`font-mono`).

### Type Scale & Leading Guidelines
```css
/* Hero Display */
.hero-title {
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.1;
}

/* Section Headings (H2) */
.section-title {
  font-size: clamp(1.875rem, 4vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.025em;
  line-height: 1.15;
}

/* Card Titles (H3) */
.card-title {
  font-size: 1.125rem; /* 18px */
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.35;
}

/* Body Regular */
.body-text {
  font-size: 0.875rem; /* 14px */
  font-weight: 400;
  line-height: 1.6;
}

/* Micro / Caption / Badge */
.micro-text {
  font-size: 0.6875rem; /* 11px */
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
```

---

## 4. 🧩 Component Architecture & Patterns

### 4.1 Glassmorphism & Elevation Cards
Always use a multi-layer border and subtle backdrop blur to achieve a premium Linear-like finish.

```tsx
// Standard Elevated Glass Card
<div className="rounded-2xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl p-6 shadow-sm hover:shadow-xl hover:border-brand-400 dark:hover:border-brand-500/40 transition-all duration-300">
  {/* Content */}
</div>
```

### 4.2 Buttons & Action Triggers
1. **Primary Action (Brand Gradient):**
   ```tsx
   <button className="px-6 py-3 rounded-xl bg-gradient-to-r from-brand-600 via-brand-600 to-brand-700 hover:from-brand-500 hover:to-brand-600 text-white font-bold text-sm shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex items-center gap-2">
     <span>Get Started</span>
     <ArrowRight className="w-4 h-4" />
   </button>
   ```
2. **Secondary / Glass Action:**
   ```tsx
   <button className="px-5 py-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/60 text-zinc-800 dark:text-zinc-200 hover:text-brand-600 dark:hover:text-white hover:border-brand-300 dark:hover:border-brand-500/40 font-semibold text-sm backdrop-blur-md transition-all duration-200">
     <span>Learn More</span>
   </button>
   ```
3. **Ghost / Micro Action:**
   ```tsx
   <button className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
     <MoreHorizontal className="w-4 h-4" />
   </button>
   ```

### 4.3 Ambient Glows & Grids
Use subtle radial glow backgrounds behind heroes, bento cards, and interactive studios:
```tsx
<div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-gradient-to-tr from-brand-600/20 via-brand-500/12 to-fuchsia-500/10 blur-[130px] rounded-full pointer-events-none -z-10" />
```

---

## 5. 🌐 Internationalization (i18n) Rules

1. **Zero Hardcoded Strings:** Every piece of visible text (titles, descriptions, button labels, placeholders, tooltips, toasts) must come from the i18n dictionary.
2. **Landing Page (`apps/web`):**
   - Import hook: `const { t, lang, setLang } = useI18n();`
   - Access nested keys: `t.hero.titleStart`, `t.features.card1Desc`.
   - Update both `vi` (Vietnamese) and `en` (English) in `apps/web/src/i18n/translations.ts`.
3. **Core Dashboard App (`apps/frontend`):**
   - Client components: `const t = useT();`
   - Backend/Server components: `const t = getT();`
   - Keep translation keys grouped logically by domain (`common`, `dashboard`, `channels`, `settings`, `billing`).

---

## 6. ⚡ State Management & Data Fetching Rules

1. **SWR is Mandatory for Client Data Fetching:** Always use the custom `useFetch` wrapper from `@gitroom/helpers/utils/custom.fetch`.
2. **Strict Rule of Hooks:** Each SWR hook must be defined independently in top-level files. Never instantiate multiple SWR calls dynamically inside object returns.
3. **Optimistic UI:** When toggling switches, scheduling items, or renaming workspaces, update local UI state immediately while the API request processes.

---

## 7. 🚫 Strict "DON'Ts" for AI Agents & Developers

- ❌ **DO NOT** use deprecated `--color-custom*` classes.
- ❌ **DO NOT** create messy rainbow color palettes. Keep 90% of the UI in monochrome (obsidian/pearl/zinc) and use royal purple for high-value focal points.
- ❌ **DO NOT** add raw HTML `<a>` tags with absolute routes when Next.js `<Link>` is appropriate.
- ❌ **DO NOT** leave raw English or Vietnamese strings un-translated without corresponding dictionary keys in both languages.
- ❌ **DO NOT** use bulky third-party UI component libraries (e.g. heavy Material UI or ant-design packages). Implement clean native Tailwind/Radix primitives.
- ❌ **DO NOT** break responsive viewports. Every page must be tested across mobile (\(360\text{px}\)), tablet (\(768\text{px}\)), desktop (\(1280\text{px}\)), and ultra-wide (\(1920\text{px}\)).
