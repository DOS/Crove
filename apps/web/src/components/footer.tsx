'use client';

import React from 'react';
import Link from 'next/link';
import { CroveLogo } from './crove-logo';
import { ThemeToggle } from './theme/theme-toggle';
import { LanguageToggle } from './language-toggle';
import { useI18n } from '../i18n/i18n-context';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://post.crove.com';

export function Footer() {
  const { t } = useI18n();

  return (
    <footer className="border-t border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-[#07070d]/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8 sm:gap-10">
          {/* Col 1 & 2: Brand info */}
          <div className="lg:col-span-2 space-y-4">
            <Link href="/" className="inline-block">
              <CroveLogo size={34} />
            </Link>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm leading-relaxed">
              {t.footer.desc}
            </p>

            <div className="pt-1 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[11px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {t.footer.uptime}
              </span>
            </div>

            <div className="pt-2 flex items-center gap-2">
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </div>

          {/* Col 3: Product */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
              {t.footer.productTitle}
            </h4>
            <ul className="space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
              <li>
                <Link href="#features" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.featLink}
                </Link>
              </li>
              <li>
                <Link href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.channelsLink}
                </Link>
              </li>
              <li>
                <Link href="#preview" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.previewLink}
                </Link>
              </li>
              <li>
                <Link href="#pricing" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.pricingLink}
                </Link>
              </li>
              <li>
                <Link href="#comparison" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.compareLink}
                </Link>
              </li>
            </ul>
          </div>

          {/* Col 4: Supported Platforms */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
              {t.footer.platformsTitle}
            </h4>
            <ul className="space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
              <li>
                <a href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  TikTok & YouTube Shorts
                </a>
              </li>
              <li>
                <a href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  Facebook & Instagram Reels
                </a>
              </li>
              <li>
                <a href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  LinkedIn & X (Twitter)
                </a>
              </li>
              <li>
                <a href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  Discord & Telegram Channels
                </a>
              </li>
              <li>
                <a href="#channels" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  Reddit & Webhooks API
                </a>
              </li>
            </ul>
          </div>

          {/* Col 5: Account & Legal */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
              {t.footer.accountTitle}
            </h4>
            <ul className="space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
              <li>
                <a href={`${APP_URL}/auth/login`} className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.loginLink}
                </a>
              </li>
              <li>
                <a href={`${APP_URL}/auth/login`} className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.registerLink}
                </a>
              </li>
              <li>
                <a href="/privacy" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.privacyLink}
                </a>
              </li>
              <li>
                <a href="/terms" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                  {t.footer.termsLink}
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="mt-10 pt-6 border-t border-zinc-200 dark:border-zinc-800/80 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <div>
            © {new Date().getFullYear()} Crove. {t.footer.rights}
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <span>{t.footer.builtWith}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
