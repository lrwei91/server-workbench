package com.serverworkbench.bigdata;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.FSDataInputStream;
import org.apache.hadoop.fs.FileStatus;
import org.apache.hadoop.fs.FileSystem;
import org.apache.hadoop.fs.Path;
import org.apache.hadoop.hbase.Cell;
import org.apache.hadoop.hbase.CellUtil;
import org.apache.hadoop.hbase.HBaseConfiguration;
import org.apache.hadoop.hbase.NamespaceDescriptor;
import org.apache.hadoop.hbase.TableName;
import org.apache.hadoop.hbase.client.Admin;
import org.apache.hadoop.hbase.client.Connection;
import org.apache.hadoop.hbase.client.ConnectionFactory;
import org.apache.hadoop.hbase.client.Get;
import org.apache.hadoop.hbase.client.Result;
import org.apache.hadoop.hbase.client.ResultScanner;
import org.apache.hadoop.hbase.client.Scan;
import org.apache.hadoop.hbase.client.Table;
import org.apache.hadoop.hbase.filter.PageFilter;
import org.apache.hadoop.hbase.util.Bytes;
import org.apache.hadoop.security.UserGroupInformation;

public final class BigdataClientService implements AutoCloseable {
  private final String token;
  private final long requestTimeoutMs;
  private final long listCacheMs;
  private final FileSystem hdfs;
  private final Connection hbase;
  private final HttpServer server;
  private final ExecutorService operations = Executors.newCachedThreadPool();
  private final ScheduledExecutorService maintenance = Executors.newSingleThreadScheduledExecutor();
  private final ConcurrentHashMap<String, Future<?>> inflight = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, CacheEntry> listCache = new ConcurrentHashMap<>();

  private static final class CacheEntry {
    final long createdAt; final Map<String, Object> value;
    CacheEntry(long createdAt, Map<String, Object> value) { this.createdAt = createdAt; this.value = value; }
  }
  private static final class ClientRequestException extends RuntimeException {
    final int status; final String code;
    ClientRequestException(int status, String code, String message) { super(message); this.status = status; this.code = code; }
  }

  private BigdataClientService() throws Exception {
    token = required("SERVICE_TOKEN");
    requestTimeoutMs = envLong("REQUEST_TIMEOUT_MS", 120000L);
    listCacheMs = envLong("LIST_CACHE_MS", 30000L);
    String krb5 = env("KRB5_CONF", ""); if (!krb5.trim().isEmpty()) System.setProperty("java.security.krb5.conf", krb5);

    Configuration base = new Configuration(false);
    addResource(base, "CORE_SITE"); addResource(base, "HDFS_SITE");
    UserGroupInformation.setConfiguration(base);
    String principal = env("KERBEROS_PRINCIPAL", ""); String keytab = env("KERBEROS_KEYTAB", "");
    if (!principal.trim().isEmpty() || !keytab.trim().isEmpty()) {
      if (principal.trim().isEmpty() || keytab.trim().isEmpty()) throw new IllegalArgumentException("KERBEROS_PRINCIPAL and KERBEROS_KEYTAB must be configured together");
      UserGroupInformation.loginUserFromKeytab(principal, keytab);
    }
    hdfs = FileSystem.get(base);
    Configuration hbaseConf = HBaseConfiguration.create(base); addResource(hbaseConf, "HBASE_SITE");
    hbase = ConnectionFactory.createConnection(hbaseConf);

    String bind = env("CLIENT_BIND", "127.0.0.1");
    InetAddress address = InetAddress.getByName(bind);
    if (!address.isLoopbackAddress()) throw new IllegalArgumentException("CLIENT_BIND must be a loopback address");
    server = HttpServer.create(new InetSocketAddress(address, (int) envLong("CLIENT_PORT", 17880L)), 0);
    server.createContext("/", this::handle);
    server.setExecutor(Executors.newCachedThreadPool());
    maintenance.scheduleAtFixedRate(() -> { try { UserGroupInformation.getLoginUser().checkTGTAndReloginFromKeytab(); } catch (Exception error) { metric("kerberos-renew", 0, "failed", 0); } }, 60, 60, TimeUnit.SECONDS);
  }

  public static void main(String[] args) throws Exception {
    BigdataClientService service = new BigdataClientService();
    Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { service.close(); } catch (Exception ignored) {} }));
    service.server.start();
    System.out.println("HDFS/HBase client service listening on loopback:" + service.server.getAddress().getPort());
  }

  private void handle(HttpExchange exchange) throws IOException {
    long started = System.nanoTime(); String route = exchange.getRequestURI().getPath(); int size = 0; String outcome = "ok";
    try {
      if (!Objects.equals(exchange.getRequestHeaders().getFirst("Authorization"), "Bearer " + token)) { sendError(exchange, 401, "AUTH_FAILED", "认证失败"); outcome = "auth"; return; }
      if (route.equals("/health") && exchange.getRequestMethod().equals("GET")) { sendJson(exchange, 200, map("status", "ok", "mode", "client", "readAt", Instant.now().toString())); return; }
      Map<String, String> params = parameters(exchange);
      if (route.equals("/v1/requests/cancel")) { Future<?> task = inflight.remove(params.get("id")); boolean cancelled = task != null && task.cancel(true); sendJson(exchange, 200, map("cancelled", cancelled)); return; }
      String requestId = exchange.getRequestHeaders().getFirst("X-Request-Id"); if (requestId == null || requestId.trim().isEmpty()) requestId = Long.toHexString(System.nanoTime());
      final String activeId = requestId; final Map<String, String> activeParams = params; final String activeRoute = route;
      Callable<Map<String, Object>> action = () -> dispatch(activeRoute, activeParams, exchange);
      Future<Map<String, Object>> future = operations.submit(action); inflight.put(activeId, future);
      try {
        long timeout = Math.min(requestTimeoutMs, parseLong(exchange.getRequestHeaders().getFirst("X-Request-Timeout-Ms"), requestTimeoutMs));
        Map<String, Object> result = future.get(Math.max(1000L, timeout), TimeUnit.MILLISECONDS);
        if (!route.equals("/v1/hdfs/download")) { size = result.get("items") instanceof List ? ((List<?>) result.get("items")).size() : result.get("rows") instanceof List ? ((List<?>) result.get("rows")).size() : 0; sendJson(exchange, 200, result); }
      } catch (TimeoutException error) { future.cancel(true); outcome = "timeout"; sendError(exchange, 504, "TIMEOUT", "读取超时"); }
      catch (ExecutionException error) {
        Throwable cause = error.getCause();
        if (cause instanceof ClientRequestException) throw (ClientRequestException) cause;
        if (cause instanceof IllegalArgumentException) throw (IllegalArgumentException) cause;
        if (cause instanceof Exception) throw (Exception) cause;
        throw error;
      }
      finally { inflight.remove(activeId, future); }
    } catch (ClientRequestException error) { outcome = "rejected"; sendError(exchange, error.status, error.code, error.getMessage()); }
    catch (IllegalArgumentException error) { outcome = "invalid"; sendError(exchange, 400, "INVALID_INPUT", error.getMessage()); }
    catch (Exception error) { outcome = "failed"; sendError(exchange, 502, "CLUSTER_READ_FAILED", safeMessage(error)); }
    finally { metric(route, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), outcome, size); exchange.close(); }
  }

  private Map<String, Object> dispatch(String route, Map<String, String> params, HttpExchange exchange) throws Exception {
    switch (route) {
      case "/v1/hdfs/list": return hdfsList(required(params, "path"));
      case "/v1/hdfs/preview": return hdfsPreview(required(params, "path"), capped(params.get("maxBytes"), 262144, 1, 262144));
      case "/v1/hdfs/download": hdfsDownload(required(params, "path"), exchange); return map("streamed", true);
      case "/v1/hdfs/upload": return hdfsUpload(required(params, "localPath"), required(params, "hdfsDir"));
      case "/v1/hdfs/delete": return hdfsDelete(required(params, "path"), required(params, "kind"));
      case "/v1/hbase/list": return hbaseList(required(params, "path"), Boolean.parseBoolean(params.getOrDefault("refresh", "false")));
      case "/v1/hbase/scan": return hbaseScan(required(params, "path"), capped(params.get("limit"), 20, 1, 200));
      case "/v1/hbase/get": return hbaseGet(required(params, "path"), required(params, "rowKey"));
      default: throw new IllegalArgumentException("接口不存在");
    }
  }

  private Map<String, Object> hdfsList(String rawPath) throws IOException {
    long started = System.nanoTime(); Path path = absolutePath(rawPath); List<Object> items = new ArrayList<>();
    for (FileStatus status : hdfs.listStatus(path)) items.add(map("name", status.getPath().getName(), "path", status.getPath().toUri().getPath(), "isDir", status.isDirectory(), "perms", status.getPermission().toString(), "owner", status.getOwner(), "group", status.getGroup(), "size", Long.toString(status.getLen()), "mtime", Instant.ofEpochMilli(status.getModificationTime()).toString()));
    items.sort((a, b) -> String.valueOf(((Map<?, ?>) a).get("name")).compareToIgnoreCase(String.valueOf(((Map<?, ?>) b).get("name"))));
    return withMeta(map("path", rawPath, "items", items, "cached", false), started);
  }

  private Map<String, Object> hdfsPreview(String rawPath, int maxBytes) throws IOException {
    long started = System.nanoTime(); Path path = absolutePath(rawPath); FileStatus status = hdfs.getFileStatus(path); if (!status.isFile()) throw new IllegalArgumentException("HDFS 预览目标不是普通文件");
    byte[] buffer = new byte[maxBytes + 1]; int total = 0;
    try (FSDataInputStream input = hdfs.open(path)) { while (total < buffer.length) { int read = input.read(buffer, total, buffer.length - total); if (read < 0) break; total += read; } }
    int shown = Math.min(total, maxBytes); return withMeta(map("base64", Base64.getEncoder().encodeToString(java.util.Arrays.copyOf(buffer, shown)), "size", Integer.toString(shown), "truncated", total > maxBytes || status.getLen() > shown, "cached", false), started);
  }

  private void hdfsDownload(String rawPath, HttpExchange exchange) throws IOException {
    Path path = absolutePath(rawPath); FileStatus status = hdfs.getFileStatus(path); if (!status.isFile()) throw new IllegalArgumentException("HDFS 下载目标不是普通文件");
    exchange.getResponseHeaders().set("Content-Type", "application/octet-stream"); exchange.sendResponseHeaders(200, status.getLen());
    try (FSDataInputStream input = hdfs.open(path); OutputStream output = exchange.getResponseBody()) { copy(input, output); }
  }

  private Map<String, Object> hdfsUpload(String localPath, String rawDir) throws IOException {
    long started = System.nanoTime();
    java.nio.file.Path local = java.nio.file.Paths.get(localPath).normalize();
    if (!java.nio.file.Files.isRegularFile(local)) throw new ClientRequestException(404, "HDFS_LOCAL_FILE_NOT_FOUND", "服务器文件不存在或不是普通文件：" + localPath);
    Path dir = absolutePath(rawDir); FileStatus dirStatus;
    try { dirStatus = hdfs.getFileStatus(dir); }
    catch (java.io.FileNotFoundException error) { throw new ClientRequestException(404, "HDFS_PATH_NOT_FOUND", "HDFS 目标目录不存在：" + rawDir); }
    if (!dirStatus.isDirectory()) throw new ClientRequestException(400, "HDFS_TARGET_NOT_DIRECTORY", "HDFS 上传目标不是目录：" + rawDir);
    Path target = new Path(dir, local.getFileName().toString());
    if (hdfs.exists(target)) throw new ClientRequestException(409, "HDFS_TARGET_EXISTS", "HDFS 目标已存在同名文件：" + target.toUri().getPath());
    hdfs.copyFromLocalFile(false, false, new Path(local.toString()), target);
    return withMeta(map("localPath", localPath, "fileName", local.getFileName().toString(), "hdfsDir", dir.toUri().getPath(), "hdfsPath", target.toUri().getPath(), "cached", false), started);
  }

  private Map<String, Object> hdfsDelete(String rawPath, String kind) throws IOException {
    long started = System.nanoTime(); Path path = absolutePath(rawPath);
    if ("/".equals(path.toUri().getPath())) throw new ClientRequestException(400, "HDFS_ROOT_DELETE_BLOCKED", "HDFS 根目录不允许删除");
    if (!kind.equals("file") && !kind.equals("dir")) throw new ClientRequestException(400, "INVALID_INPUT", "kind 必须是 file 或 dir");
    FileStatus status;
    try { status = hdfs.getFileStatus(path); }
    catch (java.io.FileNotFoundException error) { throw new ClientRequestException(404, "HDFS_PATH_NOT_FOUND", "HDFS 上不存在该路径：" + rawPath); }
    if (kind.equals("file") && !status.isFile()) throw new ClientRequestException(400, "HDFS_TYPE_MISMATCH", "HDFS 删除目标不是普通文件：" + rawPath);
    if (kind.equals("dir") && !status.isDirectory()) throw new ClientRequestException(400, "HDFS_TYPE_MISMATCH", "HDFS 删除目标不是目录：" + rawPath);
    try {
      if (!hdfs.delete(path, false)) throw new ClientRequestException(409, "HDFS_DIRECTORY_NOT_EMPTY", "HDFS 目录非空，只允许删除空目录：" + rawPath);
    } catch (org.apache.hadoop.fs.PathIsNotEmptyDirectoryException error) {
      throw new ClientRequestException(409, "HDFS_DIRECTORY_NOT_EMPTY", "HDFS 目录非空，只允许删除空目录：" + rawPath);
    } catch (IOException error) {
      String message = safeMessage(error);
      if (message.contains("Directory is not empty") || message.contains("PathIsNotEmptyDirectoryException")) throw new ClientRequestException(409, "HDFS_DIRECTORY_NOT_EMPTY", "HDFS 目录非空，只允许删除空目录：" + rawPath);
      throw error;
    }
    return withMeta(map("path", path.toUri().getPath(), "kind", kind, "deleted", true, "cached", false), started);
  }

  private Map<String, Object> hbaseList(String rawPath, boolean refresh) throws IOException {
    String path = rawPath == null || rawPath.trim().isEmpty() ? "/" : rawPath; if (!path.equals("/") && !path.matches("^/[A-Za-z0-9_][A-Za-z0-9_.-]*$")) throw new IllegalArgumentException("HBase 路径格式应为 / 或 /namespace");
    CacheEntry cached = listCache.get(path); long now = System.currentTimeMillis();
    if (!refresh && cached != null && now - cached.createdAt < listCacheMs) { Map<String, Object> hit = new LinkedHashMap<>(cached.value); hit.put("cached", true); hit.put("readAt", Instant.ofEpochMilli(cached.createdAt).toString()); hit.put("durationMs", 0); return hit; }
    long started = System.nanoTime(); List<Object> items = new ArrayList<>();
    try (Admin admin = hbase.getAdmin()) {
      if (path.equals("/")) { for (NamespaceDescriptor ns : admin.listNamespaceDescriptors()) items.add(map("name", ns.getName(), "isDir", true, "path", "/" + ns.getName(), "mtime", "")); }
      else { String ns = path.substring(1); for (TableName table : admin.listTableNamesByNamespace(ns)) items.add(map("name", table.getQualifierAsString(), "isDir", false, "path", "/" + table.getNameAsString(), "mtime", "")); }
    }
    Map<String, Object> result = withMeta(map("path", path, "items", items, "cached", false), started); listCache.put(path, new CacheEntry(now, new LinkedHashMap<>(result))); return result;
  }

  private Map<String, Object> hbaseScan(String rawPath, int limit) throws IOException {
    TableName name = tableName(rawPath); long started = System.nanoTime(); List<Result> results = new ArrayList<>();
    Scan scan = new Scan(); scan.setFilter(new PageFilter(limit)); scan.setCaching(Math.min(limit, 50));
    try (Table table = hbase.getTable(name); ResultScanner scanner = table.getScanner(scan)) { for (Result result : scanner) { if (Thread.currentThread().isInterrupted() || results.size() >= limit) break; results.add(result); } }
    return hbaseResult(name, results, limit, "scan", started);
  }

  private Map<String, Object> hbaseGet(String rawPath, String rowKey) throws IOException {
    TableName name = tableName(rawPath); long started = System.nanoTime(); Result result;
    try (Table table = hbase.getTable(name)) { result = table.get(new Get(Bytes.toBytes(rowKey))); }
    List<Result> results = new ArrayList<>(); if (!result.isEmpty()) results.add(result); return hbaseResult(name, results, 1, "get", started);
  }

  private Map<String, Object> hbaseResult(TableName table, List<Result> results, int limit, String operation, long started) {
    List<Object> rows = new ArrayList<>(); StringBuilder text = new StringBuilder(operation).append(" '").append(table.getNameAsString()).append("'\nROW COLUMN+CELL\n");
    for (Result result : results) {
      String rowKey = Bytes.toStringBinary(result.getRow()); List<Object> cells = new ArrayList<>();
      for (Cell cell : result.rawCells()) {
        String family = Bytes.toStringBinary(CellUtil.cloneFamily(cell)); String qualifier = Bytes.toStringBinary(CellUtil.cloneQualifier(cell)); byte[] valueBytes = CellUtil.cloneValue(cell); String value = value(valueBytes);
        cells.add(map("family", family, "qualifier", qualifier, "timestamp", Long.toString(cell.getTimestamp()), "value", value, "encoding", value.startsWith("base64:") ? "base64" : "utf8"));
        text.append(rowKey).append(" column=").append(family).append(':').append(qualifier).append(", timestamp=").append(cell.getTimestamp()).append(", value=").append(value).append('\n');
      }
      rows.add(map("rowKey", rowKey, "cells", cells));
    }
    text.append(results.size()).append(" row(s)");
    return withMeta(map("table", table.getNameAsString(), "limit", limit, "rows", rows, "rowCount", results.size(), "text", text.toString(), "truncated", operation.equals("scan") && results.size() >= limit, "cached", false), started);
  }

  private static String value(byte[] bytes) {
    try { String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); for (int i = 0; i < text.length(); i++) { char c = text.charAt(i); if (Character.isISOControl(c) && !Character.isWhitespace(c)) return "base64:" + Base64.getEncoder().encodeToString(bytes); } return text; }
    catch (CharacterCodingException error) { return "base64:" + Base64.getEncoder().encodeToString(bytes); }
  }

  private static Map<String, Object> withMeta(Map<String, Object> result, long started) { result.put("readAt", Instant.now().toString()); result.put("durationMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)); return result; }
  private static Path absolutePath(String value) { if (value == null || !value.startsWith("/")) throw new IllegalArgumentException("HDFS 路径必须以 / 开头"); return new Path(value); }
  private static TableName tableName(String path) { String clean = path == null ? "" : path.replaceFirst("^/+", ""); if (!clean.matches("[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*")) throw new IllegalArgumentException("扫描表路径格式应为 /namespace:table"); return TableName.valueOf(clean); }
  private static int capped(String value, int fallback, int min, int max) { int parsed; try { parsed = Integer.parseInt(value == null ? "" : value); } catch (Exception error) { parsed = fallback; } return Math.min(Math.max(parsed, min), max); }
  private static long parseLong(String value, long fallback) { try { return Long.parseLong(value); } catch (Exception error) { return fallback; } }
  private static String required(Map<String, String> values, String key) { String value = values.get(key); if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(key + " 不能为空"); return value; }
  private static String required(String key) { String value = System.getenv(key); if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(key + " is required"); return value; }
  private static String env(String key, String fallback) { String value = System.getenv(key); return value == null ? fallback : value; }
  private static long envLong(String key, long fallback) { return parseLong(System.getenv(key), fallback); }
  private static void addResource(Configuration conf, String envName) { String value = env(envName, ""); if (!value.trim().isEmpty()) conf.addResource(new Path(value)); }
  private static Map<String, String> parameters(HttpExchange exchange) throws IOException { Map<String, String> result = new LinkedHashMap<>(); parseParameters(exchange.getRequestURI().getRawQuery(), result); if (!exchange.getRequestMethod().equals("GET")) parseParameters(new String(readAll(exchange.getRequestBody(), 1024 * 1024), StandardCharsets.UTF_8), result); return result; }
  private static void parseParameters(String raw, Map<String, String> result) { if (raw == null || raw.trim().isEmpty()) return; for (String pair : raw.split("&")) { int split = pair.indexOf('='); String key = split < 0 ? pair : pair.substring(0, split); String value = split < 0 ? "" : pair.substring(split + 1); result.put(decodeForm(key), decodeForm(value)); } }
  private static String decodeForm(String value) { try { return URLDecoder.decode(value, "UTF-8"); } catch (java.io.UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); } }
  private static byte[] readAll(InputStream input, int maxBytes) throws IOException { ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int read; while ((read = input.read(buffer)) >= 0) { if (output.size() + read > maxBytes) throw new IllegalArgumentException("请求体过大"); output.write(buffer, 0, read); } return output.toByteArray(); }
  private static void copy(InputStream input, OutputStream output) throws IOException { byte[] buffer = new byte[64 * 1024]; int read; while (!Thread.currentThread().isInterrupted() && (read = input.read(buffer)) >= 0) output.write(buffer, 0, read); }
  private static String safeMessage(Throwable error) { Throwable current = error; while (current.getCause() != null) current = current.getCause(); String value = current.getMessage(); return value == null || value.trim().isEmpty() ? current.getClass().getSimpleName() : value; }
  private static void sendError(HttpExchange exchange, int status, String code, String message) throws IOException { sendJson(exchange, status, map("ok", false, "error", map("code", code, "message", message))); }
  private static void sendJson(HttpExchange exchange, int status, Map<String, Object> value) throws IOException { byte[] bytes = json(value).getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8"); exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(status, bytes.length); try (OutputStream output = exchange.getResponseBody()) { output.write(bytes); } }
  private static void metric(String route, long durationMs, String outcome, int size) { System.out.println("metric route=" + route + " durationMs=" + durationMs + " outcome=" + outcome + " size=" + size); }

  private static Map<String, Object> map(Object... entries) { Map<String, Object> result = new LinkedHashMap<>(); for (int i = 0; i < entries.length; i += 2) result.put(String.valueOf(entries[i]), entries[i + 1]); return result; }
  private static String json(Object value) {
    if (value == null) return "null"; if (value instanceof Boolean || value instanceof Number) return String.valueOf(value);
    if (value instanceof Map) { StringBuilder out = new StringBuilder("{"); boolean first = true; for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) { if (!first) out.append(','); first = false; out.append(json(String.valueOf(entry.getKey()))).append(':').append(json(entry.getValue())); } return out.append('}').toString(); }
    if (value instanceof Iterable) { StringBuilder out = new StringBuilder("["); boolean first = true; for (Object item : (Iterable<?>) value) { if (!first) out.append(','); first = false; out.append(json(item)); } return out.append(']').toString(); }
    String text = String.valueOf(value); StringBuilder out = new StringBuilder("\""); for (int i = 0; i < text.length(); i++) { char c = text.charAt(i); switch (c) { case '\\': out.append("\\\\"); break; case '"': out.append("\\\""); break; case '\n': out.append("\\n"); break; case '\r': out.append("\\r"); break; case '\t': out.append("\\t"); break; default: if (c < 32) out.append(String.format("\\u%04x", (int) c)); else out.append(c); } } return out.append('"').toString();
  }

  @Override public void close() throws Exception { server.stop(1); maintenance.shutdownNow(); operations.shutdownNow(); hbase.close(); hdfs.close(); }
}
