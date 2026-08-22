'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import {
  Calendar,
  Layers,
  BarChart3,
  Users2,
  Bot,
  Zap,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Video,
  Sparkles,
} from 'lucide-react';

export function Features() {
  const { t } = useI18n();

  return (
    <section id="features" className="py-20 sm:py-28 relative overflow-hidden bg-zinc-50/40 dark:bg-zinc-950/30 border-y border-zinc-200/80 dark:border-zinc-800/80">
      {/* Background ambient radial lights */}
      <div className="absolute top-1/3 right-10 w-[450px] h-[450px] bg-brand-500/10 blur-[130px] rounded-full pointer-events-none -z-10" />
      <div className="absolute bottom-10 left-10 w-[350px] h-[350px] bg-purple-600/10 blur-[100px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span>{t.features.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.features.titleStart}
            <span className="text-gradient-purple">{t.features.titleGradient}</span>
            {t.features.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.features.subtitle}
          </p>
        </div>

        {/* Bento Grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1 - AI Repurposer (Span 2 cols on md) */}
          <div className="md:col-span-2 p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl relative overflow-hidden flex flex-col justify-between group hover:border-brand-400 dark:hover:border-brand-500/50 transition-all duration-300">
            <div className="absolute top-0 right-0 w-72 h-72 bg-gradient-to-bl from-brand-500/15 via-transparent to-transparent rounded-full pointer-events-none" />

            <div className="space-y-4 max-w-xl z-10">
              <div className="w-11 h-11 rounded-2xl bg-brand-600 text-white flex items-center justify-center shadow-lg shadow-brand-500/25">
                <Bot className="w-5 h-5" />
              </div>

              <div className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800">
                {t.features.card1Badge}
              </div>

              <h3 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white tracking-tight">
                {t.features.card1Title}
              </h3>

              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                {t.features.card1Desc}
              </p>
            </div>

            {/* Visual Simulated snippet */}
            <div className="mt-6 pt-5 border-t border-zinc-100 dark:border-zinc-800/80 grid grid-cols-1 sm:grid-cols-3 gap-3 z-10">
              <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 text-xs space-y-1">
                <div className="font-semibold text-brand-600 dark:text-brand-400">
                  {t.features.card1Tag1}
                </div>
                <p className="text-zinc-500 dark:text-zinc-400 text-[11px] line-clamp-2">
                  "Hook 3s + viral CTA link in bio..."
                </p>
              </div>
              <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 text-xs space-y-1">
                <div className="font-semibold text-blue-600 dark:text-blue-400">
                  {t.features.card1Tag2}
                </div>
                <p className="text-zinc-500 dark:text-zinc-400 text-[11px] line-clamp-2">
                  "Thought leadership & metric takeaways..."
                </p>
              </div>
              <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 text-xs space-y-1">
                <div className="font-semibold text-zinc-900 dark:text-zinc-200">
                  {t.features.card1Tag3}
                </div>
                <p className="text-zinc-500 dark:text-zinc-400 text-[11px] line-clamp-2">
                  "1/5 Thread: Why automation wins..."
                </p>
              </div>
            </div>
          </div>

          {/* Card 2 - Visual Drag & Drop Calendar */}
          <div className="p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl relative overflow-hidden flex flex-col justify-between group hover:border-brand-400 dark:hover:border-brand-500/50 transition-all duration-300">
            <div className="space-y-4 z-10">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/25">
                <Calendar className="w-5 h-5" />
              </div>

              <div className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/50">
                {t.features.card2Badge}
              </div>

              <h3 className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-white tracking-tight">
                {t.features.card2Title}
              </h3>

              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                {t.features.card2Desc}
              </p>
            </div>

            <div className="mt-6 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between text-xs font-medium text-zinc-600 dark:text-zinc-300">
              <span className="flex items-center gap-1.5 text-[11px]">
                <Clock className="w-3.5 h-3.5 text-emerald-500" />
                {t.features.card2BestTime}
              </span>
            </div>
          </div>

          {/* Card 3 - Video Automation (TikTok & Reels) */}
          <div className="p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl relative overflow-hidden flex flex-col justify-between group hover:border-brand-400 dark:hover:border-brand-500/50 transition-all duration-300">
            <div className="space-y-4 z-10">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-rose-500 to-pink-600 text-white flex items-center justify-center shadow-lg shadow-rose-500/25">
                <Video className="w-5 h-5" />
              </div>

              <div className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-100 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/50">
                {t.features.card3Badge}
              </div>

              <h3 className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-white tracking-tight">
                {t.features.card3Title}
              </h3>

              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                {t.features.card3Desc}
              </p>
            </div>

            <div className="mt-6 flex items-center gap-2">
              <span className="px-2 py-1 rounded-lg bg-zinc-900 text-white text-[10px] font-bold">
                TikTok 9:16
              </span>
              <span className="px-2 py-1 rounded-lg bg-red-600 text-white text-[10px] font-bold">
                Shorts 4K
              </span>
              <span className="px-2 py-1 rounded-lg bg-pink-600 text-white text-[10px] font-bold">
                Reels
              </span>
            </div>
          </div>

          {/* Card 4 - Cross-channel Analytics */}
          <div className="p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl relative overflow-hidden flex flex-col justify-between group hover:border-brand-400 dark:hover:border-brand-500/50 transition-all duration-300">
            <div className="space-y-4 z-10">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center shadow-lg shadow-indigo-500/25">
                <BarChart3 className="w-5 h-5" />
              </div>

              <div className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/50">
                {t.features.card4Badge}
              </div>

              <h3 className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-white tracking-tight">
                {t.features.card4Title}
              </h3>

              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                {t.features.card4Desc}
              </p>
            </div>

            <div className="mt-6 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-500 text-[11px]">Impressions Growth</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold font-mono">
                +248.5%
              </span>
            </div>
          </div>

          {/* Card 5 - Agency & Workspaces */}
          <div className="p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl relative overflow-hidden flex flex-col justify-between group hover:border-brand-400 dark:hover:border-brand-500/50 transition-all duration-300">
            <div className="space-y-4 z-10">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white flex items-center justify-center shadow-lg shadow-amber-500/25">
                <Users2 className="w-5 h-5" />
              </div>

              <div className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50">
                {t.features.card5Badge}
              </div>

              <h3 className="text-lg sm:text-xl font-bold text-zinc-900 dark:text-white tracking-tight">
                {t.features.card5Title}
              </h3>

              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                {t.features.card5Desc}
              </p>
            </div>

            <div className="mt-6 flex items-center gap-2">
              <span className="px-2 py-1 rounded-lg bg-brand-50 dark:bg-brand-950 text-brand-600 text-[10px] font-semibold border border-brand-200 dark:border-brand-800">
                Admin
              </span>
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-[10px] font-semibold">
                Editor
              </span>
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-[10px] font-semibold">
                Client Reviewer
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
