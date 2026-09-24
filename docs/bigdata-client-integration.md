# HDFS/HBase 常驻客户端接入

## 架构

浏览器继续调用工作台既有 HDFS/HBase API。Node 根据用户显式选择调用旧 SSH CLI，或通过 SSH `forwardOut` 访问内网机器 `127.0.0.1` 上的 Java 服务；若 sshd 禁止 `direct-tcpip`，则自动使用固定 `nc` exec channel 作为同一 SSH 加密会话内的字节流。Java 服务常驻复用 Hadoop `FileSystem` 与 HBase `Connection`，每次请求关闭文件流、`Table`、`ResultScanner` 和 `Admin`。

旧链路保留用于人工回退。客户端连接、SSH 连接和数据库连接分别展示状态；客户端故障只报错并提示切换，不自动改变数据来源。

## 工作台配置

```dotenv
BIGDATA_CLIENT_REMOTE_HOST=127.0.0.1
BIGDATA_CLIENT_REMOTE_PORT=17880
BIGDATA_CLIENT_TOKEN=使用随机高强度值
BIGDATA_CLIENT_DEFAULT_MODE=ssh
BIGDATA_CLIENT_TIMEOUT_MS=30000
BIGDATA_CLIENT_LIST_CACHE_MS=30000
```

首期保持默认 `ssh`。部署服务并核对结果后，可把默认方式改为 `client`。页面只显示 Token 是否配置。

## 内网服务资料清单

部署前由搭建者或运维确认：

1. 可部署机器、运行账号、JDK 版本、部署目录和 systemd/其他启动管理方式。
2. Hadoop、HBase 的准确版本与厂商发行版，以及可直接使用的客户端 classpath/安装包。
3. `core-site.xml`、`hdfs-site.xml`、`hbase-site.xml`、`krb5.conf` 的受控路径。
4. principal、keytab 路径、文件读取权限和续期要求；keytab 不进入聊天、仓库或工作台 `.env`。
5. 到 NameNode、DataNode、ZooKeeper、RegionServer、KDC 的网络与主机名解析。
6. 一个小目录、小文件、有数据的测试表和精确 RowKey；核对集群是否确为 `jfhdp3`。

## 实时性与限制

- HDFS 目录/预览/下载/上传/非递归删除、HBase scan/get：实时操作。上传不覆盖同名文件，目录删除仅接受空目录。
- HBase 命名空间/表列表：缓存 30 秒；页面“刷新”传递 `refresh=true` 绕过缓存。
- HBase scan 上限 200 行；HDFS preview 上限 256 KiB。
- Node 请求取消或超时会关闭 SSH channel，并调用服务取消接口；Java 服务取消对应 Future 并在扫描/流复制中检查中断。
- Java 服务对二进制 HBase Value 使用 `base64:` 摘要，结构化 `rows` 保留列族、Qualifier、时间戳和编码；兼容 `text` 继续供现有业务解析与复制使用。
- 日志只记录路由、耗时、结果状态和返回规模，不记录 Token、路径、RowKey 或业务内容。

## 验收记录

在同一机器、同一目标、相同读取数量下分别记录旧链路、客户端冷连接、客户端热连接、缓存命中和强制刷新。使用有数据表核对 scan/get 一致性，目标为热连接小目录、RowKey 查询和 20 行扫描端到端 P95 不高于 2 秒；首次 Kerberos 登录单独统计。

当前测试环境已确认的部署基线：Hadoop `3.1.1.3.1.4.0-315`、HBase `2.0.2.3.1.4.0-315`、JDK `1.8.0_202`。服务端使用集群安装自带的 `hadoop classpath` 与 `hbase classpath`，配置文件路径为 `/etc/hadoop/conf/core-site.xml`、`/etc/hadoop/conf/hdfs-site.xml`、`/etc/hbase/conf/hbase-site.xml` 和 `/etc/krb5.conf`。principal 与 keytab 路径仅写入部署机的 `service.env`，不进入仓库。

2026-09-18 已部署到测试服务器 `/data/cnos_jf/server-workbench-bigdata-client`，仅监听 `127.0.0.1:17880`，并配置用户级 `crontab @reboot` 启动。该服务器的 sshd 禁止 `direct-tcpip`，工作台实际通过固定 `nc` exec channel 访问。验收目标为 `HDFS /apps`（18 项）以及 `ns_bill_cnos_jf_test:rating_batch_major_info` 的 RowKey `1000000008`；热连接下工作台 API 实测 HDFS 列表约 0.6 秒、HBase 表列表约 0.8 秒、RowKey 精确查询约 0.6 秒。首次 HDFS NameNode 建连发生约 60 秒冷启动，后续请求恢复到目标范围。
