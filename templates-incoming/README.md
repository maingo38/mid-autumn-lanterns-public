# 🏮 Bỏ template lồng đèn vào đây

Đây là chỗ bạn **thả file template lồng đèn** vào. Sau đó chạy 1 lệnh, hệ thống
tự biến chúng thành template dùng được trong app (line-art + mask).

## Cách làm — 3 bước

### Bước 1 — Thả file vào folder này
Mỗi lồng đèn là **1 file**. Đặt tên bằng chữ thường, không dấu, không cách:

```
templates-incoming/
  ong-sao.png
  ca-chep.png
  tron.svg
```

Định dạng nhận được: **PNG, JPG, hoặc SVG**.

### Bước 2 — Chạy lệnh xử lý
```bash
cd ~/Desktop/mid-autumn-lanterns
python3 process_templates.py
```

Lệnh này với mỗi file sẽ tạo ra 2 file trong `public/templates/`:
- `<tên>_lines.png` — nét vẽ để bé tô màu
- `<tên>_mask.png`  — hình đặc để cắt gọn phần tô lem ra ngoài

### Bước 3 — Dùng trong app
Mở template cụ thể trên điện thoại bằng `?t=<tên>`:
```
http://<ip-laptop>:3000/?t=ca-chep
```
Mỗi trạm tô màu dán 1 QR theo tên template tương ứng.

---

## Template nên trông thế nào (để ra đẹp nhất)

**Lý tưởng nhất:** file có **nền trong suốt** (PNG/SVG), chỉ có hình lồng đèn
(viền + có thể có chi tiết), xung quanh trong suốt.
→ Hệ thống dùng vùng không-trong-suốt làm mask, rất chuẩn.

**Cũng được:** ảnh lồng đèn trên **nền trắng**.
→ Hệ thống sẽ coi vùng trắng là nền và tự cắt. Nền càng sạch càng tốt.

**Mẹo:**
- Hình càng to càng nét — nên **≥ 700px** chiều lớn nhất.
- Viền rõ ràng, khép kín thì bé tô không bị "tràn".
- Nếu bạn đã có sẵn cả 2 lớp (viền riêng + hình đặc riêng), đặt tên
  `<tên>_lines.png` và `<tên>_mask.png` rồi copy thẳng vào `public/templates/`
  — khỏi cần chạy script.

Cứ thả file vào rồi báo tôi, tôi chạy xử lý và kiểm tra kết quả cho.
