# Hồ sơ đánh giá tác động xử lý dữ liệu cá nhân

> **BẢN NHÁP, CHƯA ĐƯỢC LUẬT SƯ RÀ SOÁT.** Không nộp nguyên văn. Luật sư xác nhận: ai phải lập hồ sơ này (đơn vị vận hành với vai trò bên xử lý, từng tổ chức với vai trò bên kiểm soát, hay cả hai), biểu mẫu bắt buộc theo Nghị định 356/2025/NĐ-CP, và thời hạn nộp. Các chỗ trong ngoặc vuông cần điền. Dữ kiện về Crove lấy từ [processing-record.md](processing-record.md).

**Đơn vị lập:** [tên đơn vị vận hành Crove], mã số thuế [...], địa chỉ [...]. Vai trò: bên xử lý dữ liệu cá nhân cho các tổ chức dùng Crove. Bên kiểm soát dữ liệu tài khoản người dùng.

**Người phụ trách bảo vệ dữ liệu cá nhân:** [họ tên, chức vụ, email, điện thoại].

**Ngày lập:** [...]. **Phiên bản:** [...].

## 1. Hoạt động xử lý

Crove là phần mềm kế toán cho công ty dịch vụ kế toán và doanh nghiệp nhỏ. Phần mềm:
- nhận hóa đơn điện tử, PDF và ảnh chụp chứng từ;
- đọc nội dung chứng từ;
- đề xuất bút toán theo Thông tư 133 để người có quyền duyệt;
- lập tờ khai thuế giá trị gia tăng và báo cáo tài chính;
- xuất dữ liệu sang phần mềm kế toán của tổ chức.

Mô-đun Social giúp tổ chức soạn và đăng bài lên mạng xã hội của mình.

## 2. Loại dữ liệu và chủ thể

| Chủ thể | Dữ liệu | Nguồn |
|---|---|---|
| Người dùng (thành viên của tổ chức) | Email, họ tên, mật khẩu (dạng băm), yếu tố xác thực hai lớp, phiên đăng nhập, nhật ký thao tác | Người dùng tự cung cấp, hệ thống ghi |
| Người bán, người mua, chủ hộ kinh doanh, người nộp và nhận tiền | Họ tên, mã số thuế, địa chỉ, email, số điện thoại, số tài khoản ngân hàng, nội dung hóa đơn và chứng từ | Tổ chức tải lên, gửi qua email hoặc nhập |
| Người nhận báo cáo, người duyệt bài Social của khách hàng | Email, họ tên | Tổ chức nhập |

Chi tiết theo từng cột dữ liệu: [processing-record.md](processing-record.md), mục 2.

**Dữ liệu nhạy cảm.** Thông tin tài chính và tài khoản ngân hàng của cá nhân, nhất là của hộ kinh doanh, có thể là dữ liệu cá nhân nhạy cảm. Hồ sơ này áp dụng mức bảo vệ của dữ liệu nhạy cảm cho toàn bộ chứng từ và sổ sách. [Luật sư xác nhận, câu hỏi 2.]

## 3. Mục đích và cơ sở pháp lý

| Mục đích | Cơ sở pháp lý dự kiến |
|---|---|
| Cung cấp dịch vụ kế toán theo hợp đồng giữa tổ chức và khách hàng | Thực hiện hợp đồng; nghĩa vụ lưu chứng từ theo Luật Kế toán 88/2015 và pháp luật thuế [luật sư xác nhận] |
| Quản lý tài khoản và bảo mật | Thực hiện hợp đồng với người dùng; bảo đảm an ninh hệ thống |
| Gửi email hệ thống | Thực hiện hợp đồng |
| Đọc chứng từ bằng AI | Thực hiện hợp đồng, với thông báo rõ trong chính sách quyền riêng tư và phụ lục xử lý dữ liệu [luật sư xác nhận có cần đồng ý riêng không] |

## 4. Thời gian lưu trữ

[processing-record.md](processing-record.md), mục 3, liệt kê từng loại dữ liệu và thời hạn tự động xóa. Tóm tắt:
- **Sổ sách và chứng từ gốc của bút toán đã ghi:** ít nhất 10 năm, theo Luật Kế toán.
- **Nhật ký kiểm toán:** giữ cùng sổ sách.
- **Địa chỉ người nhận thư:** 13 tháng.
- **Lời mời:** 90 ngày sau khi dùng, thu hồi hoặc hết hạn.
- **Nhật ký an ninh:** 7 đến 30 ngày.
- **Bản sao lưu:** 30 ngày.

## 5. Bên xử lý phụ và chuyển dữ liệu ra nước ngoài

- Danh sách bên xử lý phụ: [sub-processors.vi.md](sub-processors.vi.md).
- Hồ sơ chuyển dữ liệu ra nước ngoài: [transfer-assessment.vi.md](transfer-assessment.vi.md).

## 6. Rủi ro và biện pháp

| # | Rủi ro | Biện pháp đã có trong phần mềm | Mức còn lại |
|---|---|---|---|
| R1 | Người dùng của tổ chức này xem được dữ liệu của tổ chức khác | Cách ly theo tổ chức ngay trong cơ sở dữ liệu (row-level security). Kiểm thử tự động sinh cho mọi bảng chạy trong mỗi lần thay đổi code. | [thấp] |
| R2 | Kẻ gian chiếm tài khoản rồi ghi sổ sai hoặc xóa dữ liệu | Xác thực hai lớp. Xác thực lại trong 5 phút trước mọi thao tác ghi sổ, đổi quyền hay xóa dữ liệu. Giới hạn số lần thử đăng nhập. Cảnh báo khi số lần bị từ chối tăng vọt hoặc có thêm chủ sở hữu, quản trị viên. | [thấp] |
| R3 | Tệp độc hại khai thác trình đọc PDF hoặc XML | Đọc tệp trong môi trường cách ly, không có mạng và không có khóa bí mật | [thấp] |
| R4 | AI đọc sai hoặc bị nội dung chứng từ lừa | Kết quả AI bị coi là chưa tin cậy. Quy tắc tự động kiểm tra, người duyệt trước khi ghi sổ. Bộ kiểm thử hơn 30 tài liệu giả chứa lệnh ẩn chạy trong mỗi lần thay đổi code (`apps/kernel/test/invariant/extraction-redteam.db.test.ts`). | [thấp] |
| R5 | Nội dung chứng từ bị giữ lại ở nhà cung cấp AI | Hợp đồng với nhà cung cấp; chỉ gửi chứng từ không có bản XML; không lưu lời nhắc. Chưa che thông tin trước khi gửi. | [trung bình, chờ hợp đồng D9] |
| R6 | Nhân sự vận hành truy cập trái phép | Nhật ký kiểm toán không sửa được và lưu trữ dạng chỉ ghi một lần, kiểm tra hằng đêm. Khóa kênh kết nối được mã hóa. | [trung bình, cần quy trình nhân sự] |
| R7 | Mất dữ liệu | Sao lưu hằng đêm ra nơi khác, mã hóa, đã thử khôi phục. Mục tiêu mất tối đa 24 giờ dữ liệu, khôi phục trong 4 giờ. | [thấp] |
| R8 | Không xóa hết dữ liệu khi chủ thể yêu cầu | Công cụ tìm và xóa theo email, số điện thoại, mã số thuế. Kiểm thử bất biến buộc mọi cột chứa dữ liệu cá nhân được phân loại. Phần chưa xóa được (văn bản tự do, tệp, sao lưu) có trong hướng dẫn. | [trung bình] |
| R9 | Vi phạm không được báo đúng hạn | Quy trình sự cố ([incidents.md §9](../../runbooks/incidents.md)) và mẫu thông báo ([breach-notice.vi.md](breach-notice.vi.md)) | [thấp, khi luật sư xác nhận] |

## 7. Việc còn phải làm

Xem [processing-record.md](processing-record.md), mục 7:
- văn bản tự do và tệp chưa nằm trong công cụ tìm và xóa;
- việc xóa cuối cùng khi tổ chức rời đi còn làm tay;
- chưa có xóa bằng hủy khóa mã hóa;
- chưa che thông tin trước khi gửi tới AI.

## 8. Người lập và phê duyệt

| Người lập | Người phụ trách bảo vệ dữ liệu cá nhân | Đại diện đơn vị |
|---|---|---|
| [họ tên, ngày] | [họ tên, ngày] | [ký, đóng dấu] |
