# 👑 Crove — The Modern Business OS

> **The All-in-One Business Operating System for Solo Founders & SMEs.**  
> Unifying Social Distribution, Workflow Automation, CRM, Digital Asset Management, and Growth Analytics.

---

## 🌟 Overview

**Crove** consolidates essential business operations into a single, cohesive ecosystem:
- **Crove Post** (`apps/web` / `post.crove.com`): AI Social Media & Multi-Channel Distribution (34+ platforms)
- **Crove CRM** (`crm.crove.com`): Metadata-driven, high-velocity customer relationship management
- **Crove Cal** (`cal.crove.com`): Infrastructure-grade event scheduling & booking
- **Crove Sign** (`sign.crove.com`): Open-source digital signature & document workflow

---

## 🏗️ Monorepo Structure

```
├── apps/
│   └── web/            # Next.js 16 Marketing & Landing Page (@crove/web)
├── packages/           # Shared packages, UI components, and configs
├── DESIGN.md           # Crove Design System 2.0 (Violet aesthetic, Linear-clean UX)
└── package.json        # PNPM Workspace root
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: `>= 20.0.0` (Recommended: `22.x`)
- **PNPM**: `>= 9.0.0` (Recommended: `10.6.1`)

### Local Development

```powershell
# 1. Install dependencies
pnpm install

# 2. Run the Landing Page in dev mode
pnpm dev

# Accessible at: http://localhost:3000
```

### Production Build

```powershell
pnpm build
pnpm start
```

---

## 🎨 Design System

See [`DESIGN.md`](./DESIGN.md) for full design tokens, color palette, glassmorphism cards, and typography guidelines.

---

## 📄 License

AGPL-3.0 © Crove / DOS.
