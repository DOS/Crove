'use client';

import React, { useState } from 'react';
import { useI18n } from '../i18n/i18n-context';
import { Check, Sparkles, Zap, ArrowRight } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

export function Pricing() {
  const { t, lang } = useI18n();
  const [isYearly, setIsYearly] = useState(true);

  const plans = [
    {
      name: t.pricing.starterName,
      description: t.pricing.starterDesc,
      price: t.pricing.starterPrice,
      period: t.pricing.starterPeriod,
      badge: t.pricing.starterBadge,
      ctaText: t.pricing.starterCta,
      highlighted: false,
      features:
        lang === 'vi'
          ? [
              'Kết nối tối đa 3 kênh mạng xã hội',
              'Lên lịch 30 bài viết / tháng',
              'Lịch kéo thả trực quan',
              'AI gợi ý caption cơ bản',
              'Lưu trữ media 500MB',
              'Cộng đồng hỗ trợ',
            ]
          : [
              'Connect up to 3 social accounts',
              'Schedule up to 30 posts / month',
              'Visual drag & drop calendar',
              'Basic AI caption suggestions',
              '500MB media storage',
              'Community support',
            ],
    },
    {
      name: t.pricing.proName,
      description: t.pricing.proDesc,
      price: isYearly ? t.pricing.proPriceYearly : t.pricing.proPriceMonthly,
      period: isYearly ? t.pricing.proPeriodYearly : t.pricing.proPeriodMonthly,
      badge: t.pricing.proBadge,
      ctaText: t.pricing.proCta,
      highlighted: true,
      features:
        lang === 'vi'
          ? [
              'Kết nối 15 kênh mạng xã hội',
              'Không giới hạn số lượng bài đăng',
              'Đăng trực tiếp TikTok, Shorts & Reels',
              'AI Content Copilot không giới hạn',
              'Tự động tạo Twitter Threads & Reddit',
              'Gợi ý khung giờ vàng (AI Best Time)',
              'Báo cáo Analytics & Tăng trưởng',
              'Lưu trữ media 50GB',
              'Hỗ trợ ưu tiên 24/7',
            ]
          : [
              'Connect up to 15 social accounts',
              'Unlimited scheduled posts',
              'Direct TikTok, Shorts & Reels publishing',
              'Unlimited AI Content Copilot',
              'Automated Twitter Threads & Reddit Flairs',
              'AI Best Time peak scheduling',
              'Cross-channel analytics & growth reports',
              '50GB media library storage',
              '24/7 priority support',
            ],
    },
    {
      name: t.pricing.agencyName,
      description: t.pricing.agencyDesc,
      price: isYearly ? t.pricing.agencyPriceYearly : t.pricing.agencyPriceMonthly,
      period: isYearly ? t.pricing.agencyPeriodYearly : t.pricing.agencyPeriodMonthly,
      badge: t.pricing.agencyBadge,
      ctaText: t.pricing.agencyCta,
      highlighted: false,
      features:
        lang === 'vi'
          ? [
              'Không giới hạn kênh mạng xã hội',
              'Không giới hạn số bài đăng & chiến dịch',
              'Không gian làm việc nhóm (10 Thành viên)',
              'Quy trình phê duyệt bài viết trước khi đăng',
              'Xuất báo cáo PDF nhãn trắng chuyên nghiệp',
              'Tích hợp Webhooks & REST API riêng',
              'Lưu trữ media 500GB',
              'Hỗ trợ 1-on-1 từ chuyên gia',
            ]
          : [
              'Unlimited social accounts',
              'Unlimited posts & campaigns',
              'Team workspaces (10 Member seats)',
              'Granular roles & client approval workflows',
              'White-label PDF analytics reporting',
              'Custom Webhooks & full REST API access',
              '500GB media library storage',
              'Dedicated 1-on-1 onboarding & support',
            ],
    },
  ];

  return (
    <section id="pricing" className="py-20 sm:py-28 relative overflow-hidden bg-zinc-50/40 dark:bg-zinc-950/30 border-y border-zinc-200/80 dark:border-zinc-800/80">
      {/* Background ambient light */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[650px] h-[450px] bg-brand-500/10 blur-[140px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Zap className="w-3.5 h-3.5 text-brand-500" />
            <span>{t.pricing.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.pricing.titleStart}
            <span className="text-gradient-purple">{t.pricing.titleGradient}</span>
            {t.pricing.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.pricing.subtitle}
          </p>

          {/* Billing Switcher */}
          <div className="pt-4 flex items-center justify-center gap-3">
            <span
              className={`text-xs sm:text-sm font-semibold transition-colors ${
                !isYearly ? 'text-zinc-900 dark:text-white' : 'text-zinc-400'
              }`}
            >
              {t.pricing.monthly}
            </span>

            <button
              onClick={() => setIsYearly(!isYearly)}
              aria-label="Toggle Billing Interval"
              className="w-13 h-7 rounded-full bg-zinc-200 dark:bg-zinc-800 p-1 relative transition-colors focus:outline-none"
            >
              <div
                className={`w-5 h-5 rounded-full bg-brand-600 shadow-md transition-transform duration-200 ${
                  isYearly ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>

            <div className="flex items-center gap-1.5">
              <span
                className={`text-xs sm:text-sm font-semibold transition-colors ${
                  isYearly ? 'text-zinc-900 dark:text-white' : 'text-zinc-400'
                }`}
              >
                {t.pricing.yearly}
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40">
                {t.pricing.saveBadge}
              </span>
            </div>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8 items-stretch">
          {plans.map((plan, idx) => (
            <div
              key={idx}
              className={`relative rounded-3xl p-6 sm:p-8 flex flex-col justify-between transition-all duration-300 ${
                plan.highlighted
                  ? 'border-2 border-brand-500 bg-white dark:bg-[#101020] shadow-2xl shadow-brand-500/20 scale-[1.03] z-10'
                  : 'border border-zinc-200/90 dark:border-zinc-800/90 bg-white/80 dark:bg-[#0f0f1c]/80 backdrop-blur-xl hover:border-brand-300 dark:hover:border-brand-500/40 hover:shadow-xl'
              }`}
            >
              {/* Highlight badge */}
              {plan.highlighted && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-brand-600 to-purple-600 text-white text-xs font-extrabold shadow-md uppercase tracking-wider">
                  {plan.badge}
                </div>
              )}

              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-bold text-zinc-900 dark:text-white">
                      {plan.name}
                    </h3>
                    {!plan.highlighted && (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                        {plan.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 min-h-[32px]">
                    {plan.description}
                  </p>
                </div>

                {/* Price block */}
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl sm:text-4xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
                      {plan.price}
                    </span>
                    <span className="text-xs text-zinc-400 font-medium">
                      {plan.period}
                    </span>
                  </div>
                </div>

                {/* Feature List */}
                <div className="space-y-3 pt-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    Included:
                  </span>
                  <ul className="space-y-2.5 text-xs text-zinc-700 dark:text-zinc-300">
                    {plan.features.map((feat, fIdx) => (
                      <li key={fIdx} className="flex items-start gap-2.5">
                        <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Action Button */}
              <div className="pt-8 mt-auto">
                <a
                  href={`${APP_URL}/auth/login`}
                  className={`w-full py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${
                    plan.highlighted
                      ? 'bg-gradient-to-r from-brand-600 to-brand-700 hover:from-brand-500 hover:to-brand-600 text-white shadow-lg shadow-brand-500/25 hover:scale-[1.02] active:scale-[0.98]'
                      : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white border border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  <span>{plan.ctaText}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
