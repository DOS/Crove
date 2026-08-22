'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import { KeyRound, Wand2, Send, CheckCircle2 } from 'lucide-react';

export function HowItWorks() {
  const { t } = useI18n();

  const steps = [
    {
      step: t.howItWorks.step1Num,
      icon: KeyRound,
      title: t.howItWorks.step1Title,
      description: t.howItWorks.step1Desc,
      highlight: t.howItWorks.step1Highlight,
      gradient: 'from-brand-600 to-indigo-600',
    },
    {
      step: t.howItWorks.step2Num,
      icon: Wand2,
      title: t.howItWorks.step2Title,
      description: t.howItWorks.step2Desc,
      highlight: t.howItWorks.step2Highlight,
      gradient: 'from-purple-600 to-pink-600',
    },
    {
      step: t.howItWorks.step3Num,
      icon: Send,
      title: t.howItWorks.step3Title,
      description: t.howItWorks.step3Desc,
      highlight: t.howItWorks.step3Highlight,
      gradient: 'from-emerald-500 to-teal-600',
    },
  ];

  return (
    <section id="how-it-works" className="py-20 sm:py-28 relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span>{t.howItWorks.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.howItWorks.titleStart}
            <span className="text-gradient-purple">{t.howItWorks.titleGradient}</span>
            {t.howItWorks.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.howItWorks.subtitle}
          </p>
        </div>

        {/* Steps Grid */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 relative">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <div
                key={idx}
                className="relative p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl hover:border-brand-400 dark:hover:border-brand-500/50 hover:shadow-xl hover:shadow-brand-500/10 transition-all duration-300 group flex flex-col justify-between"
              >
                {/* Top step badge & icon */}
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-extrabold font-mono text-zinc-300 dark:text-zinc-700 group-hover:text-brand-500 transition-colors">
                      {step.step}
                    </span>
                    <div
                      className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${step.gradient} flex items-center justify-center text-white shadow-md shadow-brand-500/20 group-hover:scale-105 transition-transform duration-300`}
                    >
                      <Icon className="w-6 h-6" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
                      {step.title}
                    </h3>
                    <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </div>

                {/* Bottom Highlight */}
                <div className="mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800/80">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 dark:text-brand-400">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    {step.highlight}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
