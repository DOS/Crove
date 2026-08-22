import React from 'react';

export function CroveLogo({
  className = '',
  size = 36,
  showText = true,
}: {
  className?: string;
  size?: number;
  showText?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      <div
        className="relative flex items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-md shadow-brand-500/30 overflow-hidden flex-shrink-0 transition-transform duration-200 group-hover:scale-105"
        style={{ width: size, height: size }}
      >
        <svg
          viewBox="0 0 144 144"
          className="w-full h-full p-1"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M141.5 33.7c-4-1.1-7.5-2.4-11.1-3.2-6-1.3-9.4-4.8-10.7-10.7-0.8-3.4-1.9-6.7-2.9-10.1 0-0.2-0.2-0.3-0.3-0.7-1.2 4.1-2.4 8-3.6 11.9-0.3 1-0.7 2.1-1.1 3.1-0.9 2.3-2.5 4.1-4.9 4.9-4.3 1.4-8.7 2.7-13.1 4.1-0.6 0.2-1.3 0.4-2.3 0.7 3.7 1.1 7 2 10.4 3 1.5 0.4 3 0.9 4.4 1.4 2.9 1 4.8 2.9 5.8 5.8 1.5 4.7 2.9 9.4 4.4 14.2 0.1-0.3 0.3-0.6 0.4-0.9 1.3-4.3 2.6-8.6 3.9-12.9 1-3.4 3.3-5.6 6.7-6.6 4.3-1.1 8.8-2.5 13.8-4z"
            fill="#FFFFFF"
          />
          <path
            d="M98.1 4c-0.7 2.2-1.3 4-1.7 5.8-0.6 2.3-2 3.6-4.2 4.1-1.8 0.5-3.7 1.1-5.9 1.7 2.3 0.7 4.2 1.3 6.2 1.8 2.1 0.6 3.3 1.8 3.9 3.9 0.5 1.9 1.1 3.7 1.8 5.9 0.6-2.1 1.2-3.7 1.6-5.4 0.6-2.4 2-4 4.5-4.6 1.8-0.4 3.5-1 5.7-1.6-1.2-0.4-2-0.6-2.8-0.9-6.6-1.9-6.2-1.6-8.1-7.9C98.7 6.1 98.4 5.3 98.1 4z"
            fill="#FFFFFF"
          />
          <path
            d="M56.4 33.7C26.9 33.7 3 57.6 3 87.2c0 23 14.7 43.4 36.6 50.7 2.7 0.5 3.7-1.1 3.7-2.5 0-0.8 0.1-8.4 0.1-15.5 0-4.4 0.8-7 2.8-8.6-10.3-4.1-17.6-14.2-17.6-25.9 0-15.4 12.5-27.9 27.9-27.9 15.4 0 27.9 12.5 27.9 27.9 0 11.8-7.3 21.8-17.6 25.9 1.4 1.3 3.3 3.3 3.1 9.4-0.3 7.1-0.1 12.9-0.1 14.7 0 1.4 1 3.1 3.7 2.5 21.8-7.3 36.4-27.8 36.4-50.7C109.9 57.6 86 33.7 56.4 33.7z"
            fill="#FFFFFF"
          />
        </svg>
      </div>
      {showText && (
        <span className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-1.5">
          Crove
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-brand-100 dark:bg-brand-950/80 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800/50">
            SaaS
          </span>
        </span>
      )}
    </div>
  );
}
