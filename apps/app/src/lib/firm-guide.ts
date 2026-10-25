// The guide for an accounting firm (issue #661, plan M3-9): one client company's month in Crove, from adding the
// client to handing the books over, so a second firm can start "with the guide only". Like the quick guide
// (quick-guide.ts) it is Vietnamese in every interface language and quotes buttons and screens by their Vietnamese
// catalog labels, so a renamed button renames it here too. Labels with a placeholder ("Duyệt {count} đề xuất") are
// quoted with the placeholder filled in, as the screen shows them.
import { brandName, withBrand } from '../i18n/brand.ts';
import { vi } from '../i18n/messages/vi.ts';

export interface FirmGuideStep {
  id: 'client' | 'setup' | 'intake' | 'review' | 'bank' | 'close' | 'handover';
  title: string;
  items: readonly string[];
}

const q = (label: string) => `"${label}"`;

// A catalog label with its ICU placeholders filled in: "Duyệt {count, number} đề xuất" with { count: 'N' } reads
// "Duyệt N đề xuất".
export function fill(label: string, values: Readonly<Record<string, string>>): string {
  return label.replace(/\{(\w+)(?:,[^}]*)?\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? (values[name] ?? whole) : whole));
}

const FIRM_GUIDE: readonly FirmGuideStep[] = [
  {
    id: 'client',
    title: 'Bước 1. Thêm doanh nghiệp khách hàng',
    items: [
      `Mỗi khách hàng là một tổ chức riêng trong {brand}, với sổ sách, hộp thư chứng từ và thành viên riêng. Bấm ${q(vi.nav.addOrg)} dưới ô ${q(vi.nav.org)} trong menu.`,
      `Nhập ${q(vi.onboarding.taxCodeLabel)} của khách hàng rồi bấm ${q(vi.onboarding.lookUp)}: {brand} điền tên và địa chỉ theo dữ liệu đăng ký thuế, bạn kiểm tra lại. Mã số thuế giúp {brand} nhận ra hóa đơn bán ra của khách hàng.`,
      `Nếu có ${q(vi.onboarding.contactLabel)}, nhập vào: sau khi bấm ${q(vi.onboarding.create)}, trang mời thành viên mở sẵn với email này. Chọn vai trò rồi bấm ${q(vi.settings.invite)}; người được mời phải chấp nhận lời mời thì mới vào tổ chức.`,
      `Khi bạn phụ trách từ hai doanh nghiệp trở lên, ${q(vi.nav.allClients)} trong menu mở màn hình ${q(vi.clients.title)}: số đề xuất ${q(vi.clients.columns.pending)}, ${q(vi.clients.columns.failed)} và ${q(vi.clients.columns.vatDeadline)} của từng doanh nghiệp. Bấm tên để mở.`,
    ],
  },
  {
    id: 'setup',
    title: 'Bước 2. Cài đặt một lần cho mỗi khách hàng',
    items: [
      `Mở ${q(vi.nav.settings)}. Chọn ${q(vi.settings.vatFilingPeriod)} (${q(vi.settings.vatFilingMonth)} hoặc ${q(vi.settings.vatFilingQuarter)}) để {brand} nhắc hạn nộp tờ khai; kiểm tra ${q(vi.settings.taxCode)} đã đúng.`,
      `Trong ${q(vi.accounts.title)}, ${q(vi.accounts.addTitle)} nếu khách hàng dùng tài khoản chi tiết, ví dụ 1121.VCB cho từng ngân hàng. Tài khoản tiền gửi (112) là nơi nhập sao kê ở Bước 5.`,
      `Nếu khách hàng đã có sổ sách trước khi dùng {brand}, mở ${q(vi.nav.journal)} và bấm ${q(vi.openingBalance.open)}: ${q(vi.openingBalance.downloadTemplate)}, điền số dư cuối ngày, chọn ngày và file đã điền, rồi bấm ${q(vi.openingBalance.post)}. Việc này cần chủ sở hữu hoặc quản trị.`,
    ],
  },
  {
    id: 'intake',
    title: 'Bước 3. Nhận hóa đơn mua vào và bán ra của tháng',
    items: [
      `Tải hóa đơn của cả tháng một lần: tệp ZIP xuất từ cổng thuế, hoặc nhiều tệp XML, kéo vào ${q(vi.nav.inbox)} hoặc bấm ${q(vi.inbox.upload)}. {brand} đọc từng hóa đơn và báo đề xuất, trùng hay lỗi cho từng tệp.`,
      `Hóa đơn bán ra của khách hàng (người bán có mã số thuế của tổ chức) tải lên cùng chỗ: {brand} tự ghi chúng là hóa đơn bán ra.`,
      `Hóa đơn nhà cung cấp gửi qua email có thể chuyển tiếp tới địa chỉ trong ô ${q(vi.inbox.forwardTitle)}, nếu máy chủ bật nhận email.`,
      `Để biết hóa đơn nào cơ quan thuế đã ghi nhận mà {brand} chưa có, mở ${q(vi.nav.portalList)}, làm theo ${q(vi.portalList.howTitle)} rồi bấm ${q(vi.portalList.upload)}. Phần ${q(vi.portalList.tiles.missing)} là các hóa đơn cần xin thêm từ người bán.`,
    ],
  },
  {
    id: 'review',
    title: 'Bước 4. Kiểm tra và duyệt',
    items: [
      `Ở tab ${q(vi.inbox.tabs.pending)}, hóa đơn không có kiểm tra lỗi duyệt chung được: đánh dấu ô ${q(fill(vi.inbox.bulk.selectAll, { count: 'N' }))} rồi bấm ${q(fill(vi.inbox.bulk.approve, { count: 'N' }))}. Một lần xác thực hai lớp cho cả nhóm; từng đề xuất vẫn được kiểm tra riêng.`,
      `Đề xuất có kiểm tra lỗi, có thể trùng, hay là bút toán đảo thì mở ra duyệt riêng: đối chiếu với ${q(vi.inboxDetail.original)}, sửa ${q(vi.inboxDetail.debitAccount)} nếu cần, bấm ${q(vi.inboxDetail.saveEdit)} rồi ${q(vi.inboxDetail.approve)}, hoặc ${q(vi.inboxDetail.reject)}.`,
      `Trong một đề xuất, phím J hoặc N chuyển sang đề xuất tiếp theo, A duyệt, E sửa tài khoản.`,
      'Nếu tổ chức có từ hai người duyệt, người tải lên hoặc sửa đề xuất không tự duyệt được: một người khác phải duyệt.',
    ],
  },
  {
    id: 'bank',
    title: 'Bước 5. Ngân hàng và tiền mặt',
    items: [
      `Mở ${q(vi.nav.bank)}, chọn ${q(vi.bank.account)}, rồi ở ${q(vi.bank.importTitle)} chọn file sao kê Excel hoặc CSV tải từ ngân hàng. Dòng đã nhập trước đó không bị nhập lại; dòng ${q(vi.bank.status.ambiguous)} được giữ để bạn kiểm tra.`,
      `Dòng nào có nội dung chuyển khoản ghi rõ đối tượng thì bấm ${q(fill(vi.bank.proposeAll, { count: 'N' }))}; các dòng còn lại bấm ${q(vi.bank.makeVoucher)} để lập giấy báo Có hoặc giấy báo Nợ. Dòng chưa lập chứng từ cũng hiện trong ${q(vi.nav.inbox)}.`,
      `Phiếu thu, phiếu chi tiền mặt lập ở ${q(vi.nav.vouchers)} bằng nút ${q(vi.vouchers.new)}. Mọi chứng từ thu chi được ghi sổ khi chủ sở hữu hoặc quản trị duyệt.`,
    ],
  },
  {
    id: 'close',
    title: 'Bước 6. Khóa sổ và tờ khai GTGT',
    items: [
      `Mở ${q(vi.nav.ledger)} để xem ${q(vi.ledger.tabs.trialBalance)}, ${q(vi.ledger.tabs.generalLedger)} và ${q(vi.ledger.tabs.parties)} của tháng, rồi bấm ${q(vi.ledger.export)} nếu cần gửi Excel.`,
      `Mở ${q(vi.nav.vat)}, chọn kỳ, xem bảng kê và các chỉ tiêu 01/GTGT. Bấm ${q(vi.vat.export)} để gửi bảng kê, hoặc ${q(vi.vat.exportXml)} để có tệp XML mở trong HTKK.`,
      'File XML để 0 ở các chỉ tiêu {brand} chưa tính được, trong đó có [25] thuế được khấu trừ: kế toán bổ sung và kiểm tra trong HTKK hoặc trên eTax trước khi nộp.',
      `Khi đã nộp báo cáo của tháng, quay lại ${q(vi.nav.ledger)} và bấm ${q(fill(vi.periodLock.lock, { month: 'MM/YYYY' }))} ở ô ${q(vi.periodLock.title)}: không ai ghi, duyệt hay đảo bút toán vào tháng đó được nữa. Chủ sở hữu hoặc quản trị khóa sổ; chỉ chủ sở hữu mở khóa được, kèm lý do.`,
    ],
  },
  {
    id: 'handover',
    title: 'Bước 7. Đưa số liệu sang phần mềm kế toán của hãng',
    items: [
      `Nếu hãng dùng MISA SME: ở ${q(vi.nav.journal)} bấm ${q(vi.journal.exportMisa)} và ${q(vi.journal.exportMisaSales)}; ở ${q(vi.nav.vouchers)} bấm ${q(vi.vouchers.exportReceipts)} và ${q(vi.vouchers.exportPayments)}. Mỗi file theo mẫu nhập khẩu từ Excel của MISA.`,
      'Trước khi nhập vào MISA, điền mã hàng hoặc mã dịch vụ theo danh mục của hãng ({brand} để trống vì không biết mã của hãng), rồi kiểm tra các dòng chưa có thuế suất. Giấy báo Có, giấy báo Nợ chưa xuất được sang MISA.',
      `Với phần mềm khác, ${q(vi.journal.export)} ở ${q(vi.nav.journal)} cho file Excel ghi từng dòng Nợ/Có.`,
    ],
  },
];

// The guide with the product name filled in (BRAND_NAME, issue #1040): the text above, and the labels it quotes, say
// {brand}.
export function firmGuide(brand: string = brandName()): readonly FirmGuideStep[] {
  return FIRM_GUIDE.map((step) => ({ ...step, title: withBrand(step.title, brand), items: step.items.map((item) => withBrand(item, brand)) }));
}
