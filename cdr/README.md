# 话单文件数据调整工具

本地 Web 工具，用于浏览、修改、批量造数电信计费测试话单文件（NDJSON 格式，JF 混合话单 / OCG 上网话单），导出时自动重算 `TICKET_COUNT` 统计行并做完整性校验。

## 快速开始

> 本工具已整合进远程服务器管理工作台（`server-workbench/`），推荐通过工作台使用：
> 双击工作台根目录的 `start.bat` → 工作台右上角【话单工具】按钮 → 弹窗内操作。
> 工作台会自动拉起本后端服务（端口 8000），无需单独启动。

如需独立运行（脱离工作台调试）：

1. **首次安装依赖**（一次即可）：
   ```
   C:\Users\lrwei\.workbuddy\binaries\python\envs\default\Scripts\pip.exe install -r requirements.txt
   ```
   离线环境加清华镜像：`-i https://pypi.tuna.tsinghua.edu.cn/simple`

2. **启动**：命令行：
   ```
   C:\Users\lrwei\.workbuddy\binaries\python\envs\default\Scripts\python.exe server.py
   ```
   仅拉起后端服务（不自动开浏览器、不自动顺延端口），固定监听 127.0.0.1:8000。
   端口通过环境变量 `CDR_PORT` 指定（与工作台 `config.js` 的 `config.cdr.port` 保持一致）。
   浏览器访问 http://127.0.0.1:8000 可直接查看话单工具界面。

3. 关闭启动窗口 = 退出服务。

## 使用流程（加载 → 改数/造数 → 导出）

### 1. 加载文件
- 下拉选择 `数据\话单文件\` 下的 *.json 文件，点「加载」
- 查看统计：总记录数、TICKET_COUNT 统计行、各业务类型条数（JF 自动按 SOURCE_TYPE_ID 识别 6 类业务）

### 2. 浏览与筛选
- 顶部 Tab 按业务类型切换（SP增值短信 / 家宽上网 / IMS / 流媒体 / 点对点短信 / 智能网4008 / 上网流量OCG）
- 「+ 条件」添加字段筛选（等于/不等于/包含/小于/大于/介于/属于，多条件 AND）
- 列显示可切「常用字段 / 全部字段」；每页 50/100/200 条

### 3. 修改记录
- **单条**：点击表格行 → 右侧抽屉编辑任意字段 → 保存（类型/时间格式/ID 唯一性自动校验，错误整体回滚）
- **批量**：操作区「批量修改」→ 构造匹配条件 + 目标「字段=新值」→ 先「预览」再「应用」
- 批量修改跳过：该业务类型不存在的字段、ID 字段（CDR_KEY/COLLECT_CDR_ID 请单条编辑）
- 所有修改可「撤销」（栈深度 50）

### 4. 批量造数
- 在记录表格勾选 1 条或多条模板（右上角显示已选数）
- 设置每模板份数、ID 重生成开关（默认全开，保证 CDR_KEY/COLLECT_CDR_ID 唯一）
- 可选字段变换规则：设固定值 / 随机手机号 / 号码递增 / 随机整数区间 / 时间偏移(秒) / UUID
- 点「生成」，新记录追加到会话末尾，可撤销

### 5. 导出
- 输出目录默认 `outputs\cdr_tool\`，文件名自动带时间戳（可自定义）
- 导出自动：重算 TICKET_COUNT、校验 记录数一致 / CDR_KEY 唯一 / COLLECT_CDR_ID 唯一 / 时间格式 / 回读可解析
- 校验报告全绿 = 导出文件可直接投递测试；**源文件始终只读，不会被修改**

## 目录结构

> 已整合进远程服务器管理工作台（`server-workbench/`），作为「话单工具」后端运行；
> 由工作台 `start.bat` 统一拉起，无需单独启动。

```
server-workbench\cdr\
├── server.py         # 服务入口（uvicorn；端口由 CDR_PORT 环境变量指定，默认 8000）
├── config.py         # 模块配置（路径常量 + 端口，与工作台 config.js 口径一致）
├── app.py            # FastAPI 路由
├── engine.py         # 核心引擎（解析/会话/校验/变换/导出）
├── static\           # 前端页面（原生 JS/CSS，零 CDN，离线可用）
└── data\logs\        # 操作日志（JSONL）
```

## 注意事项

1. **源文件只读**：工具仅读取 `数据\话单文件\`，所有修改只存在于内存，导出才落盘。
2. **造数唯一性**：新记录 COLLECT_CDR_ID = 会话内 max+1 递增；CDR_KEY 按真实格式 `{SWITCH_ID}_0_{ORG_CDR_ID前12位}_{ORG_CDR_ID后8位去前导零}_{序号}_00` 生成；OCG 的 ORG_CDR_ID 与 COLLECT_CDR_ID 镜像同步。
3. **时间格式**：CJ 系 14 位 `YYYYMMDDHHMMSS`；ORG 系 12 位 `YYMMDDHHMMSS`+2 位尾数（PROC_TIME 同 ORG 风格）。修改/偏移自动按格式处理。
4. **多文件**：一次加载一个文件，切换文件会清空当前会话（导出前请确认已加载正确文件）。
