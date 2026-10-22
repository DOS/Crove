# Danh sách bên xử lý phụ

> **BẢN NHÁP, CHƯA ĐƯỢC LUẬT SƯ RÀ SOÁT.** Tên, quốc gia và hợp đồng của từng nhà cung cấp do chủ sở hữu điền khi chọn xong (máy chủ pilot #306, nơi lưu dữ liệu #122). Cột "Dữ liệu cá nhân có thể nhận" lấy từ code, theo [processing-record.md](processing-record.md) mục 4.

Phiên bản: [số], cập nhật ngày [...]. Đơn vị vận hành báo trước [30] ngày khi thêm hoặc thay một bên, theo [dpa.vi.md](dpa.vi.md) mục 5.

| Bên xử lý phụ | Việc | Dữ liệu cá nhân có thể nhận | Nơi xử lý | Cơ sở |
|---|---|---|---|---|
| [Nhà cung cấp máy chủ] | Chạy cơ sở dữ liệu và ứng dụng | Toàn bộ dữ liệu của mọi tổ chức, lưu trên đĩa của máy chủ | [Việt Nam / quốc gia, #122] | [hợp đồng] |
| [Nhà cung cấp lưu trữ tệp, S3] | Lưu tệp chứng từ, bản xuất và bản lưu trữ năm | Mọi tệp chứng từ, hóa đơn, ảnh chụp | [quốc gia] | [hợp đồng] |
| [Nhà cung cấp lưu trữ sao lưu, khác nhà cung cấp trên nếu có thể] | Lưu bản sao lưu hằng đêm, giữ 30 ngày, có mã hóa | Toàn bộ cơ sở dữ liệu và tệp | [quốc gia] | [hợp đồng] |
| [Nhà cung cấp email, SMTP hoặc Resend] | Gửi email đăng nhập, lời mời, báo cáo | Địa chỉ người nhận và nội dung thư | [quốc gia] | [hợp đồng] |
| Cloudflare (Email Routing và Workers) | Nhận email gửi tới địa chỉ nhận hóa đơn của tổ chức và chuyển tiếp về Crove | Toàn bộ email, gồm người gửi và tệp đính kèm | [quốc gia hoặc mạng toàn cầu] | [điều khoản Cloudflare] |
| DOS.AI (quyết định D9) [và nhà cung cấp mô hình phía sau, nếu có] | Đọc PDF và ảnh chụp chứng từ; soạn bài cho mô-đun Social | Nội dung PDF và ảnh chụp: tên, mã số thuế, địa chỉ, số tiền trên hóa đơn. Không gửi hóa đơn XML. | [quốc gia, xem transfer-assessment.vi.md] | [hợp đồng] |
| [Kênh cảnh báo: Telegram, Slack hoặc Discord] | Gửi cảnh báo vận hành và an ninh cho chủ sở hữu | Mã định danh người dùng và tổ chức, số đếm. Không có email, tên hay khóa. | [quốc gia] | [điều khoản] |
| [Dịch vụ kiểm tra hoạt động] | Gọi `/healthz` mỗi 5 phút | Không có | [quốc gia] | [điều khoản] |
| [Dịch vụ tra cứu mã số thuế, `TAX_CODE_LOOKUP_URL`] | Điền sẵn tên và địa chỉ khi tạo tổ chức từ mã số thuế | Mã số thuế người dùng nhập | [quốc gia] | [điều khoản] |

## Không phải bên xử lý phụ của đơn vị vận hành

- **Mạng xã hội mà tổ chức tự kết nối** (Facebook, Instagram, Zalo, Threads, LinkedIn, YouTube, TikTok, X, Pinterest và các mạng khác). Tổ chức chọn đăng bài lên đó bằng tài khoản của mình, nên đó là việc của tổ chức với mạng xã hội. Crove chỉ gửi nội dung tổ chức đã duyệt. [Luật sư xác nhận, câu hỏi 4.]
- **Kênh trò chuyện nhóm của tổ chức** cho mô-đun Social, do tổ chức tự cài. Mỗi tin nhận tối đa 400 ký tự của bài viết.
- **Supabase Auth** khi chạy cùng máy chủ trong bộ `docker compose`. Khi đó nó là phần mềm của đơn vị vận hành, không phải một bên khác. Nếu dùng Supabase dạng dịch vụ đám mây thì thêm vào bảng trên.
