import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '../components/theme/theme-provider';
import { I18nProvider } from '../i18n/i18n-context';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Crove — All-in-One Social Media Scheduling & Automation Platform',
  description:
    'Lên lịch và tự động phân phối bài viết đa nền tảng (Facebook, X, TikTok, YouTube, LinkedIn, Instagram và 28+ kênh khác) với trợ lý AI thông minh.',
  keywords: [
    'social media scheduler',
    'crove',
    'post scheduler',
    'tiktok automation',
    'multi-channel publishing',
    'tự động đăng bài',
    'quản lý mạng xã hội',
  ],
  authors: [{ name: 'Crove Team' }],
  openGraph: {
    title: 'Crove — All-in-One Social Media Scheduling Platform',
    description:
      'Schedule, automate, and analyze posts across 28+ channels in seconds with AI.',
    type: 'website',
    url: 'https://crove.com',
  },
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" suppressHydrationWarning className={plusJakartaSans.variable}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('crove-ui-theme') || 'dark';
                  if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                    document.documentElement.classList.add('dark');
                    document.documentElement.style.colorScheme = 'dark';
                  } else {
                    document.documentElement.classList.remove('dark');
                    document.documentElement.style.colorScheme = 'light';
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        suppressHydrationWarning
        className="min-h-screen font-sans antialiased selection:bg-brand-500/25 selection:text-brand-700 dark:selection:text-brand-300"
      >
        <ThemeProvider defaultTheme="dark">
          <I18nProvider defaultLang="vi">
            {children}
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
