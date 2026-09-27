# Trang Giấy

Ứng dụng đọc PDF trên trình duyệt, tối ưu cho điện thoại. PDF được xử lý hoàn toàn ở phía client bằng PDF.js và không được tải lên máy chủ.

## Tính năng

- Reflow nội dung PDF thành văn bản vừa màn hình
- Tăng/giảm cỡ chữ và khoảng cách dòng
- Giao diện sáng, màu giấy và tối
- Chế độ xem trang PDF gốc
- Tìm kiếm toàn văn và chuyển nhanh giữa các trang
- Bôi đen từ và lưu thẳng vào một bộ từ trên Voca, kèm câu ngữ cảnh và số trang
- Kéo thả file trên máy tính; file picker trên điện thoại
- Ghi nhớ thiết lập đọc trên thiết bị

> Reflow hoạt động với PDF có lớp văn bản. PDF scan chỉ gồm ảnh sẽ được mở ở chế độ trang gốc; OCR chưa được tích hợp.

## Kết nối Voca

1. Trong Voca, vào **Cài đặt → Ứng dụng kết nối** và tạo API key riêng cho Trang Giấy.
2. Mở nút **Voca** trên thanh đầu trang, nhập key và chọn bộ từ mặc định.
3. Trong chế độ **Văn bản**, bôi đen một từ. Trên máy tính, nhấn chuột phải và chọn **Lưu vào Voca**. Trên điện thoại, chạm nút **Lưu vào Voca** xuất hiện cạnh vùng chọn.

API key chỉ được lưu trong `localStorage` của trình duyệt và được gửi trực tiếp tới `https://voca-zeta-five.vercel.app`; server Flask không nhận hoặc lưu key.

## Chạy local

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
flask --app app run --debug
```

Mở `http://127.0.0.1:5000`.

## Deploy lên Vercel

Vercel tự nhận diện `app.py` và Flask, không cần cấu hình build riêng. Import repository vào Vercel và deploy, hoặc dùng CLI (bản 48.2.10 trở lên):

```bash
npm i -g vercel
vercel
```

Thư mục `public/` được Vercel phục vụ trực tiếp qua CDN. PDF.js đã được đóng gói cùng ứng dụng; chỉ font trang trí được tải từ Google Fonts và có font hệ thống để dự phòng.
