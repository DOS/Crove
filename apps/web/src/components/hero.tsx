'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../i18n/i18n-context';
import {
  ArrowRight,
  Sparkles,
  Calendar,
  Layers,
  BarChart3,
  CheckCircle2,
  Play,
  Share2,
  Clock,
  Zap,
  Plus,
  Video,
  Send,
  Sliders,
  Check,
  Cpu,
  Users2,
  HardDrive,
  LineChart,
  ShieldCheck,
  TrendingUp,
  Activity,
} from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

export function Hero() {
  const { t } = useI18n();
  const [activeApp, setActiveApp] = useState<'post' | 'flow' | 'audience' | 'media' | 'analytics'>('post');

  return (
    <section className="relative pt-28 pb-16 md:pt-36 md:pb-24 overflow-hidden">
      {/* Background ambient lighting effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] md:w-[850px] h-[400px] md:h-[550px] bg-gradient-to-tr from-brand-600/20 via-brand-500/12 to-fuchsia-500/10 blur-[130px] rounded-full pointer-events-none -z-10" />
      <div className="absolute top-12 right-12 w-64 h-64 bg-brand-500/10 blur-[90px] rounded-full pointer-events-none -z-10" />
      <div className="absolute bottom-10 left-10 w-72 h-72 bg-purple-600/10 blur-[100px] rounded-full pointer-events-none -z-10" />

      {/* Grid Pattern overlay */}
      <div className="absolute inset-0 bg-grid-pattern opacity-50 dark:opacity-40 -z-10 [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black_75%)]" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-4xl mx-auto space-y-5">
          {/* Top announcement pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-white/80 dark:bg-brand-950/40 backdrop-blur-md shadow-sm shadow-brand-500/10 text-xs font-semibold text-brand-700 dark:text-brand-300 animate-fade-in">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-500"></span>
            </span>
            <span>{t.hero.announcement}</span>
            <span className="text-zinc-300 dark:text-zinc-600">|</span>
            <span className="font-bold text-brand-600 dark:text-brand-400">
              {t.hero.announcementHighlight}
            </span>
          </div>

          {/* Main Headline */}
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-zinc-900 dark:text-white leading-[1.12]">
            {t.hero.titleStart}
            <span className="text-gradient-purple block sm:inline">
              {t.hero.titleGradient}
            </span>
            {t.hero.titleEnd}
          </h1>

          {/* Subheading */}
          <p className="text-base sm:text-lg lg:text-xl text-zinc-600 dark:text-zinc-300 max-w-3xl mx-auto font-normal leading-relaxed">
            {t.hero.subtitle}
          </p>

          {/* Action CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-3">
            <a
              href={`${APP_URL}/auth/login`}
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-gradient-to-r from-brand-600 via-brand-600 to-brand-700 hover:from-brand-500 hover:to-brand-600 text-white font-bold text-sm shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 group"
            >
              <Sparkles className="w-4 h-4 text-brand-200" />
              <span>{t.hero.startFree}</span>
              <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>

            <Link
              href="#suite"
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl border border-zinc-200/90 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/60 text-zinc-800 dark:text-zinc-200 hover:text-brand-600 dark:hover:text-white hover:border-brand-300 dark:hover:border-brand-500/40 font-semibold text-sm backdrop-blur-md hover:bg-white dark:hover:bg-zinc-900 shadow-sm transition-all duration-200 flex items-center justify-center gap-2"
            >
              <Layers className="w-4 h-4 text-brand-500" />
              <span>{t.hero.watchDemo}</span>
            </Link>
          </div>

          {/* Trust bullet points */}
          <div className="pt-2 flex flex-wrap items-center justify-center gap-y-2 gap-x-5 text-xs text-zinc-500 dark:text-zinc-400">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t.hero.trustCardFree}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t.hero.trustInstant}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t.hero.trustApi}</span>
            </div>
          </div>
        </div>

        {/* Hero Interactive App Mockup Preview (Linear/Raycast Business OS Style) */}
        <div className="mt-12 sm:mt-16 relative max-w-5xl mx-auto">
          {/* Glowing backdrop border */}
          <div className="absolute -inset-1 bg-gradient-to-r from-brand-600 via-purple-500 to-pink-500 rounded-3xl blur-md opacity-35 dark:opacity-50 animate-glow-pulse" />

          {/* Main Dashboard Window */}
          <div className="relative rounded-2xl border border-zinc-200/90 dark:border-zinc-800 bg-white/95 dark:bg-[#0c0c16]/95 backdrop-blur-2xl shadow-2xl overflow-hidden">
            {/* Window Top bar */}
            <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/80 dark:bg-zinc-900/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                <span className="ml-2 text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
                  {t.hero.mockupUrl}
                </span>
              </div>

              {/* Status Indicator */}
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {t.hero.mockupSynced}
                </span>
              </div>
            </div>

            {/* Dashboard Workspace Layout */}
            <div className="grid grid-cols-12 min-h-[420px]">
              {/* Left Sub-Sidebar (OS App Switcher) */}
              <div className="col-span-12 sm:col-span-3 border-r border-zinc-200/80 dark:border-zinc-800/80 p-3 bg-zinc-50/50 dark:bg-[#080811]/60 flex flex-col justify-between">
                <div className="space-y-1">
                  <div className="px-2 py-1.5 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                    {t.hero.mockupWorkspaceName}
                  </div>

                  <button
                    onClick={() => setActiveApp('post')}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-colors ${
                      activeApp === 'post'
                        ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Share2 className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupAppPost}</span>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/20 text-white font-mono">
                      28+
                    </span>
                  </button>

                  <button
                    onClick={() => setActiveApp('flow')}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-colors ${
                      activeApp === 'flow'
                        ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Cpu className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupAppFlow}</span>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-600 dark:text-brand-300 font-bold">
                      AI
                    </span>
                  </button>

                  <button
                    onClick={() => setActiveApp('audience')}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-colors ${
                      activeApp === 'audience'
                        ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Users2 className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupAppAudience}</span>
                    </div>
                  </button>

                  <button
                    onClick={() => setActiveApp('media')}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-colors ${
                      activeApp === 'media'
                        ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupAppMedia}</span>
                    </div>
                  </button>

                  <button
                    onClick={() => setActiveApp('analytics')}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-colors ${
                      activeApp === 'analytics'
                        ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <LineChart className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupAppAnalytics}</span>
                    </div>
                  </button>
                </div>

                {/* Quick Real-Time Metrics in Sidebar */}
                <div className="mt-4 p-2.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 space-y-2">
                  <div className="text-[10px] text-zinc-400 flex items-center justify-between">
                    <span>{t.hero.mockupStatMrr}</span>
                    <TrendingUp className="w-3 h-3 text-emerald-500" />
                  </div>
                  <div className="font-bold text-xs text-zinc-900 dark:text-white font-mono">
                    {t.hero.mockupStatMrrVal}
                  </div>
                  <div className="text-[10px] text-zinc-400 flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/60">
                    <span>{t.hero.mockupStatReach}</span>
                    <span className="font-bold text-brand-600 dark:text-brand-400 font-mono text-[11px]">
                      {t.hero.mockupStatReachVal}
                    </span>
                  </div>
                </div>
              </div>

              {/* Central Main Stage */}
              <div className="col-span-12 sm:col-span-9 p-4 sm:p-5 flex flex-col justify-between space-y-4">
                {/* Top Action Ribbon */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <div className="px-3 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-brand-500" />
                      <span>{t.hero.mockupCalendarTab}</span>
                    </div>
                    <div className="px-3 py-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800/60 text-xs font-medium text-zinc-500 transition-colors hidden sm:flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5" />
                      <span>{t.hero.mockupPipelineTab}</span>
                    </div>
                  </div>

                  <a
                    href={`${APP_URL}/launches`}
                    className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-sm flex items-center gap-1.5 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t.hero.mockupNewPost}</span>
                  </a>
                </div>

                {/* Simulated Content Schedule Feed */}
                <div className="space-y-2.5">
                  {/* Item 1 - Video Short */}
                  <div className="p-3 rounded-xl border border-zinc-200/90 dark:border-zinc-800/90 bg-zinc-50/70 dark:bg-zinc-900/50 flex items-center justify-between gap-3 hover:border-brand-400 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-600 flex items-center justify-center flex-shrink-0">
                        <Video className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                          {t.hero.mockupPost1Title}
                        </div>
                        <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                          <Clock className="w-3 h-3 text-emerald-500" />
                          <span>{t.hero.mockupPost1Status}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-600 border border-rose-500/20">
                        TikTok 9:16
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 border border-red-500/20 hidden sm:inline-block">
                        Shorts
                      </span>
                    </div>
                  </div>

                  {/* Item 2 - LinkedIn + X */}
                  <div className="p-3 rounded-xl border border-zinc-200/90 dark:border-zinc-800/90 bg-zinc-50/70 dark:bg-zinc-900/50 flex items-center justify-between gap-3 hover:border-brand-400 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center flex-shrink-0">
                        <Share2 className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                          {t.hero.mockupPost2Title}
                        </div>
                        <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                          <Zap className="w-3 h-3 text-amber-500" />
                          <span>{t.hero.mockupPost2Status}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">
                        LinkedIn
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 hidden sm:inline-block">
                        X Thread
                      </span>
                    </div>
                  </div>

                  {/* Item 3 - Email & CRM */}
                  <div className="p-3 rounded-xl border border-zinc-200/90 dark:border-zinc-800/90 bg-zinc-50/70 dark:bg-zinc-900/50 flex items-center justify-between gap-3 hover:border-brand-400 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/10 text-purple-600 flex items-center justify-center flex-shrink-0">
                        <Users2 className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                          {t.hero.mockupPost3Title}
                        </div>
                        <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                          <Clock className="w-3 h-3 text-zinc-400" />
                          <span>{t.hero.mockupPost3Status}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 border border-purple-500/20">
                        Newsletter
                      </span>
                    </div>
                  </div>
                </div>

                {/* Bottom AI Copilot Status Bar */}
                <div className="p-2.5 rounded-xl bg-gradient-to-r from-brand-600/10 via-purple-500/10 to-pink-500/10 border border-brand-500/20 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-brand-700 dark:text-brand-300 font-semibold">
                    <Sparkles className="w-3.5 h-3.5 text-brand-500 animate-spin" />
                    <span>{t.hero.mockupAiBadge}</span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                    GPT-4o & Claude 3.5 Engine
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
