'use strict';

const { randomUUID } = require('crypto');
const { RedisArchiveError, decompressLz4Block, DEFAULT_MAX_DECODED_BYTES } = require('./redis-archive');

function canonicalNumber(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(text));
  if (!match) return null;
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, '');
  let scale = (match[3] || '').length - exponent;
  if (!digits) return '0';
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  return `${match[1]}${digits}e${-scale}`;
}

// 不经过 Number 的大整数解析；回写时仍为 JSON 数字而非字符串。
function parseLosslessJson(text) {
  const marker = `__integer_${randomUUID()}_`;
  const integers = [];
  let output = '', index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index++] === '"') break;
      }
      output += text.slice(start, index);
    } else {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (match) {
        const token = match[0];
        if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
          output += JSON.stringify(`${marker}${integers.length}`); integers.push(BigInt(token));
        } else {
          if (!Number.isFinite(Number(token)) || canonicalNumber(token) !== canonicalNumber(JSON.stringify(Number(token)))) throw new RedisArchiveError(409, 'ARCHIVE_NUMBER_PRECISION', '档案存在超精度 JSON 数字，请核对序列化规则');
          output += token;
        }
        index += token.length;
      } else output += text[index++];
    }
  }
  return JSON.parse(output, (_, value) => typeof value === 'string' && value.startsWith(marker) ? integers[Number(value.slice(marker.length))] : value);
}

function stringifyLosslessJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Object.is(value, -0)) return '-0';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringifyLosslessJson).join(',')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${stringifyLosslessJson(item)}`).join(',')}}`;
}

// Kryo String: class 标识 03 + 带 UTF8 flag 的字符数 varint（Java UTF-16 长度 + 1）。
// 样本中的 03ca9f23 不是固定魔数，后面的长度必须随 JSON 内容更新。
function kryoHeader(characterCount) {
  let remaining = characterCount;
  const bytes = [3, (remaining & 63) | 128 | (remaining >= 64 ? 64 : 0)]; remaining >>>= 6;
  while (remaining) { bytes.push((remaining & 127) | (remaining >= 128 ? 128 : 0)); remaining >>>= 7; }
  return Buffer.from(bytes);
}

function readKryoHeader(decoded) {
  if (decoded[0] !== 3 || !(decoded[1] & 128)) return null;
  let length = decoded[1] & 63, offset = 2, shift = 6;
  if (decoded[1] & 64) {
    let byte;
    do {
      if (offset >= decoded.length || shift > 27) throw new RedisArchiveError(502, 'ARCHIVE_ENVELOPE', 'Kryo 字符长度头格式错误');
      byte = decoded[offset++]; length += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
  }
  return { length, offset };
}

function decodeJavaUtf8(bytes) {
  const characters = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]; let character;
    if (first < 128) character = first;
    else if ((first & 224) === 192) {
      const second = bytes[index++];
      if ((second & 192) !== 128) throw new RedisArchiveError(502, 'ARCHIVE_ENVELOPE', 'Kryo UTF8 字节格式错误');
      character = ((first & 31) << 6) | (second & 63);
    } else if ((first & 240) === 224) {
      const second = bytes[index++], third = bytes[index++];
      if ((second & 192) !== 128 || (third & 192) !== 128) throw new RedisArchiveError(502, 'ARCHIVE_ENVELOPE', 'Kryo UTF8 字节格式错误');
      character = ((first & 15) << 12) | ((second & 63) << 6) | (third & 63);
    } else throw new RedisArchiveError(502, 'ARCHIVE_ENVELOPE', 'Kryo UTF8 编码需要核对');
    characters.push(character);
  }
  const chunks = [];
  for (let index = 0; index < characters.length; index += 4096) chunks.push(String.fromCharCode(...characters.slice(index, index + 4096)));
  return chunks.join('');
}

function encodeJavaUtf8(text) {
  const bytes = Buffer.alloc(text.length * 3); let offset = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    if (character <= 127) bytes[offset++] = character;
    else if (character <= 2047) { bytes[offset++] = 192 | (character >> 6); bytes[offset++] = 128 | (character & 63); }
    else { bytes[offset++] = 224 | (character >> 12); bytes[offset++] = 128 | ((character >> 6) & 63); bytes[offset++] = 128 | (character & 63); }
  }
  return bytes.subarray(0, offset);
}

function decodeArchive(raw, maxBytes = DEFAULT_MAX_DECODED_BYTES) {
  if (!Buffer.isBuffer(raw) || raw.length < 5) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'Redis 档案值过短');
  const length = raw.readUInt32BE(0);
  if (length < 5 || length > maxBytes) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'Redis 档案解压长度超限');
  const decoded = decompressLz4Block(raw.subarray(4), length);
  const header = readKryoHeader(decoded);
  if (!header) throw new RedisArchiveError(409, 'ARCHIVE_ENVELOPE', '档案序列化头尚未匹配 Kryo String 规则');
  const text = decodeJavaUtf8(decoded.subarray(header.offset));
  if (text.length + 1 !== header.length) throw new RedisArchiveError(502, 'ARCHIVE_ENVELOPE', 'Kryo 字符长度与 JSON 内容不一致');
  const data = parseLosslessJson(text);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', '档案顶层应为对象');
  return { data, prefix: Buffer.from(decoded.subarray(0, header.offset)), decodedBytes: length, framing: 'kryo-string' };
}

function lz4Length(length) {
  const bytes = [];
  while (length >= 255) { bytes.push(255); length -= 255; }
  bytes.push(length);
  return Buffer.from(bytes);
}

// raw LZ4 block；保持末尾至少 5 个 literal、最后 match 起点距末尾至少 12 字节。
function compressLz4Block(input) {
  const dictionary = new Int32Array(65536); dictionary.fill(-1);
  const chunks = []; let anchor = 0, index = 0;
  const slot = (position) => Math.imul(input.readUInt32LE(position), 2654435761) >>> 16;
  while (index <= input.length - 12) {
    const location = slot(index), reference = dictionary[location]; dictionary[location] = index;
    if (reference < 0 || index - reference > 65535 || input.readUInt32LE(reference) !== input.readUInt32LE(index)) { index += 1; continue; }
    let match = 4;
    while (index + match < input.length - 5 && input[reference + match] === input[index + match]) match += 1;
    const literal = index - anchor, matchCode = match - 4;
    chunks.push(Buffer.from([(Math.min(literal, 15) << 4) | Math.min(matchCode, 15)]));
    if (literal >= 15) chunks.push(lz4Length(literal - 15));
    chunks.push(input.subarray(anchor, index));
    const offset = Buffer.alloc(2); offset.writeUInt16LE(index - reference); chunks.push(offset);
    if (matchCode >= 15) chunks.push(lz4Length(matchCode - 15));
    index += match; anchor = index;
    if (index - 2 >= 0 && index + 2 <= input.length) dictionary[slot(index - 2)] = index - 2;
  }
  const literal = input.length - anchor;
  chunks.push(Buffer.from([Math.min(literal, 15) << 4]));
  if (literal >= 15) chunks.push(lz4Length(literal - 15));
  chunks.push(input.subarray(anchor));
  return Buffer.concat(chunks);
}

function encodeArchive(data, prefix, maxBytes = DEFAULT_MAX_DECODED_BYTES) {
  if (prefix[0] !== 3) throw new RedisArchiveError(409, 'ARCHIVE_ENVELOPE', '档案序列化类型标识需要核对');
  const text = stringifyLosslessJson(data);
  const decoded = Buffer.concat([kryoHeader(text.length + 1), encodeJavaUtf8(text)]);
  if (decoded.length > maxBytes) throw new RedisArchiveError(413, 'ARCHIVE_TOO_LARGE', '生成档案超过解压长度限制');
  const header = Buffer.alloc(4); header.writeUInt32BE(decoded.length);
  return Buffer.concat([header, compressLz4Block(decoded)]);
}

module.exports = { parseLosslessJson, stringifyLosslessJson, decodeArchive, encodeArchive, canonicalNumber, kryoHeader, readKryoHeader, compressLz4Block };
