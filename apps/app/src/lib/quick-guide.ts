// The one-page quick guide for pilot users (issue #310): upload, approve, export. It is written in Vietnamese only,
// whatever the interface language, and quotes the buttons and screens by their Vietnamese labels from the source
// catalog, so a renamed button renames it here too.
import { vi } from '../i18n/messages/vi.ts';

export interface GuideStep {
  id: 'upload' | 'approve' | 'export';
  title: string;
  items: readonly string[];
}

const q = (label: string) => `"${label}"`;

export const QUICK_GUIDE: readonly GuideStep[] = [
  {
    id: 'upload',
    title: 'Bước 1. Tải hóa đơn lên',
    items: [
      `Mở ${q(vi.nav.inbox)} ở thanh bên trái.`,
      `Bấm ${q(vi.inbox.upload)}, hoặc kéo thả tệp vào ô ${q(vi.inbox.dropHere)}. Mỗi tệp tối đa 25 MB, chọn được nhiều tệp một lần (tối đa 500), hoặc một tệp ZIP tải về từ cổng thuế: Crove mở ZIP và đọc từng hóa đơn.`,
      'Tệp XML hóa đơn điện tử luôn đọc được. Tệp PDF và ảnh chụp chỉ đọc được khi máy chủ đã cấu hình AI; nếu chưa, ô tải lên sẽ báo.',
      `Nếu máy chủ bật nhận email, bạn có thể forward thư hóa đơn tới địa chỉ trong ô ${q(vi.inbox.forwardTitle)} (bấm ${q(vi.inbox.copyAddress)} để sao chép).`,
      `Tệp vừa gửi hiện ở ${q(vi.inbox.recentFiles)}: ${q(vi.inbox.fileStatus.processing)}, rồi ${q(vi.inbox.fileStatus.proposed)}. Nếu tệp ${q(vi.inbox.fileStatus.failed)}, bấm ${q(vi.inbox.reread)} khi có nút này.`,
    ],
  },
  {
    id: 'approve',
    title: 'Bước 2. Kiểm tra và duyệt',
    items: [
      `Ở tab ${q(vi.inbox.tabs.pending)}, bấm tên người bán để mở đề xuất.`,
      `Đối chiếu số tiền, ${q(vi.inboxDetail.checks)} và ${q(vi.inboxDetail.journal)} với ${q(vi.inboxDetail.original)}.`,
      `Muốn đổi tài khoản, chọn lại ở cột ${q(vi.inboxDetail.debitAccount)} rồi bấm ${q(vi.inboxDetail.saveEdit)}.`,
      `Nút ${q(vi.inboxDetail.approve)} bị mờ khi còn chỉnh sửa chưa lưu, hoặc khi có kiểm tra không đạt: đối chiếu chứng từ gốc rồi đánh dấu ô ${q(vi.inboxDetail.acceptFailed)} nếu vẫn muốn ghi sổ.`,
      `Bấm ${q(vi.inboxDetail.approve)}. Crove có thể hỏi mã xác thực hai lớp: lần đầu, bấm ${q(vi.twoFactor.enable)}, quét mã QR bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator...) rồi nhập mã 6 chữ số.`,
      'Nếu tổ chức có từ hai người duyệt trở lên, người đã tải lên hoặc chỉnh sửa đề xuất không tự duyệt được: một người khác phải duyệt.',
      `Hóa đơn sai thì bấm ${q(vi.inboxDetail.reject)} (lý do không bắt buộc).`,
      `Đề xuất đã duyệt chuyển sang tab ${q(vi.inbox.tabs.executed)}; chứng từ hiện ở ${q(vi.nav.documents)}, người bán ở ${q(vi.nav.vendors)}.`,
    ],
  },
  {
    id: 'export',
    title: 'Bước 3. Xuất Excel cho kế toán',
    items: [
      `Mở ${q(vi.nav.journal)} ở thanh bên trái.`,
      `Chọn ${q(vi.journal.from)} và ${q(vi.journal.to)} nếu chỉ cần một khoảng thời gian; để trống để xuất tất cả.`,
      `Bấm ${q(vi.journal.export)}. Tệp crove-but-toan-<mã tổ chức>.xlsx ghi từng dòng Nợ/Có, gửi thẳng cho kế toán.`,
    ],
  },
];
