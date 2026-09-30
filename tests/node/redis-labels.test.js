'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/redis-labels.js'), 'utf8');
const labels = import(`data:text/javascript,${encodeURIComponent(source)}`);

test('Redis CPP group names retain source keys and add Chinese meanings', async () => {
  const { redisArchiveLabel } = await labels;
  assert.equal(redisArchiveLabel('offerInstsSecondStep', 1), 'offerInstsSecondStep · 销售品实例（第二步）');
  assert.equal(redisArchiveLabel('offerProdInstRelsSecondStep', 1), 'offerProdInstRelsSecondStep · 销售品实例与产品实例关系（第二步）');
  assert.equal(redisArchiveLabel('prodInsts', 1), 'prodInsts · 产品实例');
  assert.equal(redisArchiveLabel('accounts', 1), 'accounts · 账户');
  assert.equal(redisArchiveLabel('0', 2), '0');
});

test('all observed fields in CPP archive 125424 have Chinese labels', async () => {
  const { REDIS_FIELD_NAMES, redisArchiveLabel } = await labels;
  const fields = 'accNbr account accountAreaGrade accountId acctItemTypeGroupId areaCode areaId attrId attrValue attrValueId beginRentTime chargePrio chargeType commonRegionId createDate custId dcsIbsOfferType dcsIbsProdType dcsStatusCd defAcctFlag effDate executetime expDate hisId messageStoreTime offerProdInstRelId offerSubType ownerCustId parentProdInstId payCycle payPrio paymentLimit paymentLimitType paymentModeCd priority prodInstAId prodInstAcctId prodInstAttrId prodInstId prodInstRelId prodInstZId prodOfferId prodOfferInstAttrId prodOfferInstId prodOfferInstRelId productId productType recUpdateDate regionCd regionCode relaProdOfferInstId relatedProdOfferInstId relationTypeCd roleCd shardingId statusDate stopRentTime trialEffDate trialExpDate updateDate yzfAccount'.split(' ');
  for (const field of fields) {
    assert.ok(REDIS_FIELD_NAMES[field], `missing ${field}`);
    assert.equal(redisArchiveLabel(field, 3), `${field} · ${REDIS_FIELD_NAMES[field]}`);
  }
  assert.equal(redisArchiveLabel('newField', 3), 'newField · 待确认字段含义');
});

test('Redis time fields retain millisecond values and append Beijing time', async () => {
  const { redisTimestampText } = await labels;
  assert.equal(redisTimestampText(1747703072000, 'statusDate'), '1747703072000（2025-05-20 09:04:32 +08:00）');
  assert.equal(redisTimestampText(-28800000, 'trialEffDate'), '-28800000（1970-01-01 00:00:00 +08:00）');
  assert.equal(redisTimestampText(7226553600000, 'expDate'), '7226553600000（2199-01-01 00:00:00 +08:00）');
  assert.equal(redisTimestampText(1747703072000, 'prodOfferInstId'), null);
  assert.equal(redisTimestampText('not-a-date', 'statusDate'), null);
  assert.equal(redisTimestampText('9007199254740993', 'statusDate'), null);
});
