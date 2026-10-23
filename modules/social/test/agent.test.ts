import { describe, expect, it } from 'vitest';
import { escalationTitle, preReviewTask, preReviewText } from '../src/agent.ts';

// Every member reads kernel tasks, also one limited to other channels (#1081), so the content agent's task, comment and
// escalation carry counts only, never what the checks found (#1193).
describe('the content agent says counts only (#1193)', () => {
  const postId = '0b5c6f7e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
  const findings = ['Trang khách Hùng: có từ nên tránh theo giọng thương hiệu (giá sốc).', 'Trang khách Hùng: 1 ảnh hoặc video chưa có mô tả cho người đọc màn hình (alt text).'];

  it('titles the task with the channels sent and points it at the post', () => {
    expect(preReviewTask({ id: postId, tainted: false }, 2)).toEqual({ title: 'Rà soát bài gửi duyệt: 2 kênh', ref: { type: 'social.post', id: postId }, tainted: false });
  });

  it('counts the findings in the comment and the escalation, and names none', () => {
    const text = preReviewText({ postId, waiting: 1, findings });
    expect(text).toBe('Rà soát trước: 1 kênh đang chờ duyệt.\nCác kiểm tra tự động thấy 2 điểm cần xem; chi tiết ở mục Kiểm tra tự động, phần Duyệt bài của trang bài đăng. Người duyệt nên xem các điểm đó trước khi quyết định.');
    expect(escalationTitle({ postId, waiting: 1, findings })).toBe('Duyệt bài: 1 kênh chờ duyệt, 2 điểm cần xem');
    for (const said of [text, escalationTitle({ postId, waiting: 1, findings })]) expect(said).not.toMatch(/Hùng|giá sốc|alt text/);
  });

  it('says when the checks found nothing', () => {
    expect(preReviewText({ postId, waiting: 2, findings: [] })).toBe('Rà soát trước: 2 kênh đang chờ duyệt.\nCác kiểm tra tự động không thấy điểm nào cần xem; người có quyền duyệt cần mở bài và quyết định.');
    expect(escalationTitle({ postId, waiting: 2, findings: [] })).toBe('Duyệt bài: 2 kênh chờ duyệt');
  });
});
