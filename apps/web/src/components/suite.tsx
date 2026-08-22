'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import {
  Layers,
  Share2,
  Cpu,
  Users2,
  HardDrive,
  LineChart,
  Sparkles,
  ArrowUpRight,
  CheckCircle2,
  Zap,
} from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

export function Suite() {
  const { t } = useI18n();

  const apps = [
    {
      id: 'post',
      title: t.suite.app1Title,
      tag: t.suite.app1Tag,
      desc: t.suite.app1Desc,
      icon: Share2,
      badgeColor: 'bg-brand-500/10 text-brand-600 dark:text-brand-400 border-brand-500/20',
      gradient: 'from-brand-600 to-purple-700',
      href: `${APP_URL}/launches`,
      active: true,
      stats: '28+ Kênh xã hội',
    },
    {
      id: 'flow',
      title: t.suite.app2Title,
      tag: t.suite.app2Tag,
      desc: t.suite.app2Desc,
      icon: Cpu,
      badgeColor: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/20',
      gradient: 'from-fuchsia-600 to-pink-700',
      href: '#preview',
      active: true,
      stats: 'AI Agents 24/7',
    },
    {
      id: 'audience',
      title: t.suite.app3Title,
      tag: t.suite.app3Tag,
      desc: t.suite.app3Desc,
      icon: Users2,
      badgeColor: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
      gradient: 'from-emerald-600 to-teal-700',
      href: `${APP_URL}/auth/login`,
      active: true,
      stats: 'Lead & Email CRM',
    },
    {
      id: 'media',
      title: t.suite.app4Title,
      tag: t.suite.app4Tag,
      desc: t.suite.app4Desc,
      icon: HardDrive,
      badgeColor: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      gradient: 'from-blue-600 to-indigo-700',
      href: `${APP_URL}/auth/login`,
      active: true,
      stats: 'Cloudflare R2 CDN',
    },
    {
      id: 'insights',
      title: t.suite.app5Title,
      tag: t.suite.app5Tag,
      desc: t.suite.app5Desc,
      icon: LineChart,
      badgeColor: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
      gradient: 'from-amber-600 to-orange-700',
      href: `${APP_URL}/analytics`,
      active: true,
      stats: 'Báo cáo ROI thực',
    },
  ];

  return (
    <section id="suite" className="py-20 sm:py-28 relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[450px] bg-brand-500/10 blur-[140px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Layers className="w-3.5 h-3.5 text-brand-500" />
            <span>{t.suite.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.suite.titleStart}
            <span className="text-gradient-purple">{t.suite.titleGradient}</span>
            {t.suite.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base leading-relaxed">
            {t.suite.subtitle}
          </p>
        </div>

        {/* Bento Grid Suite */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {apps.map((app, idx) => {
            const Icon = app.icon;
            const isFeatured = idx === 0;

            return (
              <div
                key={app.id}
                className={`p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl hover:border-brand-400 dark:hover:border-brand-500/50 hover:shadow-xl hover:shadow-brand-500/10 transition-all duration-300 group flex flex-col justify-between relative overflow-hidden ${
                  isFeatured ? 'md:col-span-2 lg:col-span-2' : ''
                }`}
              >
                {/* Background decorative corner glow */}
                <div
                  className={`absolute -top-12 -right-12 w-44 h-44 bg-gradient-to-br ${app.gradient} opacity-10 blur-2xl rounded-full pointer-events-none group-hover:opacity-20 transition-opacity duration-300`}
                />

                <div className="space-y-4 relative z-10">
                  <div className="flex items-center justify-between">
                    <div
                      className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${app.gradient} flex items-center justify-center text-white shadow-md shadow-brand-500/20 group-hover:scale-105 transition-transform duration-300`}
                    >
                      <Icon className="w-6 h-6" />
                    </div>

                    <span
                      className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${app.badgeColor}`}
                    >
                      {app.tag}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-white flex items-center gap-1.5">
                      <span>{app.title}</span>
                      <ArrowUpRight className="w-4 h-4 text-zinc-400 group-hover:text-brand-500 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform duration-200" />
                    </h3>
                    <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      {app.desc}
                    </p>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-xs font-semibold text-zinc-500 dark:text-zinc-400 relative z-10">
                  <span className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    {app.stats}
                  </span>

                  <a
                    href={app.href}
                    className="text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:text-brand-600 dark:hover:text-brand-400 transition-colors flex items-center gap-1"
                  >
                    <span>Khám phá</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
