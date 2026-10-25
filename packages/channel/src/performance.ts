// What a Google Business Profile location brought each day (#1477), as the Business Profile Performance API gives it:
// the clicks on its call button, the direction requests, the clicks on its website link and the profile views (the
// people who saw it on Google Search and Maps, mobile and desktop, each counted once a day). Google gives these days
// late (3 to 4, its Merchant Center help says) and may still change a recent day, so every read gives the last
// PERFORMANCE_DAYS days again and the caller keeps the latest read of each day.

export const PERFORMANCE_NAMES = ['calls', 'directions', 'websiteClicks', 'views'] as const;
export type PerformanceName = (typeof PERFORMANCE_NAMES)[number];
// The four figures per day, by the day Google counts them on (YYYY-MM-DD); a day Google did not return is left out.
export type DailyPerformance = Record<string, Record<PerformanceName, number>>;
// How many days up to yesterday each read asks for: the lag, the days a missed read leaves behind, and room to spare.
export const PERFORMANCE_DAYS = 14;
