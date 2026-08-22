'use client';

import React, { useState } from 'react';
import { useI18n } from '../i18n/i18n-context';
import {
  Share2,
  Video,
  FileText,
  Users,
  Code2,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';

interface Channel {
  name: string;
  category: 'video' | 'social' | 'professional' | 'community' | 'web3';
  badge?: string;
  descriptionVi: string;
  descriptionEn: string;
  color: string;
}

const CHANNELS: Channel[] = [
  // Video & Visuals
  { name: 'TikTok', category: 'video', badge: 'Direct Video', descriptionVi: 'Đăng video & Shorts 9:16 tự động kèm hashtags tối ưu', descriptionEn: 'Auto-publish 9:16 vertical video & trending hashtags', color: 'from-zinc-900 to-zinc-700' },
  { name: 'YouTube Shorts', category: 'video', badge: 'Full 4K', descriptionVi: 'Tải lên Shorts & Video dài với thumbnail tùy chỉnh', descriptionEn: 'Upload Shorts & Long-form 4K videos with custom thumbnails', color: 'from-red-600 to-rose-700' },
  { name: 'Instagram', category: 'video', badge: 'Reels & Carousel', descriptionVi: 'Đăng Reels, ảnh đơn, Carousel và story trực tiếp', descriptionEn: 'Directly schedule Reels, Carousels, Stories, and posts', color: 'from-pink-600 via-purple-600 to-amber-500' },
  { name: 'Facebook', category: 'video', badge: 'Pages & Groups', descriptionVi: 'Hỗ trợ Fanpage doanh nghiệp, Group cộng đồng và Reels', descriptionEn: 'Full support for Pages, Groups, and Facebook Reels', color: 'from-blue-600 to-indigo-700' },
  { name: 'Pinterest', category: 'video', badge: 'Pins & Boards', descriptionVi: 'Tự động tạo Pin, ghim vào bảng mục tiêu kèm backlink', descriptionEn: 'Auto-create Pins to designated boards with backlinks', color: 'from-red-700 to-rose-800' },
  { name: 'Dribbble', category: 'video', badge: 'Design Shots', descriptionVi: 'Chia sẻ portfolio và shot thiết kế cho designers', descriptionEn: 'Publish design shots and portfolio updates', color: 'from-pink-500 to-rose-600' },

  // Social & Microblog
  { name: 'X (Twitter)', category: 'social', badge: 'Auto Thread', descriptionVi: 'Tự động chia nhỏ bài viết thành Twitter Threads mượt mà', descriptionEn: 'Automatically split long thoughts into seamless Twitter threads', color: 'from-zinc-900 to-black' },
  { name: 'Threads', category: 'social', badge: 'Meta Ecosystem', descriptionVi: 'Đồng bộ bài viết sang Instagram Threads tức thì', descriptionEn: 'Instant cross-posting to Meta Instagram Threads', color: 'from-zinc-800 to-zinc-950' },
  { name: 'Bluesky', category: 'social', badge: 'Decentralized', descriptionVi: 'Phân phối tới mạng xã hội phi tập trung AT Protocol', descriptionEn: 'Publish to the next-gen decentralized AT Protocol network', color: 'from-sky-500 to-blue-600' },
  { name: 'Mastodon', category: 'social', badge: 'Fediverse', descriptionVi: 'Hỗ trợ kết nối custom instance trên Fediverse', descriptionEn: 'Connect to any custom Fediverse Mastodon instance', color: 'from-indigo-600 to-purple-700' },
  { name: 'Farcaster', category: 'social', badge: 'Web3 Social', descriptionVi: 'Đăng Cast trực tiếp lên giao thức Web3 Farcaster', descriptionEn: 'Direct cast publishing to decentralized Farcaster protocol', color: 'from-purple-700 to-violet-900' },
  { name: 'MeWe', category: 'social', descriptionVi: 'Đăng bài lên mạng xã hội bảo mật quyền riêng tư', descriptionEn: 'Share updates on privacy-first community social network', color: 'from-amber-600 to-orange-700' },
  { name: 'VKontakte (VK)', category: 'social', descriptionVi: 'Kết nối và phát triển cộng đồng người dùng Đông Âu', descriptionEn: 'Expand reach across Eastern European social ecosystem', color: 'from-blue-700 to-blue-900' },

  // Professional & Articles
  { name: 'LinkedIn Personal', category: 'professional', badge: 'B2B Lead', descriptionVi: 'Xây dựng thương hiệu cá nhân với bài viết & PDF carousel', descriptionEn: 'Build personal brand with thought-leadership posts & PDF carousels', color: 'from-blue-700 to-cyan-800' },
  { name: 'LinkedIn Company', category: 'professional', badge: 'Organization', descriptionVi: 'Quản lý bài đăng doanh nghiệp nhiều chi nhánh', descriptionEn: 'Manage official organization company page broadcasts', color: 'from-blue-800 to-indigo-900' },
  { name: 'Medium', category: 'professional', badge: 'Canonical URL', descriptionVi: 'Xuất bản bài viết dài, giữ nguyên SEO canonical link', descriptionEn: 'Publish long-form stories with SEO canonical URL preservation', color: 'from-zinc-900 to-zinc-700' },
  { name: 'Hashnode', category: 'professional', badge: 'Dev Blogs', descriptionVi: 'Tự động đồng bộ bài viết kỹ thuật lên blog cá nhân', descriptionEn: 'Sync technical markdown blogs to your custom developer domain', color: 'from-blue-600 to-sky-700' },
  { name: 'Dev.to', category: 'professional', badge: 'Developer SEO', descriptionVi: 'Chia sẻ kiến thức lập trình tới cộng đồng developer', descriptionEn: 'Broadcast developer articles to global programming audience', color: 'from-zinc-800 to-black' },
  { name: 'WordPress', category: 'professional', badge: 'REST API', descriptionVi: 'Tự động tạo bản nháp hoặc xuất bản bài viết WordPress', descriptionEn: 'Draft or publish full posts to WordPress via REST API', color: 'from-sky-700 to-blue-900' },

  // Community & Messaging
  { name: 'Reddit', category: 'community', badge: 'Subreddits', descriptionVi: 'Tự động chọn Subreddit và gắn Flair chuẩn quy tắc', descriptionEn: 'Post to target subreddits with rules & automated flairs', color: 'from-orange-600 to-red-600' },
  { name: 'Discord', category: 'community', badge: 'Webhooks & Bot', descriptionVi: 'Bắn thông báo bài viết mới vào từng Channel Discord', descriptionEn: 'Broadcast post alerts into designated Discord community channels', color: 'from-indigo-600 to-violet-800' },
  { name: 'Telegram', category: 'community', badge: 'Channels & Groups', descriptionVi: 'Gửi tin nhắn định dạng Markdown và hình ảnh tới channel', descriptionEn: 'Push formatted markdown announcements to channels & groups', color: 'from-sky-500 to-blue-600' },
  { name: 'Slack', category: 'community', badge: 'Workspace', descriptionVi: 'Thông báo tới các kênh làm việc nội bộ công ty', descriptionEn: 'Notify internal team workspace channels automatically', color: 'from-emerald-600 to-teal-800' },
  { name: 'Skool', category: 'community', badge: 'Courses', descriptionVi: 'Đăng bài thông báo tới các nhóm học viên Skool', descriptionEn: 'Deliver announcements to student community groups on Skool', color: 'from-amber-500 to-yellow-600' },
  { name: 'Whop', category: 'community', badge: 'Creator Hub', descriptionVi: 'Kết nối sản phẩm số và cộng đồng thành viên Whop', descriptionEn: 'Connect digital products and premium member discussions', color: 'from-orange-500 to-rose-600' },
  { name: 'Listmonk', category: 'community', badge: 'Newsletter', descriptionVi: 'Tự động gửi bản tin qua email marketing self-hosted', descriptionEn: 'Dispatch newsletter campaigns via self-hosted Listmonk', color: 'from-purple-600 to-indigo-700' },

  // Web3 & Custom
  { name: 'Moltbook', category: 'web3', badge: 'Web3', descriptionVi: 'Tích hợp mạng xã hội phi tập trung', descriptionEn: 'Decentralized social integration for Web3 communities', color: 'from-brand-600 to-purple-800' },
  { name: 'Wrapcaster', category: 'web3', badge: 'Warpcast', descriptionVi: 'Hỗ trợ Warpcast Frame và post', descriptionEn: 'Native Warpcast Frames and interactive casts', color: 'from-purple-600 to-indigo-900' },
  { name: 'Custom Webhooks', category: 'web3', badge: 'REST API', descriptionVi: 'Gửi payload JSON tới bất kỳ hệ thống nào bạn muốn', descriptionEn: 'Trigger custom HTTP JSON payloads to any server endpoint', color: 'from-zinc-700 to-zinc-900' },
];

export function Channels() {
  const { t, lang } = useI18n();
  const [activeTab, setActiveTab] = useState<string>('all');

  const categories = [
    { id: 'all', label: t.channels.tabAll },
    { id: 'video', label: t.channels.tabVideo, icon: Video },
    { id: 'social', label: t.channels.tabSocial, icon: Share2 },
    { id: 'professional', label: t.channels.tabProfessional, icon: FileText },
    { id: 'community', label: t.channels.tabCommunity, icon: Users },
    { id: 'web3', label: t.channels.tabWeb3, icon: Code2 },
  ];

  const filteredChannels =
    activeTab === 'all'
      ? CHANNELS
      : CHANNELS.filter((c) => c.category === activeTab);

  return (
    <section id="channels" className="py-20 sm:py-28 relative overflow-hidden">
      {/* Glow background */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[650px] h-[450px] bg-brand-500/10 blur-[130px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-950/40 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <Share2 className="w-3.5 h-3.5 text-brand-500" />
            <span>{t.channels.pill}</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {t.channels.titleStart}
            <span className="text-gradient-purple">{t.channels.titleGradient}</span>
            {t.channels.titleEnd}
          </h2>

          <p className="text-zinc-600 dark:text-zinc-300 text-sm sm:text-base">
            {t.channels.subtitle}
          </p>
        </div>

        {/* Category Tabs */}
        <div className="mt-8 flex items-center justify-center flex-wrap gap-2">
          {categories.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeTab === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveTab(cat.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all duration-200 flex items-center gap-1.5 ${
                  isActive
                    ? 'bg-brand-600 text-white shadow-md shadow-brand-500/25 scale-[1.02]'
                    : 'bg-white/80 dark:bg-zinc-900/80 border border-zinc-200/90 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:border-brand-300 dark:hover:border-brand-500/40'
                }`}
              >
                {Icon && <Icon className="w-3.5 h-3.5" />}
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Channel Grid */}
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {filteredChannels.map((channel, idx) => (
            <div
              key={idx}
              className="p-4 rounded-2xl border border-zinc-200/90 dark:border-zinc-800/80 bg-white/70 dark:bg-[#0f0f1c]/70 backdrop-blur-xl hover:border-brand-400 dark:hover:border-brand-500/50 hover:shadow-lg hover:shadow-brand-500/10 transition-all duration-200 group flex flex-col justify-between"
            >
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-7 h-7 rounded-lg bg-gradient-to-br ${channel.color} text-white flex items-center justify-center font-bold text-xs shadow-sm`}
                    >
                      {channel.name.slice(0, 2)}
                    </div>
                    <span className="font-bold text-sm text-zinc-900 dark:text-white group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                      {channel.name}
                    </span>
                  </div>

                  {channel.badge && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400 border border-brand-200/60 dark:border-brand-800/50">
                      {channel.badge}
                    </span>
                  )}
                </div>

                <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  {lang === 'vi' ? channel.descriptionVi : channel.descriptionEn}
                </p>
              </div>

              <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between text-[11px] text-zinc-400 font-medium">
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-3 h-3" />
                  {t.channels.directBadge}
                </span>
                <span className="capitalize text-zinc-400">{channel.category}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
