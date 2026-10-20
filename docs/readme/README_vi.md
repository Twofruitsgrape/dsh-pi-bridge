[English](../../README.md) · **Tiếng Việt**

# dsh-pi-bridge

Một plugin, hai máy chủ. Cài vào pi, pi dùng được plugin của DeepSeek Harness; cài vào DSH, DSH dùng được plugin của pi. Không bên nào chạy mã của bên kia bằng cách "dịch" nó: plugin luôn chạy trong chính máy chủ của nó — API của máy chủ ở đó là thật — bên còn lại chỉ chuyển tiếp các lời gọi.

```text
# pi
pi install npm:dsh-pi-bridge            # hoặc: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Khởi động lại máy chủ sau khi cài. Cả hai từ khóa (`pi-package` và `dsh-plugin`) đều được khai báo, nên chợ của mỗi hệ sinh thái đều tìm thấy gói này.

## Bạn nhận được gì trong mỗi máy chủ

| | pi | DSH |
|---|---|---|
| Dùng plugin của bên kia | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Quản lý nội dung đã nối cầu | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | cùng một `SKILL.md`, được gắn qua sổ đăng ký skill |

Hai bên dùng chung một văn phạm nguồn: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL kho mã hoặc đường dẫn cục bộ — đúng những định dạng mà mỗi máy chủ vốn chấp nhận.

Một đoạn của buổi hội thoại thật, ghi lại nguyên văn: khởi động DSH thật, mô hình thật, cài một gói pi thực sự được phát hành.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # một công cụ đến từ gói pi
  -> kết quả tìm kiếm thời gian thực, do provider của chính gói lấy với cấu hình của nó
```

## Cách hoạt động

### Plugin pi vào DSH: một tiến trình pi được giám sát

`pi_install` hiện thực hóa gói vào bộ nhớ đệm của cầu, cài các phụ thuộc thật của nó, rồi nạp nó trong một tiến trình pi (`pi --mode rpc`) do cầu giám sát. Mọi mục pi báo cáo đều trở thành một công cụ trong DSH; lời gọi được chuyển sang pi và trả về kết quả do pi tính ra. Thư mục `SKILL.md` được gắn như dữ liệu qua `ctx.skills`. Gói nhìn thấy `registerTool`, `registerProvider`, sổ đăng ký mô hình và thông tin xác thực provider thật của pi — một gói truy cập mạng hay mô hình sẽ hành xử y hệt như trong tay người dùng pi.

Thiết kế này thay thế cho cách tiếp cận trước đó: phát lại các mục đăng ký vào DSH và dựa vào import được thay bằng stub. Bản đó vượt mọi bài test bằng mô hình giả lập rồi sụp đổ trước gói thật — vì một import stub là một công cụ không vận hành được. Chuyển tiếp vào máy chủ bản địa là hình thức duy nhất có thể vẫn trung thực với kết quả.

### Plugin DSH vào pi: một phiên DSH đang sống

Một bundle của DSH đòi hỏi `ctx.tools`, `ctx.llm` thật và sổ đăng ký skill, nên `dsh_install` hỏi phiên DSH đang sống tự nạp bundle. Chướng ngại nằm ở đây: bundle do trình quản lý plugin cài là một symlink dưới `node_modules` của hồ sơ, và các chỉ định trần `@deepseek-ai/*` không phân giải được — phép đo đã báo `MODULE_NOT_FOUND`. Đúng vì thế mà `src/dsh-loader.js` viết lại các chỉ định đó thành URL của những mô-đun mà bản build đang chạy mang theo (gói thật, không phải stub); import tương đối, `node:` và import của bên thứ ba giữ nguyên. Bundle đăng ký với máy chủ, và pi nhận một công cụ chuyển tiếp cho từng capability.

Điểm cuối mặc định đóng; một lần khởi động DSH bình thường không mở cổng nào:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # phía DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # phía pi
```

Chỉ gán vào 127.0.0.1 và máy khách từ chối địa chỉ ngoài loopback. Khi không chạm tới được một DSH đang sống, `dsh_install` nói thẳng điều đó và quay về chế độ dịch, thay vì giả vờ chuyển tiếp đã thành công.

### Khi cả hai máy chủ đều không chạm được

Cầu vẫn giải mã nguồn, biên dịch TypeScript (`stripTypeScriptTypes` của `node:module`, không cần tải chuỗi công cụ) và ghi lại cái gói sẽ đăng ký, nên `preview` hoạt động ở mọi nơi. Việc phát lại mục đăng ký sang máy chủ khác được giữ cho kịch bản cùng máy chủ và cho các bundle có toàn bộ tải là dữ liệu — một bundle DSH thuần thư mục skill không có gì để gọi, nhưng bản thân skill vẫn đi qua. Cả hai máy chủ đều cài đặt [đặc tả Agent Skills](https://agentskills.io/specification).

### Biên dạng của tham số và kết quả

Công cụ của DSH mang bảng chỉ định thuộc tính (`{ text: { type: "string", required: true } }`) mà `@deepseek-ai/dsh-tools` biên dịch thành JSON Schema; công cụ của pi mang JSON Schema ngay từ đầu (TypeBox). `src/schema.js` chuyển đổi hai chiều, và kết quả đi qua cùng phép chiếu: `{ content: [{ type: "text" }] }` của pi và `{ ok, result }` của DSH đổi cho nhau. Máy chủ kiểm nghiệm lược đồ tại lúc đăng ký, và tập con được nhận hẹp hơn dự thảo JSON Schema — một mốc `required` trên nút thuộc tính, hoặc mảng `required` cấp đối tượng trong lược đồ đầu ra, làm toàn bộ plugin không thể kích hoạt. Những quy tắc này đến từ phép đo với máy chủ đã cài; bộ test ghi chúng thành mệnh đề khẳng định.

## Đã kiểm chứng — và cách kiểm chứng

Từng mục dưới đây được đo với máy chủ thật, không phải với mô hình giả lập:

- Khởi động DSH thật, mô hình thật, cài `npm:pi-web-access` và gọi `web_web_search` qua nó (kết quả do provider của chính gói thu thập)
- Một phiên DSH thật nạp bundle có import trần `@deepseek-ai/dsh-tools`, sau đó một tiến trình riêng gọi các công cụ của nó qua loopback
- Cầu này chạy lối vào DSH của chính nó bằng đúng cơ chế mà một bundle ngoại lai gặp trong pi

Mỗi mục trong số đó đều bắt được một lỗi mà mô hình giả lập nào cũng bắt không được: một file mà bản kê khai phát hành bỏ sót; một lược đồ đầu ra mà máy chủ từ chối, khiến plugin âm thầm tê liệt; `process.execPath` trong tiến trình máy chủ chỉ về ứng dụng chứ không phải node; báo cáo bằng không capability khi cài lại vì demôn đã nạp gói từ trước; một scope cấm gán thuộc tính; một server handler chạy ngoài fiber khởi động dịch vụ; máy chủ từ chối tên công cụ trùng lặp.

```bash
npm test                # đầy đủ các bộ offline
npm run test:offline    # pipeline + lối vào máy chủ của hai bên
npm run test:proxy      # daemon, chuyển tiếp phía DSH và phía pi
npm run test:host       # với bản build DSH đã cài (xem ghi chú)
npm run test:network    # gói thực sự phát hành từ npm và GitHub
npm run test:live       # các phép thử nêu trên đối với pi đang thật sự chạy
```

`test:host` đọc `@deepseek-ai/dsh-tools` của chính máy chủ từ bên trong asar của máy chủ đã cài; chỉ fs vá Electron mới đọc được, hãy chạy nó trong tiến trình máy chủ. Dưới node thường nó báo SKIP rõ ràng, không hàm ý máy chủ đã từ chối chúng ta.

Các bộ offline tự tay dựng tốt kiểm thử — một mở rộng pi viết bằng TypeScript dùng builder TypeBox, một bundle DSH dùng `defineTool`, một bundle có import trần gói của máy chủ — rồi cho toàn bộ pipeline chạy đối với stub đã ghi, và thật sự chạy các công cụ chui ra từ cầu. Vài quy tắc sống dưới dạng mệnh đề tĩnh, vì chúng chỉ lộ diện khi khởi động thật: các dạng lược đồ mà máy chủ chấp nhận; các file bắt buộc phải phát hành; việc một bundle đang bị phân tích không được khởi tiến trình hay gán cổng.

## Cái gì không sang bên kia

Cầu báo cáo các trường hợp này một cách trung thực thay vì âm thầm thất bại:

- **Giao diện của máy chủ**: trang trình duyệt của DSH / `ctx.slots`; bộ vẽ TUI của pi, `ctx.ui`, tổ hợp phím, cờ CLI.
- **Bộ thích ứng mô hình đăng ký vào máy chủ**: ai thêm provider là thêm với chính máy chủ của mình — đó chính là nghĩa của "không dịch" — provider của pi đáp xuống pi, adapter của DSH đáp xuống DSH.
- **Bundle DSH không có gì để gọi**: một lớp phủ thuần giao diện hay thuần cài đặt không có công cụ để chuyển tiếp. Preview nói rõ điều đó, thay vì bịa ra capability.
- **Gói đòi hỏi máy chủ tương tác**: lời gọi chuyển tiếp có thể phát trực tuyến tiến độ, nhưng không thể làm bật một trình chọn ở bên kia.

## Trân tồn

Các mục đăng ký lập tức rơi vào phiên hiện thời. Mỗi máy chủ, khi nạp plugin, đọc lại từ `~/.dsh-pi-bridge/bridges.json` cái mà chính nó đã ghi chép, nên cài đặt sống qua lần khởi động lại — đã kiểm chứng bằng cách khởi động lại một phiên DSH và tìm thấy các công cụ của cầu tại chỗ. Lần đọc lại chỉ đọc bộ đệm: khởi động máy chủ không bao giờ chờ tải xuống qua mạng; nếu bộ đệm bị dọn, cầu báo không sẵn sàng thay vì treo. Khởi động lại cũng khiến công cụ mới hiện ra với các máy khách khác (GUI web, cửa sổ thứ hai), vì chúng ghép danh sách công cụ lúc khởi động. Tắt được bằng `restoreOnLoad: false` trong cấu hình bundle.

Chúng ta không ghi vào cài đặt của bất kỳ máy chủ nào. `bridge_remove` quên một cây cầu và dọn thư mục build của nó; các công cụ đã đăng ký trong tiến trình đang chạy còn lại đến lúc khởi động lại, vì âm thầm hủy đăng ký trạng thái của máy chủ còn tệ hơn để chúng hiện hình.

## Bảo mật

Một gói được nối cầu **chạy mã với quyền của bạn, ở máy chủ nơi nó vận hành**. Mọi máy chủ mở rộng đòi yêu cầu tương tự; gói này đến từ một hệ sinh thái khác và chưa qua thẩm định của chợ đó, nên yêu cầu càng nặng thêm. Đọc mã nguồn của nó trước; `preview` chỉ phân tích và thẩm tra, không đăng ký gì cả.

Chuyển tiếp không phải sandbox: gói chạy với trọn vẹn niềm tin của chính máy chủ của nó — vì thế nó mới hoạt động. Điểm cuối loopback chỉ gán vào 127.0.0.1, chỉ mở khi `DSH_PI_BRIDGE_DSH_SERVE` được đặt, và máy khách từ chối địa chỉ ngoài loopback. Ai chạm tới cổng đó đều có thể gọi bất kỳ công cụ nào phiên đã nạp. Đừng mở cổng khi không cần.

## Bố cục

```text
index.js                lối vào DSH: name / inject / apply(ctx), tức các công cụ pi_*
extensions/index.js     lối vào pi: nhà máy default(pi), công cụ và lệnh dsh_*
skills/dsh-pi-bridge/   SKILL.md, hai máy chủ chung
cordis.patch.yml        gắn bundle DSH (mục tiêu công tắc trên bảng plugin)
daemon/run.mjs          tiến trình pi được giám sát; mặt tiền loopback của các công cụ của nó
daemon/bootstrap.js     được bộ nạp mở rộng thật của pi nạp vào trong pi
src/proxy.js            phía DSH: khởi động/tái dùng daemon, chuyển tiếp lời gọi
src/dsh-loader.js       phía DSH: nạp bundle lúc chạy đối với scope đang sống
src/serve.js            phía DSH: điểm cuối loopback cho máy chủ kia
src/dsh-host-client.js  phía pi: nói chuyện với phiên DSH đang sống
src/resolve.js          nguồn npm / git / url / cục bộ vào bộ đệm, kèm cài phụ thuộc
src/load.js             dựng cây gương, biên dịch TS, cài phụ thuộc thật
src/manifest.js         nhận diện máy chủ qua từ khóa, bản kê khai và hình dáng thư mục
src/capture.js          máy chủ stub đã ghi cho cả hai quy ước lối vào
src/schema.js           chuyển đổi hai chiều lược đồ tham số
src/capabilities.js     mô hình capability chuẩn hóa; phép chiếu kết quả
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          đọc lại các cầu đã ghi lúc máy chủ khởi động
src/stubs.js            quét import và tạo stub cho preview
src/tar.js              trình đọc tar gzip, không phụ thuộc
src/transpile.js        TypeScript -> ESM, qua node:module
```

`index.js` chỉ import các built-in của `node:` cùng chính gói, và tuyên bố `inject: ["tools"]` — dịch vụ duy nhất nó cần. Skill và cài đặt chạm được qua `ctx.inject` sau khi qua phép kiểm capability; một hồ sơ không có sổ đăng ký skill chỉ đơn giản không gắn skill, chứ không đổ vỡ lúc khởi động.

## Giấy phép

MIT
