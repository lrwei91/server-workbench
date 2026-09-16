'use strict';

const iconv = require('iconv-lite');

const BUSINESS_TEXT_FIELDS = new Set([
  'ACCT_NAME', 'prod_name', 'alias_name', 'prod_desc',
  'offer_name', 'inner_offer_name', 'offer_desc', 'pricing_plan_name',
]);

function repairUtf8AsGbk(value) {
  if (typeof value !== 'string' || !/[\u3400-\u9fff]/u.test(value)) return value;
  try {
    const repaired = iconv.decode(iconv.encode(value, 'gb18030'), 'utf8');
    if (!repaired || repaired === value || repaired.includes('\ufffd') || repaired.length >= value.length) return value;
    const roundTrip = iconv.decode(Buffer.from(repaired, 'utf8'), 'gb18030');
    return roundTrip === value ? repaired : value;
  } catch (_) { return value; }
}

function repairBusinessText(rows) {
  return rows.map((row) => {
    const next = { ...row };
    for (const field of BUSINESS_TEXT_FIELDS) {
      if (!(field in next)) continue;
      const repaired = repairUtf8AsGbk(next[field]);
      if (repaired !== next[field]) { next[`${field}_原始值`] = next[field]; next[field] = repaired; }
    }
    return next;
  });
}

module.exports = { BUSINESS_TEXT_FIELDS, repairUtf8AsGbk, repairBusinessText };
