'use client';

import React from 'react';
import { useI18n } from '../i18n/i18n-context';
import { Check, X, Sparkles, Scale, Layers } from 'lucide-react';

export function Comparison() {
  const { t } = useI18n();

  const comparisonRows = [
    {
      feature: t.comparison.row1Feature,
      crove: t.comparison.row1Crove,
      silo: t.comparison.row1Silo,
      buffer: t.comparison.row1Buffer,
      hootsuite: t.comparison.row1Hootsuite,
    },
    {
      feature: t.comparison.row2Feature,
      crove: true,
      silo: false,
      buffer: true,
      hootsuite: true,
    },
    {
      feature: t.comparison.row3Feature,
      crove: t.comparison.row3Crove,
      silo: t.comparison.row3Silo,
      buffer: t.comparison.row3Buffer,
      hootsuite: t.comparison.row3Hootsuite,
    },
    {
      feature: t.comparison.row4Feature,
      crove: true,
      silo: false,
      buffer: false,
      hootsuite: false,
    },
    {
      feature: t.comparison.row5Feature,
      crove: true,
      silo: false,
      buffer: false,
      hootsuite: false,
    },
    {
      feature: t.comparison.row6Feature,
      crove: true,
      silo: false,
      buffer: false,
      hootsuite: false,
    },
    {
      feature: t.comparison.row7Feature,
      crove: true,
      silo: false,
      buffer: false,
      hootsuite: false,
    },
    {
      feature: t.comparison.row8Feature,
      crove: t.comparison.row8Crove,
      silo: t.comparison.row8Silo,
      buffer: t.comparison.row8Buffer,
      hootsuite: t.comparison.row8Hootsuite,
    },
  ];

  return (
    <section id="comparison" className="py-20 sm:py-28 relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Scale className="w-3.5 h-3.5 text-brand-500" />
            <span>{t.comparison.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.comparison.titleStart}
            <span className="text-gradient-purple">{t.comparison.titleGradient}</span>
            {t.comparison.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.comparison.subtitle}
          </p>
        </div>

        {/* Comparison Table */}
        <div className="mt-12 overflow-x-auto rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0f0f1c] shadow-xl backdrop-blur-xl">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/80">
                <th className="p-4 sm:p-5 text-xs sm:text-sm font-bold text-zinc-700 dark:text-zinc-300 w-1/3">
                  {t.comparison.featureHeader}
                </th>
                <th className="p-4 sm:p-5 text-xs sm:text-sm font-extrabold text-brand-600 dark:text-brand-400 bg-brand-50/60 dark:bg-brand-950/40 w-1/3 border-x border-brand-200/50 dark:border-brand-800/50">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-brand-500" />
                    <span>{t.comparison.croveCol}</span>
                  </div>
                </th>
                <th className="p-4 sm:p-5 text-xs sm:text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                  {t.comparison.siloCol}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80 text-xs sm:text-sm">
              {comparisonRows.map((row, idx) => {
                const isLast = idx === comparisonRows.length - 1;
                return (
                  <tr
                    key={idx}
                    className={`hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors ${
                      isLast ? 'bg-brand-50/20 dark:bg-brand-950/20 font-bold' : ''
                    }`}
                  >
                    <td className="p-4 sm:p-5 font-semibold text-zinc-800 dark:text-zinc-200">
                      {row.feature}
                    </td>

                    {/* Crove OS Column */}
                    <td className="p-4 sm:p-5 font-bold text-brand-700 dark:text-brand-300 bg-brand-50/30 dark:bg-brand-950/20 border-x border-brand-200/40 dark:border-brand-800/40">
                      {typeof row.crove === 'boolean' ? (
                        row.crove ? (
                          <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                            <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center">
                              <Check className="w-3.5 h-3.5 stroke-[3]" />
                            </div>
                            <span className="text-xs font-semibold">Tích hợp sẵn</span>
                          </div>
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center">
                            <X className="w-3.5 h-3.5 stroke-[2.5]" />
                          </div>
                        )
                      ) : (
                        <span className="text-brand-600 dark:text-brand-400">
                          {row.crove}
                        </span>
                      )}
                    </td>

                    {/* Siloed Subscriptions Column */}
                    <td className="p-4 sm:p-5 text-zinc-500 dark:text-zinc-400">
                      {typeof row.silo === 'boolean' ? (
                        row.silo ? (
                          <div className="w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-zinc-400">
                            <div className="w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 flex items-center justify-center">
                              <X className="w-3.5 h-3.5 stroke-[2.5]" />
                            </div>
                            <span className="text-xs">Phải mua thêm gói riêng</span>
                          </div>
                        )
                      ) : (
                        <span>{row.silo}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
