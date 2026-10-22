// A Story's counts on the Metrics tab (#1082): the line under its row and the window's Story totals, in natural
// Vietnamese and in English, and nothing for feed posts. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { StoryLine, StoryTotals } from '../src/components/social-story-metrics.tsx';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={(locale === 'vi' ? viMessages : enMessages) as never} timeZone="Asia/Ho_Chi_Minh">
      {node}
    </IntlProvider>,
  );
const story = { reach: 210, views: 260, replies: 4, tapsForward: 19, tapsBack: 4, exits: 1, nextStory: 1, follows: 3, profileVisits: 7 };

describe('Story counts on the Metrics tab (#1082)', () => {
  it("shows a Story's own counts under its row, in order", () => {
    const html = render(<StoryLine metrics={story} />);
    expect(html).toContain('Tin (Story)');
    expect(html).toContain('Lượt trả lời 4 · Chạm xem tiếp 19 · Chạm quay lại 4 · Lượt thoát 1 · Vuốt sang tin tiếp theo 1 · Người theo dõi mới 3 · Lượt vào trang cá nhân 7');
    expect(render(<StoryLine metrics={story} />, 'en')).toContain('Replies 4 · Taps forward 19 · Taps back 4 · Exits 1 · Swipes to next story 1 · Follows 3 · Profile visits 7');
  });

  it("totals the window's Stories and says why the last capture comes before 24 hours", () => {
    const html = render(<StoryTotals metrics={{ ...story, reactions: 12 }} />);
    expect(html).toContain('Tin (Story) trong kỳ');
    expect(html).toContain('24 giờ');
    expect(html).toContain('Lượt trả lời');
    expect(html).not.toContain('Cảm xúc');
  });

  it('shows nothing for feed posts', () => {
    expect(render(<StoryLine metrics={{ reach: 30, reactions: 3 }} />)).toBe('');
    expect(render(<StoryTotals metrics={{ reach: 30, reactions: 3 }} />)).toBe('');
  });
});
