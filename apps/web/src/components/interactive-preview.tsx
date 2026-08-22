'use client';

import React, { useState } from 'react';
import { useI18n } from '../i18n/i18n-context';
import {
  Sparkles,
  Check,
  Copy,
  Clock,
  RotateCcw,
  Share2,
  ThumbsUp,
  MessageCircle,
  Repeat,
  Bookmark,
  Heart,
  Send,
} from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

type Platform = 'tiktok' | 'linkedin' | 'facebook' | 'x';

export function InteractivePreview() {
  const { t, lang } = useI18n();

  const presetTemplates = [
    {
      title: t.preview.tmpl1Title,
      content: t.preview.tmpl1Content,
      tags: ['#ProductLaunch', '#AI', '#MarketingAutomation', '#SaaS', '#Growth'],
    },
    {
      title: t.preview.tmpl2Title,
      content: t.preview.tmpl2Content,
      tags: ['#ContentTips', '#SocialMediaGrowth', '#CreatorHacks'],
    },
    {
      title: t.preview.tmpl3Title,
      content: t.preview.tmpl3Content,
      tags: ['#FlashSale', '#SpecialOffer', '#LimitedDeal'],
    },
  ];

  const [selectedTemplateIndex, setSelectedTemplateIndex] = useState(0);
  const [customText, setCustomText] = useState(presetTemplates[0].content);
  const [activePlatform, setActivePlatform] = useState<Platform>('tiktok');
  const [isCopied, setIsCopied] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);

  const handleTemplateChange = (idx: number) => {
    setSelectedTemplateIndex(idx);
    setCustomText(presetTemplates[idx].content);
  };

  const handleAIRefine = () => {
    setIsAIProcessing(true);
    setTimeout(() => {
      const extra =
        lang === 'vi'
          ? '✨ [AI Tối Ưu] Hook 3s cực cuốn & tối ưu hashtag xu hướng:\n\n'
          : '✨ [AI Optimized] High-converting 3s hook & trending hashtags:\n\n';
      setCustomText((prev) => `${extra}${prev}\n\n👉 Link in bio to learn more & get started free!`);
      setIsAIProcessing(false);
    }, 500);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(customText);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <section id="preview" className="py-20 sm:py-28 relative overflow-hidden bg-zinc-50/40 dark:bg-zinc-950/30 border-y border-zinc-200/80 dark:border-zinc-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Sparkles className="w-3.5 h-3.5 text-brand-500" />
            <span>{t.preview.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.preview.titleStart}
            <span className="text-gradient-purple">{t.preview.titleGradient}</span>
            {t.preview.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.preview.subtitle}
          </p>
        </div>

        {/* Interactive Workspace Box */}
        <div className="mt-12 max-w-5xl mx-auto rounded-3xl border border-zinc-200/90 dark:border-zinc-800/90 bg-white dark:bg-[#0c0c16] backdrop-blur-xl shadow-2xl overflow-hidden">
          {/* Top selection bar */}
          <div className="p-3.5 sm:p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                {t.preview.templatesLabel}
              </span>
              {presetTemplates.map((tmpl, idx) => (
                <button
                  key={idx}
                  onClick={() => handleTemplateChange(idx)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedTemplateIndex === idx
                      ? 'bg-brand-600 text-white shadow-sm font-bold'
                      : 'bg-white dark:bg-zinc-800/80 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                  }`}
                >
                  {tmpl.title}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleAIRefine}
                disabled={isAIProcessing}
                className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-brand-600 hover:from-purple-500 hover:to-brand-500 text-white text-xs font-bold shadow-sm flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isAIProcessing ? t.preview.aiPolishing : t.preview.aiPolishBtn}</span>
              </button>

              <button
                onClick={handleCopy}
                className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-brand-600 transition-colors"
                title={t.preview.copyBtn}
              >
                {isCopied ? (
                  <Check className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Main workspace layout */}
          <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[380px]">
            {/* Editor Area (Left 6 cols) */}
            <div className="lg:col-span-6 p-4 sm:p-6 border-b lg:border-b-0 lg:border-r border-zinc-200 dark:border-zinc-800 flex flex-col justify-between space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                    Crove Composer
                  </span>
                  <span>
                    {customText.length} {t.preview.characters}
                  </span>
                </div>

                <textarea
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder={t.preview.placeholder}
                  className="w-full h-44 sm:h-52 p-3.5 rounded-2xl bg-zinc-50/70 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-xs sm:text-sm text-zinc-900 dark:text-white resize-none outline-none transition-all leading-relaxed"
                />
              </div>

              {/* Bottom direct publish trigger */}
              <div className="pt-2 flex items-center justify-between">
                <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-brand-500" />
                  {t.preview.directPublishBadge}
                </span>

                <a
                  href={`${APP_URL}/auth/login`}
                  className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-md shadow-brand-500/20 flex items-center gap-1.5 transition-all"
                >
                  <span>{t.preview.scheduleNow}</span>
                  <Send className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* Live Social Preview Area (Right 6 cols) */}
            <div className="lg:col-span-6 p-4 sm:p-6 bg-zinc-50/30 dark:bg-zinc-950/40 flex flex-col justify-between space-y-4">
              {/* Platform Switcher Tabs */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
                  {t.preview.previewOf}
                </span>

                <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-900 p-1 rounded-xl">
                  {[
                    { id: 'tiktok' as Platform, label: 'TikTok' },
                    { id: 'linkedin' as Platform, label: 'LinkedIn' },
                    { id: 'facebook' as Platform, label: 'Facebook' },
                    { id: 'x' as Platform, label: 'X' },
                  ].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setActivePlatform(p.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                        activePlatform === p.id
                          ? 'bg-white dark:bg-zinc-800 text-brand-600 dark:text-brand-400 shadow-sm font-bold'
                          : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Render simulated mockup for activePlatform */}
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#121220] p-4 sm:p-5 shadow-lg space-y-3">
                {/* Author row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-brand-600 to-purple-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
                      CR
                    </div>
                    <div>
                      <div className="font-bold text-xs sm:text-sm text-zinc-900 dark:text-white flex items-center gap-1.5">
                        Crove Studio
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      </div>
                      <div className="text-[10px] text-zinc-400">@croveapp • Just now</div>
                    </div>
                  </div>

                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400">
                    {activePlatform}
                  </span>
                </div>

                {/* Content body */}
                <p className="text-xs sm:text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed whitespace-pre-line line-clamp-5">
                  {customText || t.preview.placeholder}
                </p>

                {/* Social interactive footer */}
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
                  {activePlatform === 'tiktok' && (
                    <>
                      <span className="flex items-center gap-1">
                        <Heart className="w-3.5 h-3.5 text-rose-500" /> 14.8K
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle className="w-3.5 h-3.5 text-zinc-400" /> 842
                      </span>
                      <span className="flex items-center gap-1">
                        <Bookmark className="w-3.5 h-3.5 text-amber-500" /> 3.2K
                      </span>
                      <span className="flex items-center gap-1">
                        <Share2 className="w-3.5 h-3.5 text-sky-500" /> Share
                      </span>
                    </>
                  )}
                  {activePlatform === 'linkedin' && (
                    <>
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="w-3.5 h-3.5 text-blue-500" /> 420 Like
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle className="w-3.5 h-3.5 text-zinc-400" /> 68 Comment
                      </span>
                      <span className="flex items-center gap-1">
                        <Repeat className="w-3.5 h-3.5 text-emerald-500" /> 34 Repost
                      </span>
                    </>
                  )}
                  {activePlatform === 'facebook' && (
                    <>
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="w-3.5 h-3.5 text-blue-600" /> 1.2K
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle className="w-3.5 h-3.5 text-zinc-400" /> 154
                      </span>
                      <span className="flex items-center gap-1">
                        <Share2 className="w-3.5 h-3.5 text-zinc-400" /> 89 Shares
                      </span>
                    </>
                  )}
                  {activePlatform === 'x' && (
                    <>
                      <span className="flex items-center gap-1">
                        <Repeat className="w-3.5 h-3.5 text-emerald-500" /> 521 Retweet
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart className="w-3.5 h-3.5 text-rose-500" /> 2.4K Like
                      </span>
                      <span className="flex items-center gap-1">
                        <Bookmark className="w-3.5 h-3.5 text-sky-500" /> 890
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="text-center text-[11px] text-zinc-400">
                ✨ Ready to schedule across all 28+ channels at once
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
