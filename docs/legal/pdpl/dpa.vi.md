# Phụ lục: Thỏa thuận xử lý dữ liệu cá nhân

> **BẢN NHÁP, CHƯA ĐƯỢC LUẬT SƯ RÀ SOÁT.** Không ký nguyên văn. Phụ lục này dự kiến kèm theo [Điều khoản sử dụng](../terms.vi.md). Các chỗ trong ngoặc vuông cần điền. Mỗi cam kết về Crove dẫn tới tài liệu mô tả đúng điều phần mềm đang làm ([processing-record.md](processing-record.md)). Câu hỏi cho luật sư nằm trong [README.md](README.md), câu hỏi 1.

Phụ lục này là một phần của Điều khoản sử dụng Crove giữa:

- **Bên kiểm soát dữ liệu cá nhân** ("**Tổ chức**"): [tên công ty dịch vụ kế toán hoặc doanh nghiệp], mã số thuế [...], người đại diện [...];
- **Bên xử lý dữ liệu cá nhân** ("**Đơn vị vận hành**"): [tên đơn vị vận hành Crove], mã số thuế [...], người đại diện [...].

Phụ lục áp dụng cho dữ liệu cá nhân nằm trong chứng từ và sổ sách mà Tổ chức đưa vào Crove. Với dữ liệu tài khoản của người dùng (họ tên, email, nhật ký đăng nhập), Đơn vị vận hành là bên kiểm soát và xử lý theo [Chính sách quyền riêng tư](../privacy.vi.md).

## 1. Nội dung, mục đích và thời hạn xử lý

- **Mục đích.** Đơn vị vận hành xử lý dữ liệu chỉ để cung cấp Crove cho Tổ chức. Cụ thể:
  - lưu chứng từ và hóa đơn;
  - đọc nội dung chứng từ;
  - đề xuất bút toán để người có quyền duyệt;
  - lập báo cáo và tờ khai;
  - xuất dữ liệu;
  - sao lưu, giám sát an ninh và hỗ trợ.
- **Thời hạn.** Từ khi Tổ chức bắt đầu dùng Crove đến khi dữ liệu bị xóa theo mục 8.
- **Chỉ dẫn.** Đơn vị vận hành chỉ xử lý theo chỉ dẫn của Tổ chức. Chỉ dẫn gồm Điều khoản sử dụng, Phụ lục này và các thao tác của thành viên Tổ chức trong Crove. Nếu một chỉ dẫn có vẻ trái luật, Đơn vị vận hành báo cho Tổ chức và có thể tạm dừng thực hiện chỉ dẫn đó.

## 2. Loại dữ liệu và chủ thể dữ liệu

- **Chủ thể:**
  - người bán, người mua, nhân viên, người nộp và nhận tiền có tên trên chứng từ của Tổ chức và của các công ty khách hàng của Tổ chức;
  - chủ hộ kinh doanh;
  - người liên hệ của các bên đó.
- **Loại dữ liệu:**
  - họ tên, mã số thuế cá nhân, địa chỉ, email, số điện thoại, số tài khoản ngân hàng;
  - nội dung hóa đơn, phiếu thu, phiếu chi, sao kê và bút toán;
  - ảnh chụp và tệp chứng từ.

  Danh sách chi tiết theo từng cột dữ liệu nằm trong [processing-record.md](processing-record.md), mục 2.
- **Dữ liệu nhạy cảm.** Thông tin tài chính và tài khoản ngân hàng của cá nhân có thể là dữ liệu cá nhân nhạy cảm. Hai bên áp dụng mức bảo vệ của dữ liệu nhạy cảm cho toàn bộ chứng từ và sổ sách. [Luật sư xác nhận, câu hỏi 2.]

## 3. Nghĩa vụ của Tổ chức

- Có cơ sở pháp lý để đưa dữ liệu vào Crove: sự đồng ý của chủ thể, thực hiện hợp đồng dịch vụ kế toán, hoặc nghĩa vụ theo Luật Kế toán và pháp luật thuế. [Luật sư xác nhận, câu hỏi 2.]
- Thông báo cho chủ thể dữ liệu về việc xử lý, khi luật yêu cầu.
- Chỉ mời vào Crove những người được phép xem dữ liệu, và gán đúng vai trò.
- Tự lưu trữ chứng từ và sổ kế toán đủ thời hạn Luật Kế toán yêu cầu, bằng bản xuất của mình.

## 4. Bảo mật

Đơn vị vận hành duy trì ít nhất các biện pháp sau. Mỗi biện pháp có kiểm thử tự động hoặc quy trình vận hành tương ứng, nêu trong [processing-record.md](processing-record.md), mục 6:

- cách ly dữ liệu giữa các tổ chức ở tầng cơ sở dữ liệu (row-level security), kiểm thử cho mọi bảng;
- mã hóa đường truyền (TLS);
- xác thực hai lớp và xác thực lại trước mọi thao tác ghi sổ hoặc xóa dữ liệu;
- đọc tệp trong môi trường cách ly, không có mạng và không có khóa bí mật;
- nhật ký kiểm toán không sửa được, lưu trữ thêm theo dạng chỉ ghi một lần (WORM);
- mã hóa khóa truy cập của các kênh kết nối;
- sao lưu hằng ngày có thử khôi phục;
- giới hạn số lần thử đăng nhập và cảnh báo hoạt động bất thường.

Nhân sự của Đơn vị vận hành có quyền truy cập dữ liệu phải cam kết bảo mật, và chỉ truy cập khi cần để vận hành hoặc hỗ trợ.

## 5. Bên xử lý phụ

- Tổ chức đồng ý cho Đơn vị vận hành dùng các bên xử lý phụ trong [sub-processors.vi.md](sub-processors.vi.md).
- Đơn vị vận hành báo trước ít nhất [30] ngày khi thêm hoặc thay một bên xử lý phụ. Tổ chức có thể phản đối có lý do. Nếu hai bên không thống nhất, Tổ chức có thể chấm dứt hợp đồng và xuất dữ liệu theo mục 8.
- Đơn vị vận hành ràng buộc mỗi bên xử lý phụ bằng nghĩa vụ bảo vệ dữ liệu không thấp hơn Phụ lục này. Đơn vị vận hành chịu trách nhiệm trước Tổ chức về việc bên xử lý phụ tuân thủ.

## 6. Hỗ trợ thực hiện quyền của chủ thể dữ liệu

- Crove có sẵn công cụ để Tổ chức tự trả lời yêu cầu của chủ thể dữ liệu:
  - tìm mọi dữ liệu theo email, số điện thoại hoặc mã số thuế;
  - tải dữ liệu về;
  - xóa dữ liệu, trừ phần luật buộc giữ, kèm lý do.

  Cách dùng nằm trong [personal-data-requests.md](../../runbooks/personal-data-requests.md).
- Khi chủ thể dữ liệu gửi yêu cầu thẳng cho Đơn vị vận hành, Đơn vị vận hành chuyển yêu cầu cho Tổ chức trong [5] ngày làm việc và không tự trả lời thay Tổ chức.

## 7. Vi phạm dữ liệu cá nhân

- Đơn vị vận hành báo cho Tổ chức không chậm trễ, và chậm nhất [24] giờ sau khi phát hiện vi phạm liên quan đến dữ liệu của Tổ chức. Mục đích là để Tổ chức kịp thông báo cho cơ quan có thẩm quyền trong thời hạn [72] giờ.
- Nội dung báo theo mẫu B trong [breach-notice.vi.md](breach-notice.vi.md).
- Đơn vị vận hành cung cấp thông tin và hỗ trợ Tổ chức lập thông báo gửi cơ quan có thẩm quyền.

## 8. Khi chấm dứt

- Khi Tổ chức ngừng dùng Crove, Tổ chức xuất dữ liệu trong [30] ngày theo [org-offboarding.md](../../runbooks/org-offboarding.md). Hết thời hạn đó, Đơn vị vận hành xóa dữ liệu của Tổ chức.
- Bản sao lưu bị xóa theo vòng đời sao lưu, tối đa [số ngày] ngày. Sau khi khôi phục từ bản sao lưu, Đơn vị vận hành chạy lại các lệnh xóa đã ghi trong nhật ký.
- Phần luật buộc Đơn vị vận hành tự giữ, nếu có, được giữ đúng thời hạn luật định rồi xóa. [Luật sư xác nhận, câu hỏi 6.]

## 9. Chuyển dữ liệu ra nước ngoài

- Dữ liệu của Tổ chức được lưu tại [Việt Nam / quốc gia], theo quyết định ở #122.
- PDF và ảnh chụp chứng từ được gửi tới dịch vụ AI để đọc nội dung, theo [transfer-assessment.vi.md](transfer-assessment.vi.md). Hóa đơn điện tử dạng XML không qua AI.
- Nếu dữ liệu được xử lý ngoài Việt Nam, Đơn vị vận hành lập và lưu hồ sơ đánh giá tác động chuyển dữ liệu theo quy định, và cung cấp bản sao cho Tổ chức khi được yêu cầu.

## 10. Kiểm tra

Đơn vị vận hành cung cấp thông tin cần thiết để chứng minh việc tuân thủ Phụ lục này, khi Tổ chức yêu cầu bằng văn bản, tối đa [một] lần mỗi năm. Thông tin gồm hồ sơ đánh giá tác động, danh sách bên xử lý phụ và kết quả rà soát bảo mật gần nhất. Riêng việc kiểm tra theo yêu cầu của cơ quan nhà nước không bị giới hạn số lần.

[Địa điểm], ngày [...]

| Tổ chức | Đơn vị vận hành |
|---|---|
| [ký, ghi rõ họ tên, đóng dấu] | [ký, ghi rõ họ tên, đóng dấu] |
