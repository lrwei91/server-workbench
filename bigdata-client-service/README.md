# HDFS/HBase 常驻客户端服务

该服务部署在可访问目标集群的内网机器上，仅监听 `127.0.0.1`。工作台 Node 进程通过现有 SSH 会话的 `forwardOut` 通道访问，不对局域网公开端口。

## 部署前提

1. 使用运维提供、与集群发行版完全一致的 Hadoop/HBase 客户端 JAR；本目录不固定版本。
2. 把 `core-site.xml`、`hdfs-site.xml`、`hbase-site.xml`、`krb5.conf` 和 keytab 放在服务机器的受控目录，keytab 不进入仓库。
3. 服务账号需能读取上述文件，并能解析 NameNode、DataNode、ZooKeeper、RegionServer、KDC 主机名。
4. JDK 版本以集群客户端要求为准。

## 编译与启动

```bash
export CLIENT_CLASSPATH="$(hadoop classpath):$(hbase classpath)"
./build.sh
cp service.env.example service.env
# 编辑 service.env 后启动；脚本会自动复用集群客户端 classpath：
./start.sh
./status.sh
# 停止服务：./stop.sh
```

服务配置与工作台配置分离：本服务读取集群 XML、principal 和 keytab；工作台 `.env` 只保存远端监听地址、端口和服务 Token。Token 应使用高强度随机值，两边保持一致。

## 固定接口

- `GET /health`
- `POST /v1/hdfs/list`
- `POST /v1/hdfs/preview`
- `GET /v1/hdfs/download?path=...`
- `POST /v1/hdfs/upload`（服务器本地文件复制到 HDFS，不覆盖同名文件）
- `POST /v1/hdfs/delete`（文件或空目录，禁止递归删除）
- `POST /v1/hbase/list`（仅命名空间/表列表缓存，默认 30 秒）
- `POST /v1/hbase/scan`（最多 200 行）
- `POST /v1/hbase/get`（RowKey 精确查询）
- `POST /v1/requests/cancel`

除下载外，POST 参数使用 `application/x-www-form-urlencoded`。所有接口要求 `Authorization: Bearer TOKEN`。服务日志只记录接口、耗时、状态与返回规模，不记录凭据、路径、RowKey 或业务内容。

## 上线验收

先以 `BIGDATA_CLIENT_DEFAULT_MODE=ssh` 启动工作台，在连接设置中手动连接客户端服务。分别记录首次 Kerberos 登录、热连接、列表缓存命中和强制刷新；使用有数据的测试表核对 scan/get 与旧链路结果。验收后再把默认方式改为 `client`。
