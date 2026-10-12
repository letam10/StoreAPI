# AI local

Store dùng Ollama local qua ASP.NET Core trong Visual Studio và Node tại `backend/server/`.
Frontend chỉ gọi `/api` ở cổng ASP.NET Core 3010, không gọi Ollama trực tiếp.

- Model mặc định: `qwen3.5:4b`.
- Cùng một model phục vụ khách và admin; backend quyết định `think`.
- Không tải model vào `src/` hoặc `public/`.
- `models/`, `datasets/`, `checkpoints/`, `outputs/`, `work/` đã bị ignore.
- Không đưa secrets, database thật hoặc hội thoại riêng tư vào Git.
- LoRA/training **không nằm trong phạm vi đợt triển khai này**; `training/` chỉ là placeholder cũ.
- Benchmark GPU dài chỉ chạy khi được chủ dự án đồng ý. Kết quả RTX 4060 không được ghi thành kết quả RTX 3050 6GB.
