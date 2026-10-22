# Mẫu thông báo vi phạm dữ liệu cá nhân

> **BẢN NHÁP, CHƯA ĐƯỢC LUẬT SƯ RÀ SOÁT.** Không gửi nguyên văn. Mẫu này đi kèm các bước nội bộ ở [incidents.md §9](../../runbooks/incidents.md). Luật sư xác nhận: cơ quan nhận, thời hạn, biểu mẫu bắt buộc theo Nghị định 356/2025/NĐ-CP và ai ký. Các chỗ trong ngoặc vuông cần điền. Câu hỏi cho luật sư nằm trong [README.md](README.md).

Có hai thông báo, vì hai bên có vai trò khác nhau:

- **Thông báo A**, gửi cơ quan chuyên trách bảo vệ dữ liệu cá nhân. Bên gửi là bên kiểm soát dữ liệu. Với dữ liệu tài khoản người dùng, đơn vị vận hành Crove là bên kiểm soát. Với dữ liệu trong sổ sách của tổ chức, bên kiểm soát là tổ chức (công ty dịch vụ kế toán). Khi đó đơn vị vận hành báo cho tổ chức theo thông báo B và hỗ trợ tổ chức gửi thông báo A. [Luật sư xác nhận cách chia này, câu hỏi 5.]
- **Thông báo B**, gửi tổ chức bị ảnh hưởng (bên kiểm soát), theo Phụ lục xử lý dữ liệu ([dpa.vi.md](dpa.vi.md), mục 7).

Thời hạn: [72 giờ] kể từ khi phát hiện vi phạm, không phải kể từ khi chủ sở hữu được báo. Khi chưa đủ thông tin, gửi trước những gì đã biết rồi bổ sung sau. [Luật sư xác nhận thời hạn và việc gửi bổ sung theo Nghị định 356.]

## Thông báo A: gửi cơ quan có thẩm quyền

Kính gửi: [tên cơ quan chuyên trách bảo vệ dữ liệu cá nhân, Bộ Công an, theo Nghị định 356]

**Bên thông báo:** [tên đơn vị], mã số thuế [...], địa chỉ [...]. Vai trò: [bên kiểm soát / bên kiểm soát và xử lý] dữ liệu cá nhân.

**Người liên hệ:** [họ tên, chức vụ, điện thoại, email]. Người phụ trách bảo vệ dữ liệu cá nhân: [họ tên].

1. **Mô tả vi phạm:** điều gì đã xảy ra, ví dụ lộ khóa bí mật, truy cập trái phép, lỗi phần mềm hiển thị dữ liệu của tổ chức này cho tổ chức khác, hoặc mất bản sao lưu. Ghi thêm cách phát hiện.
2. **Thời điểm:** xảy ra lúc [ngày giờ, hoặc khoảng thời gian], phát hiện lúc [ngày giờ]. Nếu gửi muộn hơn thời hạn, nêu lý do.
3. **Loại dữ liệu cá nhân liên quan:** [họ tên, email, số điện thoại, địa chỉ, mã số thuế cá nhân, thông tin trên hóa đơn và chứng từ, số tài khoản ngân hàng, nhật ký đăng nhập]. Ghi rõ có dữ liệu cá nhân nhạy cảm hay không.
4. **Số lượng:** khoảng [số] chủ thể dữ liệu và [số] bản ghi, thuộc [số] tổ chức.
5. **Hậu quả có thể xảy ra:** [ví dụ: lừa đảo bằng thông tin hóa đơn, lộ thông tin tài chính của hộ kinh doanh].
6. **Biện pháp đã thực hiện:**
   - ngăn chặn: thu hồi khóa, đăng xuất phiên, tắt tính năng bằng công tắc khẩn cấp;
   - lưu giữ bằng chứng;
   - khắc phục.
7. **Biện pháp tiếp theo:** những gì sẽ làm tiếp, và thời điểm dự kiến.
8. **Thông báo cho chủ thể dữ liệu:** đã báo, sẽ báo hay không cần báo, và lý do.

[Địa điểm], ngày [...]. Đại diện bên thông báo: [ký, ghi rõ họ tên, đóng dấu]

## Thông báo B: gửi tổ chức bị ảnh hưởng

Tiêu đề email: **[Crove] Thông báo sự cố dữ liệu cá nhân liên quan đến [tên tổ chức]**

Kính gửi [người đại diện tổ chức],

Lúc [ngày giờ], chúng tôi phát hiện một sự cố an ninh có thể ảnh hưởng đến dữ liệu cá nhân trong tài khoản Crove của [tên tổ chức].

- **Điều đã xảy ra:** [mô tả ngắn, không nêu chi tiết giúp kẻ tấn công].
- **Dữ liệu có thể bị ảnh hưởng:** [loại dữ liệu], của khoảng [số] người, trong thời gian [từ ... đến ...].
- **Những gì chúng tôi đã làm:** [ngăn chặn, khắc phục].
- **Những gì quý tổ chức nên làm:** [ví dụ: đổi mật khẩu, kiểm tra nhật ký hoạt động trong Cài đặt, cảnh giác với email hoặc cuộc gọi giả danh đối tác].
- **Thông báo tới cơ quan có thẩm quyền:** quý tổ chức là bên kiểm soát dữ liệu trong sổ sách của mình. Chúng tôi gửi kèm các thông tin cần cho thông báo A và sẵn sàng hỗ trợ soạn thông báo đó trong thời hạn [72 giờ] kể từ [thời điểm phát hiện].

Chúng tôi sẽ cập nhật cho quý tổ chức khi có thêm thông tin, chậm nhất vào [ngày giờ].

Liên hệ: [họ tên], [điện thoại], [email].

[Tên đơn vị vận hành]

## Ghi nhận nội bộ

Lưu cùng hồ sơ sự cố (issue theo bước 7 của [incidents.md §9](../../runbooks/incidents.md)):

- bản đã gửi của thông báo A và B, cùng thời điểm gửi;
- người quyết định gửi;
- ý kiến của luật sư.
