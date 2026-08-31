# CDR 话单工具

CDR 是 Server Workbench 内嵌的 FastAPI 模块，用于加载 NDJSON 话单、浏览筛选、单条/批量修改、批量造数和导出校验。源文件始终只读，修改只存在于当前内存会话。

## 使用流程

1. 在工作台点击「话单工具」，选择源目录中的 `.json` 文件并加载。
2. 在记录浏览区按业务类型或字段筛选，点击「编辑」修改单条记录。
3. 批量修改必须添加筛选条件；先预览转换结果，再应用同一份预览。没有筛选条件会被后端拒绝。
4. 批量造数先填写模板 `idx` 和复制份数，界面显示新增量/最终总量；会话最多 100,000 条，超限直接拒绝。
5. 导出会写入同目录临时文件，完成 JSON、`TICKET_COUNT`、ID 唯一性和时间格式校验后原子替换；失败不会覆盖旧文件。

## 数据与并发约束

- NDJSON 逐行解析，只接受对象记录；非法 JSON 会报告行号，解析完整成功后才替换当前会话。
- `GET /api/session` 返回当前文件、总量、revision、dirty 和撤销状态。修改、批量应用、造数、撤销、导出可携带 `expected_revision`；版本不一致返回 HTTP 409 `REVISION_CONFLICT`。
- 混合整数/浮点字段推断为 float；生成 ID 使用 O(1) 唯一性索引，避免跳号；非数字 ORG ID 后缀会安全回退。
- 撤销栈深度和变更数量均有预算，避免无限膨胀。10 万条规模继续使用内存模型。

## 独立运行

```powershell
python -m pip install -r requirements.txt
python server.py
```

默认监听 `127.0.0.1:8000`，可用 `CDR_PORT`、`CDR_SOURCE_DIR`、`CDR_OUTPUT_DIR`、`CDR_MAX_RECORDS` 等环境变量覆盖。工作台通过 `/cdr/` 同源代理嵌入；直接访问 `http://127.0.0.1:8000` 也可调试。

## 质量检查

在项目根目录运行 `npm run test:python`。测试使用临时目录和 fixture，不需要真实凭据或远程服务。
