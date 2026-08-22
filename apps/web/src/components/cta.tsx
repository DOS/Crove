'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import { ArrowRight, Sparkles, ShieldCheck, Zap } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

export function CTA() {
  const { t } = useI18n();

  return (
    <section className="py-16 sm:py-24 relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-3xl overflow-hidden border border-brand-500/30 bg-gradient-to-br from-[#1a103c] via-[#0b0816] to-[#15092a] p-8 sm:p-14 lg:p-18 text-center shadow-2xl shadow-brand-500/20">
          {/* Ambient Lighting inside banner */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-brand-500/30 blur-[130px] rounded-full pointer-events-none -z-10" />
          <div className="absolute inset-0 bg-grid-pattern opacity-25 pointer-events-none" />

          <div className="max-w-3xl mx-auto space-y-5 relative z-10">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-400/40 bg-brand-500/20 text-xs font-semibold text-brand-200 backdrop-blur-md">
              <Sparkles className="w-3.5 h-3.5 text-brand-300" />
              <span>{t.cta.pill}</span>
            </div>

            <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
              {t.cta.titleStart}
              <span className="text-gradient-purple">{t.cta.titleGradient}</span>
              {t.cta.titleEnd}
            </h2>

            <p className="text-xs sm:text-sm text-zinc-300 max-w-xl mx-auto leading-relaxed">
              {t.cta.subtitle}
            </p>

            <div className="pt-3 flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href={`${APP_URL}/auth/login`}
                className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-white hover:bg-zinc-100 text-zinc-950 font-bold text-xs sm:text-sm shadow-xl shadow-white/10 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 group"
              >
                <span>{t.cta.startBtn}</span>
                <ArrowRight className="w-4 h-4 text-brand-600 transition-transform duration-200 group-hover:translate-x-0.5" />
              </a>

              <a
                href="#pricing"
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white font-semibold text-xs sm:text-sm backdrop-blur-md transition-all duration-200"
              >
                {t.cta.viewPricing}
              </a>
            </div>

            <div className="pt-2 flex items-center justify-center gap-5 text-[11px] text-zinc-400">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t.cta.trustCard}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>{t.cta.trustTime}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
