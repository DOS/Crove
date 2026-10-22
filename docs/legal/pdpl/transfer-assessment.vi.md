# Hồ sơ đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài

> **BẢN NHÁP, CHƯA ĐƯỢC LUẬT SƯ RÀ SOÁT.** Không nộp nguyên văn. Luật sư xác nhận: hồ sơ có bắt buộc không, biểu mẫu nào theo Nghị định 356/2025/NĐ-CP, nộp cho cơ quan nào, khi nào. Các chỗ trong ngoặc vuông cần điền. Dữ kiện về Crove lấy từ [processing-record.md](processing-record.md).

**Bên chuyển dữ liệu:** [tên đơn vị vận hành Crove], mã số thuế [...], địa chỉ [...]. Người phụ trách bảo vệ dữ liệu cá nhân: [họ tên, email].

**Ngày lập:** [...]. **Phiên bản:** [...].

## 1. Các luồng dữ liệu có thể ra nước ngoài

Hồ sơ chỉ cần cho luồng nào thật sự xử lý ngoài Việt Nam. Điền cột "Nơi xử lý" khi chủ sở hữu đã chọn nhà cung cấp, rồi bỏ các dòng xử lý trong nước.

| # | Luồng | Dữ liệu cá nhân | Bên nhận | Nơi xử lý |
|---|---|---|---|---|
| L1 | Đọc PDF và ảnh chụp chứng từ bằng AI | Nội dung PDF (tối đa 60.000 ký tự) và ảnh chụp: tên, mã số thuế, địa chỉ, số tài khoản, số tiền | DOS.AI (quyết định D9) [và nhà cung cấp mô hình phía sau] | [quốc gia] |
| L2 | Soạn bài và mô tả ảnh cho mô-đun Social | Nội dung bài và ảnh do tổ chức đưa vào | như L1 | [quốc gia] |
| L3 | Máy chủ, lưu trữ tệp và sao lưu | Toàn bộ dữ liệu | [nhà cung cấp, #306] | [Việt Nam hoặc Singapore, #122] |
| L4 | Nhận email hóa đơn gửi tới tổ chức | Toàn bộ email và tệp đính kèm | Cloudflare | [mạng toàn cầu] |
| L5 | Gửi email hệ thống | Địa chỉ người nhận, nội dung thư | [nhà cung cấp email] | [quốc gia] |
| L6 | Cảnh báo cho chủ sở hữu | Mã định danh người dùng và tổ chức, số đếm | [Telegram, Slack hoặc Discord] | [quốc gia] |

Hóa đơn điện tử dạng XML, phần lớn khối lượng, được đọc trong môi trường cách ly trên máy chủ và không gửi tới AI (`modules/finance/src/extract.ts`).

## 2. Mục đích và sự cần thiết

- **L1:** chỉ để đọc các trường của chứng từ không có bản XML. Không có AI, người dùng phải gõ tay. Kết quả AI luôn được kiểm tra bằng quy tắc và do người duyệt trước khi ghi sổ.
- **L2:** chỉ khi tổ chức dùng mô-đun Social và tự bấm yêu cầu soạn bài.
- **L3 đến L6:** cần để vận hành dịch vụ. Nếu máy chủ đặt tại Việt Nam (#122), L3 không còn là chuyển ra nước ngoài.

## 3. Biện pháp bảo vệ đã có trong phần mềm

- Chỉ gửi tới AI phần cần đọc. XML không bao giờ được gửi. Nội dung chứng từ cũng không được gửi cho mục đích nào khác.
- Không lưu lời nhắc hay câu trả lời thô của AI. Bảng `ai_run` chỉ ghi trạng thái, chi phí và cờ đánh dấu dữ liệu chưa tin cậy.
- Kết quả AI luôn được coi là chưa tin cậy và không tự ghi sổ.
- Đường truyền được mã hóa.
- Cảnh báo an ninh chỉ chứa mã định danh và số đếm, không có email, tên hay khóa (`apps/kernel/src/security-signals.ts`).
- Bản sao lưu được mã hóa AES-256-GCM khi có khóa (`docs/runbooks/backup-and-restore.md`).

**Chưa có:** che hoặc xóa thông tin cá nhân trước khi gửi tới AI. Điểm này được nêu ở mục 4.

## 4. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Mức | Biện pháp | Còn lại |
|---|---|---|---|
| Bên nhận AI giữ lại hoặc dùng nội dung chứng từ để huấn luyện | [đánh giá] | Hợp đồng cấm giữ lại và cấm huấn luyện [điền theo hợp đồng D9] | [đánh giá] |
| Cơ quan nước ngoài yêu cầu bên nhận cung cấp dữ liệu | [đánh giá] | Chọn nơi xử lý có cam kết; ưu tiên xử lý trong nước khi có lựa chọn tương đương | [đánh giá] |
| Lộ dữ liệu tại bên nhận | [đánh giá] | Bên nhận cam kết báo vi phạm cho đơn vị vận hành trong [24] giờ | [đánh giá] |
| Nội dung chứng từ chứa dữ liệu nhạy cảm, như tài khoản ngân hàng của cá nhân | [đánh giá] | Chỉ gửi chứng từ không có bản XML; cân nhắc che số tài khoản trước khi gửi (chưa làm) | [đánh giá] |

## 5. Cam kết của bên nhận

[Trích hoặc đính kèm điều khoản hợp đồng của từng bên nhận ở mục 1: mục đích, cấm huấn luyện, thời gian giữ, bảo mật, báo vi phạm, xóa khi kết thúc.]

## 6. Thông báo cho chủ thể dữ liệu và tổ chức

- Chính sách quyền riêng tư nêu việc dùng AI và nơi xử lý ([privacy.vi.md](../privacy.vi.md), mục 4 và 5).
- Phụ lục xử lý dữ liệu nêu việc chuyển ra nước ngoài ([dpa.vi.md](dpa.vi.md), mục 9).

## 7. Người lập và phê duyệt

| Người lập | Người phụ trách bảo vệ dữ liệu cá nhân | Đại diện đơn vị |
|---|---|---|
| [họ tên, ngày] | [họ tên, ngày] | [ký, đóng dấu] |
