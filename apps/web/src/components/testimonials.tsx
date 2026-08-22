'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import { Star } from 'lucide-react';

export function Testimonials() {
  const { t } = useI18n();

  const testimonials = [
    {
      name: t.testimonials.t1Name,
      role: t.testimonials.t1Role,
      avatar: 'HN',
      content: t.testimonials.t1Content,
      rating: 5,
      channels: t.testimonials.t1Channels,
    },
    {
      name: t.testimonials.t2Name,
      role: t.testimonials.t2Role,
      avatar: 'TL',
      content: t.testimonials.t2Content,
      rating: 5,
      channels: t.testimonials.t2Channels,
    },
    {
      name: t.testimonials.t3Name,
      role: t.testimonials.t3Role,
      avatar: 'HL',
      content: t.testimonials.t3Content,
      rating: 5,
      channels: t.testimonials.t3Channels,
    },
  ];

  return (
    <section className="py-20 sm:py-28 relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            <span>{t.testimonials.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.testimonials.titleStart}
            <span className="text-gradient-purple">{t.testimonials.titleGradient}</span>
            {t.testimonials.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.testimonials.subtitle}
          </p>
        </div>

        {/* Testimonial Cards */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          {testimonials.map((item, idx) => (
            <div
              key={idx}
              className="p-6 sm:p-8 rounded-3xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl shadow-md hover:border-brand-400 dark:hover:border-brand-500/50 hover:shadow-xl hover:shadow-brand-500/10 transition-all duration-300 flex flex-col justify-between"
            >
              <div className="space-y-4">
                {/* Rating stars */}
                <div className="flex items-center gap-1">
                  {[...Array(item.rating)].map((_, i) => (
                    <Star key={i} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  ))}
                </div>

                <p className="text-xs sm:text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed italic">
                  "{item.content}"
                </p>
              </div>

              {/* Author Row */}
              <div className="mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-brand-600 to-purple-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
                    {item.avatar}
                  </div>
                  <div>
                    <div className="font-bold text-xs sm:text-sm text-zinc-900 dark:text-white">
                      {item.name}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      {item.role}
                    </div>
                  </div>
                </div>

                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400 border border-brand-200/50 dark:border-brand-800/50">
                  {item.channels}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
